"""Tests for ``src.evaluate.sentiment_impact``.

(a) analyze_sentiment_impact mengembalikan 3 kelompok dengan n yang benar,
(b) bootstrap p-value berada di [0, 1],
(c) laporan JSON bisa ditulis dan dibaca ulang.
"""

import json

import numpy as np
import pandas as pd

from src.evaluate.sentiment_impact import (
    analyze_by_topic,
    analyze_sentiment_impact,
    write_sentiment_impact_report,
)


def _make_df(n=300, seed=0):
    rng = np.random.default_rng(seed)
    scores = rng.uniform(-1, 1, size=n)
    rets = rng.normal(0, 0.005, size=n)
    topic_pool = [["commodities"], ["commodities", "forex"], ["economy_monetary"]]
    topic_idx = rng.integers(0, len(topic_pool), size=n)
    topics = [topic_pool[i] for i in topic_idx]
    return pd.DataFrame(
        {
            "overall_sentiment_score": scores,
            "sentiment_lm": scores,
            "ret_4h": rets,
            "topics": topics,
        }
    )


def test_analyze_returns_three_groups_with_correct_n():
    df = _make_df(n=300, seed=1)
    pos_thr, neg_thr = 0.05, -0.05

    res = analyze_sentiment_impact(
        df, "overall_sentiment_score", pos_thr=pos_thr, neg_thr=neg_thr, n_boot=200
    )

    assert set(res["groups"].keys()) == {"positif", "netral", "negatif"}

    scores = df["overall_sentiment_score"].to_numpy()
    expected = {
        "positif": int((scores > pos_thr).sum()),
        "netral": int(((scores >= neg_thr) & (scores <= pos_thr)).sum()),
        "negatif": int((scores < neg_thr).sum()),
    }
    for g, n_expected in expected.items():
        assert res["groups"][g]["n"] == n_expected, f"{g}: {res['groups'][g]['n']} != {n_expected}"

    # Total kelompok = total artikel yang valid.
    assert sum(g["n"] for g in res["groups"].values()) == len(df)

    # Statistik ada untuk kelompok non-kosong.
    for g, stats in res["groups"].items():
        if stats["n"] > 0:
            assert stats["mean_ret_4h"] is not None
            assert stats["ci95_low"] is not None
            assert stats["ci95_high"] is not None
            assert stats["ci95_low"] <= stats["ci95_high"]


def test_bootstrap_p_value_in_unit_interval():
    df = _make_df(n=200, seed=2)
    res = analyze_sentiment_impact(df, "overall_sentiment_score", n_boot=200, seed=42)

    p = res["pos_vs_neg_test"]["p_value"]
    assert p is not None
    assert 0.0 <= p <= 1.0

    # delta_mean bootstrap mendekati selisih mean sampel (toleransi resample).
    pos = df.loc[df["overall_sentiment_score"] > 0.05, "ret_4h"].mean()
    neg = df.loc[df["overall_sentiment_score"] < -0.05, "ret_4h"].mean()
    assert abs(res["pos_vs_neg_test"]["delta_mean"] - (pos - neg)) < 5e-4


def test_empty_group_is_null_not_nan():
    df = pd.DataFrame(
        {
            "overall_sentiment_score": [0.0, 0.0, 0.0],
            "ret_4h": [0.001, -0.001, 0.002],
            "topics": [["commodities"]] * 3,
        }
    )
    res = analyze_sentiment_impact(df, "overall_sentiment_score", n_boot=100)
    assert res["groups"]["positif"]["n"] == 0
    assert res["groups"]["negatif"]["n"] == 0
    assert res["groups"]["positif"]["mean_ret_4h"] is None
    assert res["groups"]["positif"]["ci95_low"] is None
    assert res["groups"]["netral"]["n"] == 3
    # pos vs neg tidak bisa dihitung -> null.
    assert res["pos_vs_neg_test"]["p_value"] is None
    assert res["pos_vs_neg_test"]["delta_mean"] is None


def test_analyze_by_topic_covers_all_topics():
    df = _make_df(n=150, seed=3)
    res = analyze_by_topic(df, "overall_sentiment_score", n_boot=100)
    assert set(res.keys()) == {"commodities", "economy_monetary", "forex"}
    for topic, block in res.items():
        assert set(block["groups"].keys()) == {"positif", "netral", "negatif"}
        assert block["n_articles"] > 0


def test_report_written_and_readable(tmp_path):
    df = _make_df(n=120, seed=4)
    # Tulis dataset sementara agar report tidak bergantung pada artifact repo.
    dataset_path = tmp_path / "dataset_article.parquet"
    df.to_parquet(dataset_path, index=False)

    out = tmp_path / "sentiment_impact.json"
    report = write_sentiment_impact_report(
        output_path=str(out),
        dataset_path=str(dataset_path),
        n_boot=100,
        seed=42,
    )

    assert out.exists()
    with open(out, "r") as f:
        loaded = json.load(f)

    assert loaded["metadata"]["n_articles"] == len(df)
    assert loaded["metadata"]["n_boot"] == 100
    assert loaded["metadata"]["seed"] == 42
    assert set(loaded["lexicons"].keys()) == {"vader", "loughran_mcdonald"}

    # Konsisten dengan nilai yang dikembalikan fungsi.
    assert loaded["lexicons"]["vader"]["overall"]["n_articles"] == report["lexicons"]["vader"]["overall"]["n_articles"]
    # JSON round-trip: semua kelompok ada.
    for name, block in loaded["lexicons"].items():
        assert set(block["overall"]["groups"].keys()) == {"positif", "netral", "negatif"}
