"""Tests for gold relevance weighting."""

import pandas as pd

from src.features.gold_relevance import (
    add_gold_relevance,
    apply_relevance_to_sentiment,
    compute_gold_relevance,
    relevance_summary,
)


def test_compute_relevance():
    assert compute_gold_relevance("Gold Prices Fall; Dollar Up") == 1.0
    assert compute_gold_relevance("XAUUSD hits new high") == 1.0
    assert compute_gold_relevance("Gold Fields Faces Country-Wide Strike") == 0.5
    assert compute_gold_relevance("Stock market closes higher") == 0.0
    assert compute_gold_relevance("") == 0.0


def test_add_and_weight():
    df = pd.DataFrame(
        {
            "title": ["Gold Prices Fall", "Gold Fields Strike", "Stocks Rise"],
            "overall_sentiment_score": [0.5, -0.5, 0.8],
        }
    )
    out = add_gold_relevance(df)
    assert list(out["gold_relevance"]) == [1.0, 0.5, 0.0]

    weighted = apply_relevance_to_sentiment(out, floor=0.25)
    # emas langsung: skor utuh
    assert weighted.loc[0, "overall_sentiment_score_weighted"] == 0.5
    # penambang: setengah
    assert weighted.loc[1, "overall_sentiment_score_weighted"] == -0.25
    # bukan emas: dikali floor 0.25
    assert weighted.loc[2, "overall_sentiment_score_weighted"] == 0.2


def test_summary():
    df = pd.DataFrame({"title": ["Gold up", "Gold Fields", "Stocks"]})
    s = relevance_summary(df)
    assert s["n"] == 3
    assert s["gold_direct"] == 1
    assert s["gold_miner"] == 1
    assert s["not_gold"] == 1
