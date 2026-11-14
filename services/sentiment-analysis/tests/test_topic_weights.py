"""Tests for topic-level sentiment weighting.

Anti look-ahead: bobot topik HANYA dihitung dari split train. Topik tanpa data
cukup mendapat bobot netral 1.0 (bukan angka karangan).
"""

import json

import numpy as np
import pandas as pd
import pytest

from src.features.topic_weights import (
    MIN_GROUP_SIZE,
    apply_topic_weights,
    compute_topic_weights,
    fit_and_save_topic_weights,
    load_topic_weights,
    save_topic_weights,
    topic_weight_factor,
)

TOPIC_COLS = ["topic_cpi", "topic_fomc", "topic_yield"]
SENTIMENT_X = ["sentiment_x_cpi", "sentiment_x_fomc", "sentiment_x_yield"]


def _make_df(n_train: int = 200, n_test: int = 50, seed: int = 0) -> pd.DataFrame:
    """Synthetic bucketed frame with a strong cpi signal and a noise fomc."""
    rng = np.random.default_rng(seed)
    rows = []
    for split, n in (("train", n_train), ("test", n_test)):
        for i in range(n):
            has_news = i % 2 == 0
            # Multi-topic rows: i % 8 == 6 activates cpi+fomc together (even i).
            multi = has_news and i % 8 == 6
            topic_cpi = 1.0 if has_news and (i % 4 == 0 or multi) else 0.0
            topic_fomc = 1.0 if has_news and (i % 4 == 1 or multi) else 0.0
            topic_yield = 1.0 if has_news and i % 4 == 2 and not multi else 0.0
            if not has_news:
                sent = 0.0
                ret = rng.normal(0, 0.005)
            elif topic_cpi:
                # Strong: positive sentiment -> positive return, negative -> negative.
                sent = 0.5 if i % 8 == 0 else -0.5
                ret = 0.02 * np.sign(sent) + rng.normal(0, 0.002)
            elif topic_fomc:
                # Noise: sentiment uncorrelated with return.
                sent = rng.choice([-0.5, 0.5])
                ret = rng.normal(0, 0.005)
            else:
                sent = rng.normal(0, 0.3)
                ret = rng.normal(0, 0.005)
            rows.append(
                {
                    "time_bucket": pd.Timestamp("2020-01-01", tz="UTC") + pd.Timedelta(hours=4 * i),
                    "split": split,
                    "ret_4h": ret,
                    "article_count": 1 if has_news else 0,
                    "sentiment_score": sent,
                    "sentiment_min": sent,
                    "sentiment_max": sent,
                    "topic_cpi": topic_cpi,
                    "topic_fomc": topic_fomc,
                    "topic_yield": topic_yield,
                    "sentiment_x_cpi": sent * topic_cpi,
                    "sentiment_x_fomc": sent * topic_fomc,
                    "sentiment_x_yield": sent * topic_yield,
                }
            )
    return pd.DataFrame(rows)


def test_weights_computed_from_train_only():
    """Bobot harus dihitung dari train saja; test tidak boleh ikut."""
    df = _make_df(n_train=200, n_test=50, seed=1)

    weights = compute_topic_weights(df)["weights"]

    # cpi punya sinyal kuat di train -> bobot > 1.
    assert weights["topic_cpi"] > 1.0
    # fomc adalah derau di train -> bobot mendekati 1 (bukan > 1 secara artifisial).
    assert weights["topic_fomc"] == pytest.approx(1.0, abs=0.5)

    # Bukti anti look-ahead: mengubah return di test TIDAK mengubah bobot.
    df_test_modified = df.copy()
    test_mask = df_test_modified["split"] == "test"
    df_test_modified.loc[test_mask, "ret_4h"] = 100.0
    weights2 = compute_topic_weights(df_test_modified)["weights"]
    assert weights2 == weights

    # Meta mencatat hanya bucket train dengan berita.
    meta = compute_topic_weights(df)["meta"]
    train_with_news = df[(df["split"] == "train") & (df["article_count"] > 0)]
    assert meta["n_train_buckets_with_news"] == len(train_with_news)


def test_apply_topic_weights_multiplies_sentiment_columns():
    """apply_topic_weights mengalikan kolom sentimen dengan faktor topik aktif."""
    df = _make_df(n_train=100, n_test=20, seed=2)
    weights = {"topic_cpi": 2.0, "topic_fomc": 0.5, "topic_yield": 1.0}

    out = apply_topic_weights(df, weights)

    # Baris tanpa topik aktif -> faktor 1.0 (tidak berubah).
    no_topic = (df[TOPIC_COLS].sum(axis=1) == 0)
    for c in ["sentiment_score", "sentiment_min", "sentiment_max"] + SENTIMENT_X:
        assert out.loc[no_topic, c].to_numpy() == pytest.approx(
            df.loc[no_topic, c].to_numpy()
        )

    # Baris dengan hanya topic_cpi aktif -> faktor 2.0.
    only_cpi = (df["topic_cpi"] == 1.0) & (df["topic_fomc"] == 0.0) & (df["topic_yield"] == 0.0)
    for c in ["sentiment_score", "sentiment_min", "sentiment_max"] + SENTIMENT_X:
        assert out.loc[only_cpi, c].to_numpy() == pytest.approx(
            2.0 * df.loc[only_cpi, c].to_numpy()
        )

    # Baris dengan dua topik aktif -> rata-rata bobot.
    two = (df["topic_cpi"] == 1.0) & (df["topic_fomc"] == 1.0)
    assert bool(two.any())
    expected = (2.0 + 0.5) / 2.0
    assert out.loc[two, "sentiment_score"].to_numpy() == pytest.approx(
        expected * df.loc[two, "sentiment_score"].to_numpy()
    )

    # Input tidak diubah (masih punya nilai asli).
    assert float(df["sentiment_score"].abs().sum()) > 0


def test_topic_without_enough_data_gets_neutral_weight():
    """Topik tanpa data cukup di train mendapat bobot 1.0 dan dicatat."""
    df = _make_df(n_train=20, n_test=10, seed=3)
    # topic_yield hanya muncul di beberapa bucket train -> insufficient.
    df.loc[(df["split"] == "train") & (df["topic_yield"] == 1.0), "topic_yield"] = 0.0
    df.loc[(df["split"] == "train") & (df["topic_yield"] == 0.0) & (df["article_count"] > 0), "topic_yield"] = 1.0
    # Pastikan hanya 2 bucket train yang punya topic_yield.
    ty = df[(df["split"] == "train") & (df["topic_yield"] == 1.0)]
    drop = ty.index[MIN_GROUP_SIZE:]
    df.loc[drop, "topic_yield"] = 0.0

    result = compute_topic_weights(df)
    assert result["weights"]["topic_yield"] == 1.0
    assert result["meta"]["topics"]["topic_yield"]["reason"] == "insufficient_data"


def test_save_and_load_roundtrip(tmp_path):
    """Bobot + metadata tersimpan ke JSON dan bisa dibaca kembali."""
    df = _make_df(n_train=100, n_test=20, seed=4)
    path = tmp_path / "topic_weights.json"
    weights = fit_and_save_topic_weights(df, str(path))

    assert path.exists()
    payload = json.loads(path.read_text())
    assert "weights" in payload and "meta" in payload
    assert payload["meta"]["method"] == "standardized_mean_difference"

    loaded = load_topic_weights(str(path))
    assert loaded == pytest.approx(weights)
