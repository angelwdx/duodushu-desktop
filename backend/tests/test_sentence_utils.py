from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.sentence_utils import (
    extract_sentences_with_word,
    is_valid_sentence,
    page_body_text_score,
    should_skip_page_text,
)


def test_is_valid_sentence_rejects_contents_and_notes():
    assert not is_valid_sentence("Table of Contents: Chapter 1 Study of Birds", "study")
    assert not is_valid_sentence("Note 3: study the diagram on page 42.", "study")
    assert not is_valid_sentence("1.2 Study Design", "study")


def test_extract_sentences_prefers_narrative_body_text():
    text = (
        "Chapter 4 Study Abroad.\n\n"
        "Note 2: study the map before class.\n\n"
        "\"We should study the stars tonight,\" Anna said as they walked toward the river."
    )

    result = extract_sentences_with_word(text, "study")

    assert result
    assert result[0] == "\"We should study the stars tonight,\" Anna said as they walked toward the river."


def test_extract_sentences_filters_annotation_like_text():
    text = (
        "study [1] see Appendix A for details.\n\n"
        "He had to study the letter twice before he understood what she meant."
    )

    result = extract_sentences_with_word(text, "study")

    assert result == ["He had to study the letter twice before he understood what she meant."]


def test_should_skip_page_text_for_contents_like_pages():
    text = "Table of Contents\n1. Study of Birds\n2. Study of Stones\n3. Study of Rivers"
    assert should_skip_page_text(text) is True


def test_should_skip_page_text_for_header_blacklist_pages():
    assert should_skip_page_text("Glossary\nstudy: to learn deeply.") is True
    assert should_skip_page_text("Appendix\nStudy tables and charts.") is True


def test_page_body_text_score_prefers_story_page_over_notes():
    story_page = (
        "\"We should study the stars tonight,\" Anna said as they walked toward the river.\n"
        "He studied her face for a moment before answering."
    )
    notes_page = (
        "Notes\n"
        "1. Study the map.\n"
        "2. Study the diagram.\n"
        "3. Study the table."
    )

    assert should_skip_page_text(story_page) is False
    assert page_body_text_score(story_page) > page_body_text_score(notes_page)


def test_page_body_text_score_demotes_preface_like_pages():
    story_page = (
        "Chapter 3\n\"We should study the stars tonight,\" Anna said as they walked toward the river."
    )
    preface_page = (
        "Preface\nThis book helps students study language through structured examples and summaries."
    )

    assert should_skip_page_text(preface_page) is False
    assert page_body_text_score(story_page) > page_body_text_score(preface_page)
