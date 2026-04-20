"""
词典管理器
负责管理导入的 MDX 词典
"""

import sqlite3
import json
import shutil
import tempfile
from pathlib import Path
from typing import List, Dict, Optional
from datetime import datetime
import logging
import threading

logger = logging.getLogger(__name__)

from .mdx_parser import MDXParser


class DictManager:
    """词典管理器"""

    def __init__(self, dicts_dir: Optional[Path] = None):
        if dicts_dir is None:
            # 使用配置文件中的路径
            from ..config import DICTS_DIR, IMPORTED_DICTS_DIR, MDX_INDEX_DB_PATH

            dicts_dir = DICTS_DIR
            self.imported_dir = IMPORTED_DICTS_DIR
            self.index_db = MDX_INDEX_DB_PATH
            self.config_file = DICTS_DIR / "dicts_config.json"
        else:
            # 允许自定义路径（主要用于测试）
            self.imported_dir = dicts_dir / "imported"
            self.index_db = dicts_dir / "mdx_index.db"
            self.config_file = dicts_dir / "dicts_config.json"

        self.dicts_dir = dicts_dir
        self.imported_dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self.config = self._load_config()
        self._init_index_db()

    def _load_config(self) -> Dict:
        if self.config_file.exists():
            try:
                with open(self.config_file, "r", encoding="utf-8") as f:
                    return json.load(f)
            except (json.JSONDecodeError, OSError):
                pass

        default_config = {"dicts": {}, "priority": ["ECDICT"], "auto_index": True}
        self._save_config(default_config)
        return default_config

    def _save_config(self, config: Dict):
        # 使用临时文件 + 替换的方式确保原子性，防止保存过程中断导致配置损坏
        temp_file = self.config_file.with_suffix(".tmp")
        try:
            with open(temp_file, "w", encoding="utf-8") as f:
                json.dump(config, f, indent=2, ensure_ascii=False)
            import os
            os.replace(temp_file, self.config_file)
        except Exception as e:
            logger.error(f"保存词典配置失败: {e}")
            if temp_file.exists():
                temp_file.unlink()
        self.config = config

    def _init_index_db(self):
        if not self.index_db.exists():
            conn = sqlite3.connect(self.index_db)
            cursor = conn.cursor()

            cursor.execute("""
                CREATE TABLE dicts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL UNIQUE,
                    filename TEXT NOT NULL,
                    size INTEGER,
                    word_count INTEGER,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    is_active BOOLEAN DEFAULT 1
                )
            """)

            cursor.execute("""
                CREATE TABLE entries (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    dict_id INTEGER NOT NULL,
                    word TEXT NOT NULL,
                    word_lower TEXT NOT NULL,
                    offset INTEGER DEFAULT 0,
                    length INTEGER DEFAULT 0,
                    content TEXT,
                    FOREIGN KEY (dict_id) REFERENCES dicts(id)
                )
            """)

            cursor.execute("CREATE INDEX idx_entries_word ON entries(word_lower)")
            cursor.execute("CREATE INDEX idx_entries_dict ON entries(dict_id)")

            conn.commit()
            conn.close()
            logger.info("索引数据库初始化完成")
        else:
            # 兼容性检查：如果已存在但没有 content 列，则添加
            conn = sqlite3.connect(self.index_db)
            cursor = conn.cursor()
            cursor.execute("PRAGMA table_info(entries)")
            columns = [col[1] for col in cursor.fetchall()]
            if "content" not in columns:
                logger.info("正在迁移词典索引数据库：添加 content 列")
                try:
                    cursor.execute("ALTER TABLE entries ADD COLUMN content TEXT")
                    conn.commit()
                except Exception as e:
                    logger.error(f"迁移词典索引失败: {e}")
            conn.close()
            logger.info("索引数据库已就绪")

    def import_dict(self, mdx_file: Path, name: Optional[str] = None, progress_callback=None) -> Dict:
        # 强制从磁盘重载配置，防止内存缓存与实际文件不同步（例如手动删除或删除失败后的重试）
        self.config = self._load_config()
        
        dict_name = name or mdx_file.stem
        if dict_name in self.config["dicts"]:
            raise ValueError(f"词典 {dict_name} 已存在")

        logger.info(f"开始导入词典: {dict_name}")

        is_zip = mdx_file.suffix.lower() == ".zip"
        
        if is_zip:
             import zipfile
             # Extract to temp first to find MDX
             # Or just extract directly to imported_dir?
             # Better to extract all to specific folder or flatten?
             # Current design expects flat files in imported_dir with {dict_name}.mdx/mdd
             
             # Let's extract to a temp folder, find mdx, rename and move
             with tempfile.TemporaryDirectory() as tmp_dir:
                 tmp_path = Path(tmp_dir)
                 with zipfile.ZipFile(mdx_file, 'r') as zf:
                     zf.extractall(tmp_path)
                 
                 # Find MDX file (recurse if needed, but we expect flat or simple structure)
                 found_mdx = list(tmp_path.rglob("*.mdx"))
                 if not found_mdx:
                     raise ValueError("ZIP文件中未找到 .mdx 文件")
                 
                 # Pick the first one or the largest one?
                 # Let's pick the largest one assuming it's the main dict
                 src_mdx = max(found_mdx, key=lambda p: p.stat().st_size)
                 
                 # Move MDX
                 target_mdx = self.imported_dir / f"{dict_name}.mdx"
                 shutil.move(str(src_mdx), str(target_mdx))
                 
                 # Move related files (mdd, css, js, images)
                 # We should copy EVERYTHING from the same folder as MDX
                 src_dir = src_mdx.parent
                 
                 # Get source stem
                 src_stem = src_mdx.stem
                 
                 for file_path in src_dir.iterdir():
                     if file_path == src_mdx:
                         continue
                     
                     if file_path.is_file():
                         suffix = file_path.suffix.lower()
                         # Check if file shares stem with MDX (e.g. dict.css, dict.js)
                         if file_path.stem == src_stem:
                             target_file = self.imported_dir / f"{dict_name}{suffix}"
                             shutil.move(str(file_path), str(target_file))
                         elif suffix == ".mdd":
                              target_file = self.imported_dir / f"{dict_name}.mdd"
                              shutil.move(str(file_path), str(target_file))
                         else:
                              # Other assets - prefix with dict_name to avoid conflicts
                              target_file = self.imported_dir / f"{dict_name}_{file_path.name}"
                              if target_file.exists():
                                   logger.warning(f"File {file_path.name} already exists, skipping.")
                              else:
                                   shutil.move(str(file_path), str(target_file))

        else:
             # Regular MDX import
             target_mdx = self.imported_dir / f"{dict_name}.mdx"
             shutil.copy2(mdx_file, target_mdx)
    
             mdd_file = mdx_file.with_suffix(".mdd")
             if mdd_file.exists():
                target_mdd = self.imported_dir / f"{dict_name}.mdd"
                shutil.copy2(mdd_file, target_mdd)


        word_count = self._create_index(target_mdx, dict_name, progress_callback)

        # Index MDD if exists
        mdd_file = mdx_file.with_suffix(".mdd")
        if mdd_file.exists():
            target_mdd = self.imported_dir / f"{dict_name}.mdd"
            if not target_mdd.exists(): # copy if not already copied (should have been handled)
                 # Logic above copies it but let's be safe
                 pass 
            self._create_index(target_mdd, dict_name, is_mdd=True) # Helper to reuse index logic

        self.config["dicts"][dict_name] = {
            "name": dict_name,
            "filename": f"{dict_name}.mdx",
            "size": mdx_file.stat().st_size,
            "word_count": word_count,
            "imported_at": datetime.now().isoformat(),
            "is_active": True,
        }

        self.config["priority"].insert(0, dict_name)
        self._save_config(self.config)

        logger.info(f"词典导入完成: {dict_name}, 单词数: {word_count}")

        return {
            "name": dict_name,
            "word_count": word_count,
            "size": mdx_file.stat().st_size,
        }

    def _create_index(self, mdx_file: Path, dict_name: str, progress_callback=None, is_mdd: bool = False) -> int:
        parser = MDXParser(mdx_file)
        dict_id = self._get_or_create_dict_id(dict_name, mdx_file)

        word_count = 0
        conn = sqlite3.connect(self.index_db)
        cursor = conn.cursor()

        batch_size = 1000
        batch = []

        for entry in parser.parse():
            try:
                word_lower = entry["word"].lower()
                content = entry.get("content")
                
                # content 现在已经是被 MDXParser 解码后的字符串或 None
                batch.append((dict_id, entry["word"], word_lower, entry["offset"], entry["length"], content))

                if len(batch) >= batch_size:
                    cursor.executemany(
                        """
                        INSERT OR REPLACE INTO entries (dict_id, word, word_lower, offset, length, content)
                        VALUES (?, ?, ?, ?, ?, ?)
                    """,
                        batch,
                    )
                    conn.commit()
                    batch = []

                    if progress_callback:
                        progress_callback(word_count, word_count)
                
                word_count += 1
            except Exception as e:
                logger.error(f"跳过故障词条: {e}")
                continue

        if batch:
            cursor.executemany(
                """
                INSERT OR REPLACE INTO entries (dict_id, word, word_lower, offset, length, content)
                VALUES (?, ?, ?, ?, ?, ?)
            """,
                batch,
            )
            conn.commit()

        cursor.execute("UPDATE dicts SET word_count = ? WHERE name = ?", (word_count, dict_name))
        conn.commit()
        conn.close()

        logger.info(f"索引创建完成: {dict_name}, 单词数: {word_count}")
        return word_count

    def get_resource(self, dict_name: str, resource_path: str) -> Optional[bytes]:
        """Get resource content from MDD file"""
        if dict_name not in self.config["dicts"]:
            return None
            
        dict_info = self.config["dicts"][dict_name]
        mdd_filename = dict_info["filename"].replace(".mdx", ".mdd")
        mdd_path = self.imported_dir / mdd_filename
        
        if not mdd_path.exists():
            return None
            
        # Normalize path
        # MDD paths typically start with \ or / and utilize backslashes
        # resource_path usually comes from web url, e.g. /sound/a.wav
        
        # Ensure it starts with \ if not present (MDD convention varies, usually matches key in MDD)
        # We need to find the key in DB.
        
        # Trial 1: Exact match
        keys_to_try = [
            resource_path,
            "\\" + resource_path.lstrip("/\\"),
            "/" + resource_path.lstrip("/\\")
        ]
        
        conn = sqlite3.connect(self.index_db)
        cursor = conn.cursor()
        
        # Find dict_id
        cursor.execute("SELECT id FROM dicts WHERE name = ?", (dict_name,))
        row = cursor.fetchone()
        if not row:
            conn.close()
            return None
        dict_id = row[0]
        
        entry = None
        for key in keys_to_try:
            cursor.execute(
                "SELECT offset, length FROM entries WHERE dict_id = ? AND word_lower = ? LIMIT 1", 
                (dict_id, key.lower())
            )
            entry = cursor.fetchone()
            if entry:
                break
        
        conn.close()
        
        if entry:
            offset, length = entry
            
            # 使用新的 MDXParser 提供的资源提取方法
            parser = MDXParser(mdd_path)
            return parser.get_resource_bytes(resource_path)
                
        return None

    def _get_or_create_dict_id(self, dict_name: str, mdx_file: Path) -> int:
        conn = sqlite3.connect(self.index_db)
        cursor = conn.cursor()

        cursor.execute(
            """
            INSERT OR IGNORE INTO dicts (name, filename, size)
            VALUES (?, ?, ?)
        """,
            (dict_name, f"{dict_name}.mdx", mdx_file.stat().st_size),
        )

        cursor.execute("SELECT id FROM dicts WHERE name = ?", (dict_name,))
        dict_id = cursor.fetchone()[0]

        conn.commit()
        conn.close()
        return dict_id


    def check_sources(self, word: str) -> Dict[str, bool]:
        """Check which dictionaries have a definition for the word."""
        # 强制重载配置，确保使用最新的 is_active 状态
        self.config = self._load_config()
        availability = {name: False for name in self.config["priority"] if name != "ECDICT"}

        word_lower = word.lower().strip()
        conn = sqlite3.connect(self.index_db)
        cursor = conn.cursor()
        
        # Get active dict ids
        active_dicts = {}
        for name, info in self.config["dicts"].items():
            if info.get("is_active", True):
                # get ID? We need ID.
                cursor.execute("SELECT id FROM dicts WHERE name = ?", (name,))
                row = cursor.fetchone()
                if row:
                    active_dicts[row[0]] = name
        
        if not active_dicts:
             conn.close()
             return availability
             
        placeholders = ",".join("?" * len(active_dicts))
        ids = list(active_dicts.keys())
        
        cursor.execute(
            f"SELECT dict_id, COUNT(*) FROM entries WHERE word_lower = ? AND dict_id IN ({placeholders}) GROUP BY dict_id",
            (word_lower, *ids)
        )
        
        for row in cursor.fetchall():
            dict_id = row[0]
            if row[1] > 0 and dict_id in active_dicts:
                availability[active_dicts[dict_id]] = True
                
        conn.close()
        return availability

    def word_exists(self, word: str) -> bool:
        """Check if word exists in ANY active dictionary"""
        sources = self.check_sources(word)
        return any(sources.values())

    def remove_dict(self, dict_name: str) -> bool:
        with self._lock:
            # 1. 强制重载配置，确保与磁盘状态同步
            self.config = self._load_config()
            
            if dict_name not in self.config["dicts"]:
                # 如果配置里没有但数据库里有，我们依然继续尝试清理数据库（见下文）
                logger.warning(f"配置文件中未找到词典 {dict_name}，将尝试清理数据库记录和残留文件")

            # 2. 收集需要清理的文件
            # 基础文件名（不带后缀）
            stems_to_clean = {dict_name.lower()}
            files_to_delete = []
            
            if dict_name in self.config["dicts"]:
                dict_info = self.config["dicts"][dict_name]
                files_to_delete.append(self.imported_dir / dict_info["filename"])
                # 尝试推测 MDD 文件名
                mdd_filename = dict_info["filename"].replace(".mdx", ".mdd")
                files_to_delete.append(self.imported_dir / mdd_filename)
                stems_to_clean.add(Path(dict_info["filename"]).stem.lower())

                # 添加带词典名前缀的资源文件（与导入时的逻辑一致）
                stems_to_clean.add(f"{dict_name.lower()}_")

            # 3. 扫描并删除所有与其前缀匹配的关联资源文件
            try:
                for p in self.imported_dir.glob("*"):
                    if p.is_file():
                        p_name_lower = p.name.lower()
                        # 如果文件名以任何待清理前缀开头，则删除
                        if any(p_name_lower.startswith(s) for s in stems_to_clean):
                            files_to_delete.append(p)
            except Exception as e:
                logger.error(f"扫描残留文件失败: {e}")

            # 4. 执行文件删除
            for file_path in set(files_to_delete):
                if file_path.exists():
                    try:
                        file_path.unlink()
                        logger.info(f"已删除文件: {file_path.name}")
                    except Exception as e:
                        logger.error(f"删除文件 {file_path.name} 失败 (可能被占用): {e}")

            # 5. 清理数据库
            conn = None
            try:
                conn = sqlite3.connect(self.index_db)
                cursor = conn.cursor()

                # 按名称查找 dict_id (兼容配置已删但数据库没删的情况)
                cursor.execute("SELECT id FROM dicts WHERE name = ?", (dict_name,))
                rows = cursor.fetchall()
                for row in rows:
                    dict_id = row[0]
                    cursor.execute("DELETE FROM entries WHERE dict_id = ?", (dict_id,))
                    cursor.execute("DELETE FROM dicts WHERE id = ?", (dict_id,))
                
                conn.commit()
                logger.info(f"数据库记录清理完成: {dict_name}")
            except Exception as e:
                logger.error(f"清理数据库失败: {e}")
            finally:
                if conn:
                    conn.close()

            # 6. 更新内存配置并保存
            if dict_name in self.config["dicts"]:
                del self.config["dicts"][dict_name]
            
            if dict_name in self.config.get("priority", []):
                try:
                    # 使用 while 循环删除所有匹配项，防止脏数据中有重复
                    while dict_name in self.config["priority"]:
                        self.config["priority"].remove(dict_name)
                except ValueError:
                    pass

            self._save_config(self.config)
            logger.info(f"词典彻底删除完成: {dict_name}")
            return True

    def get_dicts(self) -> List[Dict]:
        # 强制从磁盘重载配置，确保返回最新状态
        self.config = self._load_config()
        result = []

        # 使用配置中的 ECDICT 路径
        from ..config import ECDICT_DB_PATH

        ecdict_size = ECDICT_DB_PATH.stat().st_size if ECDICT_DB_PATH.exists() else 0

        # 首先添加 ECDICT
        result.append(
            {
                "name": "ECDICT",
                "type": "builtin",
                "size": ecdict_size,
                "word_count": 100000,
                "is_active": True,
                "is_builtin": True,
            }
        )

        # 获取所有已注册的导入词典名
        registered_dict_names = set(self.config.get("dicts", {}).keys())
        # 按优先级列表排序
        priority_list = [n for n in self.config.get("priority", []) if n in registered_dict_names and n != "ECDICT"]
        # 加上不在优先级列表中的词典（如果有的话）
        other_dicts = [n for n in registered_dict_names if n not in priority_list and n != "ECDICT"]
        
        all_to_show = priority_list + other_dicts

        for dict_name in all_to_show:
            dict_info = self.config["dicts"][dict_name]
            mdx_file = self.imported_dir / f"{dict_name}.mdx"
            # 获取文件大小，如果文件不存在则使用配置中的大小
            file_size = mdx_file.stat().st_size if mdx_file.exists() else dict_info.get("size", 0)
            result.append(
                {
                    "name": dict_name,
                    "type": "imported",
                    "size": file_size,
                    "word_count": dict_info.get("word_count", 0),
                    "is_active": dict_info.get("is_active", True),
                    "is_builtin": False,
                }
            )

        return result

    def set_priority(self, priority_list: List[str]):
        # 强制重载配置，确保与磁盘状态同步
        self.config = self._load_config()
        self.config["priority"] = priority_list
        self._save_config(self.config)
        logger.info(f"词典优先级已更新: {priority_list}")

    def toggle_dict(self, dict_name: str, is_active: bool):
        # 强制重载配置，确保与磁盘状态同步
        self.config = self._load_config()
        if dict_name in self.config["dicts"]:
            self.config["dicts"][dict_name]["is_active"] = is_active
            self._save_config(self.config)
            logger.info(f"词典 {dict_name} 已{'启用' if is_active else '禁用'}")

    def lookup_word(self, word: str, source: Optional[str] = None, _depth: int = 0) -> Optional[Dict]:
        if _depth > 3:  # Prevent infinite recursion for redirects
            return None

        # 强制重载配置，确保使用最新的 is_active 状态
        self.config = self._load_config()

        word_lower = word.lower().strip()

        # 0. If source is specified, try only that one first
        target_dicts = [source] if source and source != "ECDICT" else self.config["priority"]

        logger.info(f"[lookup_word] word={word}, source={source}, target_dicts={target_dicts}")
        
        # 1. Iterate through dictionaries
        for dict_name in target_dicts:
            if dict_name == "ECDICT":
                # ECDICT is handled separately (usually in dict_service)
                # But if we want to support it here, we would need a separate handler
                continue

            if dict_name not in self.config["dicts"]:
                logger.info(f"[lookup_word] Skipping {dict_name}: not in config dicts")
                continue

            dict_info = self.config["dicts"][dict_name]
            is_active = dict_info.get("is_active", True)
            logger.info(f"[lookup_word] Checking {dict_name}: is_active={is_active}")
            if not is_active:
                logger.info(f"[lookup_word] Skipping {dict_name}: is_active=False")
                continue
                
            # 2. Query index for this dictionary
            conn = sqlite3.connect(self.index_db)
            cursor = conn.cursor()
            
            # Find dict_id
            cursor.execute("SELECT id FROM dicts WHERE name = ?", (dict_name,))
            row = cursor.fetchone()
            if not row:
                conn.close()
                continue
            dict_id = row[0]
            
            # Find word entry with content
            cursor.execute(
                "SELECT word, content FROM entries WHERE dict_id = ? AND word_lower = ? LIMIT 1", 
                (dict_id, word_lower)
            )
            entry = cursor.fetchone()
            conn.close()
            
            if entry:
                original_word, content = entry
                
                if not content:
                    # 如果数据库中没有内容（可能是增量索引期间的问题），回退到动态读取
                    mdx_file = self.imported_dir / dict_info["filename"]
                    if mdx_file.exists():
                        parser = MDXParser(mdx_file)
                        content = parser.get_content_by_word(word)
                
                if not content:
                    continue

                # 4. Handle @@@LINK= redirect
                # Improved regex to capture full link target
                import re
                link_match = re.search(r"@@@LINK=([^\n\r]+)", content)
                if link_match:
                    target_word = link_match.group(1).strip()
                    # Recursively look up the target word
                    # We pass _depth to prevent infinite loops
                    # We continue searching in the SAME or PRIORITY order?
                    # Usually redirects imply the definition is under the target word in the SAME dictionary
                    # But sometimes we might want to fallback.
                    # For now, let's restart lookup for the target word which searches all dicts again
                    # This is safer to find the best definition for the target word
                    return self.lookup_word(target_word, source=source, _depth=_depth + 1)

                # 5. Extract and Sanitize
                chinese_summary = self._extract_chinese_summary(content)
                phonetic = self._extract_phonetic(content)
                part_of_speech = self._extract_part_of_speech(content)
                sanitized_content = self._sanitize_html_for_web(content)

                return {
                    "word": original_word,
                    "source": dict_name,
                    "html_content": sanitized_content,
                    "chinese_summary": chinese_summary,
                    "chinese_translation": None, # Filled by service layer if needed
                    "has_audio": True, # Assumption for MDX
                    "phonetic": phonetic,
                    "partOfSpeech": part_of_speech,
                    "meanings": [
                        {
                            "partOfSpeech": part_of_speech,
                            "definition": chinese_summary or "Detailed definition available",
                        }
                    ],
                }

        return None

    def _extract_phonetic(self, html_content: str) -> Optional[str]:
        """Extract phonetic transcription from HTML"""
        if not html_content:
            return None

        try:
            from bs4 import BeautifulSoup
            soup = BeautifulSoup(html_content, "html.parser")
            
            tag = soup.find("span", class_="pron")
            if not tag:
                # Oxford style US
                us_div = soup.find("div", class_="phons_n_am")
                if us_div:
                    tag = us_div.find("span", class_="phon")
            if not tag:
                tag = soup.find("span", class_="phon")
            if not tag:
                # Webster style
                 tag = soup.find("span", class_=lambda x: x is not None and "hpron_word" in x)

            if tag:
                text = tag.get_text().strip()
                return text.strip("/[]")
            return None
        except Exception as e:
            logger.error(f"Error extracting phonetic: {e}")
            return None

    def _extract_part_of_speech(self, html_content: str) -> Optional[str]:
        """Extract part of speech from HTML"""
        import re
        match = re.search(r'<span class="pos">([^<]+)</span>', html_content)
        if match:
            return match.group(1).strip()
        return None

    def _extract_chinese_summary(self, html_content: str) -> Optional[str]:
        """Extract Chinese characters from HTML content"""
        if not html_content:
            return None
            
        try:
            from bs4 import BeautifulSoup
            import re
            
            soup = BeautifulSoup(html_content, "html.parser")
            
            # Remove unwanted tags
            for tag in soup.find_all(attrs={"unbox": ["extra_examples", "snippet"]}):
                tag.decompose()
            for tag in soup.find_all(class_=re.compile(r"(example|exa|sentence|collapse|xref|ref|webtop-g|top-container|idioms|phrasal_verb_links)", re.I)):
                tag.decompose()
            for tag in soup.find_all(string=re.compile(r"(更多例句|牛津搭配词典|Back to List)")):
                if tag.parent:
                    tag.parent.decompose()

            summary_parts = []
            seen = set()
            current_len = 0
            
            for text_segment in soup.stripped_strings:
                if re.search(r"[\u4e00-\u9fff]", text_segment):
                    clean_text = text_segment.strip()
                    if clean_text and clean_text not in seen:
                        summary_parts.append(clean_text)
                        seen.add(clean_text)
                        current_len += len(clean_text)
                        if current_len > 100:
                            break
                            
            return "；".join(summary_parts) if summary_parts else None
        except Exception as e:
            logger.error(f"Error extracting summary: {e}")
            return None

    def _sanitize_html_for_web(self, html_content: str) -> str:
        """Sanitize HTML for web display"""
        import re
        
        # Remove scripts
        html_content = re.sub(r"<script[^>]*>.*?</script>", "", html_content, flags=re.DOTALL | re.IGNORECASE)
        html_content = re.sub(r"<script[^>]*/>", "", html_content, flags=re.IGNORECASE)
        # Remove links
        html_content = re.sub(r"<link[^>]*/?>", "", html_content, flags=re.IGNORECASE)
        # Remove body tags
        html_content = re.sub(r"<body(?:\s[^>]*)?>|</body>", "", html_content, flags=re.IGNORECASE)
        # Remove broken images
        html_content = re.sub(r'<img[^>]*src=["\']/?sound\.png["\'][^>]*>', "", html_content, flags=re.IGNORECASE)
        
        return html_content
