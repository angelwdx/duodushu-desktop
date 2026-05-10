from __future__ import annotations

import argparse
import gzip
import json
import sqlite3
import tempfile
import urllib.request
import xml.etree.ElementTree as ET
import zlib
from pathlib import Path

SOURCE_URL = "https://www.edrdg.org/pub/Nihongo/JMdict_e.gz"
PROJECT_URL = "https://www.edrdg.org/wiki/index.php/JMdict-EDICT_Dictionary_Project"
LICENSE_URL = "https://www.edrdg.org/edrdg/licence.html"


def _priority_score(priorities: list[str]) -> int:
    score = 0
    for priority in priorities:
        if priority == "news1":
            score += 100
        elif priority == "ichi1":
            score += 95
        elif priority == "spec1":
            score += 90
        elif priority == "news2":
            score += 80
        elif priority == "ichi2":
            score += 75
        elif priority == "spec2":
            score += 70
        elif priority.startswith("nf"):
            try:
                score += max(0, 60 - int(priority[2:]))
            except ValueError:
                pass
    return score


def _sense_payload(sense: ET.Element) -> dict[str, object] | None:
    glosses = [
        gloss.text.strip()
        for gloss in sense.findall("gloss")
        if gloss.text and gloss.get("{http://www.w3.org/XML/1998/namespace}lang", "eng") == "eng"
    ]
    if not glosses:
        return None

    pos_values = [pos.text.strip() for pos in sense.findall("pos") if pos.text]
    misc_values = [misc.text.strip() for misc in sense.findall("misc") if misc.text]
    info_values = [info.text.strip() for info in sense.findall("s_inf") if info.text]

    sense_payload = {
        "part_of_speech": " / ".join(pos_values) if pos_values else "",
        "glosses": glosses[:3],
    }
    if misc_values:
        sense_payload["misc"] = misc_values[:2]
    if info_values:
        sense_payload["info"] = info_values[:1]
    return sense_payload


def _iter_entries(jmdict_path: Path):
    with gzip.open(jmdict_path, "rt", encoding="utf-8") as handle:
        context = ET.iterparse(handle, events=("end",))
        for _, elem in context:
            if elem.tag != "entry":
                continue
            yield elem
            elem.clear()


def build_database(source_path: Path, output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    if output_path.exists():
        output_path.unlink()

    conn = sqlite3.connect(output_path)
    conn.execute("PRAGMA journal_mode=OFF")
    conn.execute("PRAGMA synchronous=OFF")
    conn.execute("PRAGMA temp_store=MEMORY")
    cursor = conn.cursor()

    cursor.execute("CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    cursor.execute(
        """
        CREATE TABLE entries (
            entry_id INTEGER PRIMARY KEY,
            word TEXT NOT NULL,
            reading TEXT,
            summary TEXT,
            payload TEXT NOT NULL,
            rank INTEGER NOT NULL DEFAULT 0
        )
        """
    )
    cursor.execute(
        """
        CREATE TABLE terms (
            term TEXT NOT NULL,
            entry_id INTEGER NOT NULL,
            score INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (term, entry_id)
        )
        """
    )
    cursor.execute("CREATE INDEX idx_terms_term ON terms(term, score DESC)")

    entry_count = 0
    term_count = 0

    for entry in _iter_entries(source_path):
        kanji_forms = [node.text.strip() for node in entry.findall("./k_ele/keb") if node.text]
        reading_forms = [node.text.strip() for node in entry.findall("./r_ele/reb") if node.text]
        if not kanji_forms and not reading_forms:
            continue

        priorities = [node.text.strip() for node in entry.findall(".//ke_pri") if node.text]
        priorities.extend(node.text.strip() for node in entry.findall(".//re_pri") if node.text)

        senses: list[dict[str, object]] = []
        for sense in entry.findall("sense"):
            payload = _sense_payload(sense)
            if payload:
                senses.append(payload)
            if len(senses) >= 3:
                break

        if not senses:
            continue

        entry_id = int(entry.findtext("ent_seq", "0"))
        display_word = kanji_forms[0] if kanji_forms else reading_forms[0]
        reading = reading_forms[0] if reading_forms else display_word
        summary = str(senses[0]["glosses"][0])
        rank = _priority_score(priorities)
        payload = zlib.compress(json.dumps(
            {
                "kanji_forms": kanji_forms,
                "reading_forms": reading_forms,
                "senses": senses,
            },
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8"), level=9)

        cursor.execute(
            """
            INSERT INTO entries (entry_id, word, reading, summary, payload, rank)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (entry_id, display_word, reading, summary, payload, rank),
        )
        entry_count += 1

        for term in dict.fromkeys([*kanji_forms, *reading_forms]):
            term_score = rank + (5 if term == display_word else 0)
            cursor.execute(
                "INSERT INTO terms (term, entry_id, score) VALUES (?, ?, ?)",
                (term, entry_id, term_score),
            )
            term_count += 1

        if entry_count % 2000 == 0:
            conn.commit()

    cursor.executemany(
        "INSERT INTO metadata (key, value) VALUES (?, ?)",
        [
            ("entry_count", str(entry_count)),
            ("term_count", str(term_count)),
            ("source_url", SOURCE_URL),
            ("project_url", PROJECT_URL),
            ("license_url", LICENSE_URL),
        ],
    )
    conn.commit()
    conn.execute("VACUUM")
    conn.close()


def download_source(target_path: Path) -> Path:
    target_path.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(SOURCE_URL, timeout=120) as response, target_path.open("wb") as handle:
        handle.write(response.read())
    return target_path


def main() -> None:
    parser = argparse.ArgumentParser(description="构建内置 JMdict SQLite 数据库")
    parser.add_argument("--source", type=Path, default=None, help="本地 JMdict_e.gz 路径")
    parser.add_argument("--output", type=Path, required=True, help="输出 SQLite 路径")
    args = parser.parse_args()

    if args.source:
        source_path = args.source
    else:
        with tempfile.TemporaryDirectory() as tmp_dir:
            source_path = download_source(Path(tmp_dir) / "JMdict_e.gz")
            build_database(source_path, args.output)
            return

    build_database(source_path, args.output)


if __name__ == "__main__":
    main()
