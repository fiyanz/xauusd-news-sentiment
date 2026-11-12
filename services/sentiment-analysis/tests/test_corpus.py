"""Tests for the persistent news corpus and the GDELT parser."""

from src.acquire.corpus import append_articles, corpus_stats, load_corpus, merge_articles
from src.acquire.gdelt import _parse_seendate


def _art(url: str, ts: str) -> dict:
    return {"id": url, "title": "t", "url": url, "time_published_utc": ts}


def test_merge_dedupes_by_url_keeps_earliest():
    existing = [_art("http://a", "2026-01-02 00:00:00+00:00")]
    new = [
        _art("http://a", "2026-01-01 00:00:00+00:00"),
        _art("http://b", "2026-01-03 00:00:00+00:00"),
    ]
    merged = merge_articles(existing, new)
    assert len(merged) == 2
    a = [x for x in merged if x["url"] == "http://a"][0]
    assert a["time_published_utc"] == "2026-01-01 00:00:00+00:00"


def test_append_is_idempotent(tmp_path):
    path = str(tmp_path / "corpus.jsonl")
    assert append_articles(path, [_art("http://a", "2026-01-01 00:00:00+00:00")]) == 1
    assert append_articles(path, [_art("http://a", "2026-01-01 00:00:00+00:00")]) == 0
    assert append_articles(path, [_art("http://b", "2026-01-02 00:00:00+00:00")]) == 1
    assert len(load_corpus(path)) == 2
    assert corpus_stats(path)["articles"] == 2


def test_missing_corpus_is_empty(tmp_path):
    assert load_corpus(str(tmp_path / "nope.jsonl")) == []
    assert corpus_stats(str(tmp_path / "nope.jsonl"))["articles"] == 0


def test_gdelt_seendate_parsing():
    parsed = _parse_seendate("20260104T024500Z")
    assert parsed is not None
    assert parsed.strftime("%Y-%m-%d %H:%M") == "2026-01-04 02:45"
    assert _parse_seendate("bogus") is None
    assert _parse_seendate(None) is None
