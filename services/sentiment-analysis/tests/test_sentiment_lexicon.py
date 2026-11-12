"""Tests for the Loughran-McDonald financial lexicon scorer."""

from src.acquire.sentiment_lexicon import LoughranMcDonaldScorer


def test_lm_scorer_known_words():
    s = LoughranMcDonaldScorer()
    assert s.score("decline loss decline loss")["sentiment_lm"] == -1.0
    assert s.score("outperform advantage leadership")["sentiment_lm"] == 1.0
    assert s.score("the company reported a loss and decline in revenue")["lm_hits"] >= 1


def test_lm_scorer_empty_and_neutral():
    s = LoughranMcDonaldScorer()
    empty = s.score("")
    assert empty["lm_hits"] == 0
    assert empty["sentiment_lm"] == 0.0
    # A sentence with no finance-flag words scores neutral, not fabricated.
    assert s.score("the market opened on tuesday")["lm_hits"] == 0
