"""Tests for the full-history price bucket builder."""

import pandas as pd


def test_price_history_buckets_cover_full_history():
    """price_history mode must not cap the sample at news coverage."""
    df = pd.read_parquet("data/processed/bucketed_features.parquet")
    assert len(df) > 1000, "price-history buckets should far exceed news-only coverage"
    assert df["time_bucket"].min() < pd.Timestamp("2015-01-01", tz="UTC")
    assert df["split"].isin(["train", "val", "test", "embargo"]).all()
    # The target is a real forward return, never fabricated.
    assert df["ret_4h"].notna().all()
    assert df["ret_4h"].abs().max() < 1.0
    # Carry-forward surprise is populated for the vast majority of buckets.
    assert df["surprise_val"].notna().mean() > 0.9
    assert (df["surprise_age_hours"].dropna() >= 0).all()


def test_news_features_are_neutral_where_no_article():
    df = pd.read_parquet("data/processed/bucketed_features.parquet")
    no_news = df[df["article_count"] == 0]
    if no_news.empty:
        return
    assert (no_news["sentiment_score"] == 0.0).all()
    topic_cols = [c for c in df.columns if c.startswith("topic_") and not c.endswith("_x_sentiment")]
    for c in topic_cols:
        assert (no_news[c] == 0.0).all()


def test_embedding_features_are_neutral_where_no_article():
    """Bucket tanpa berita -> emb_pc* netral (0), tidak pernah NaN liar."""
    df = pd.read_parquet("data/processed/bucketed_features.parquet")
    emb_cols = [c for c in df.columns if c.startswith("emb_pc")]
    if not emb_cols:
        import pytest

        pytest.skip("blok embedding tidak aktif pada artifact ini")
    no_news = df[df["article_count"] == 0]
    assert not no_news.empty
    assert (no_news[emb_cols] == 0.0).all().all()
    assert df[emb_cols].notna().all().all()
    # Baris berita punya setidaknya satu komponen bukan nol.
    with_news = df[df["article_count"] > 0]
    assert (with_news[emb_cols].abs().sum(axis=1) > 0).all()
    # Status embedding tercatat sebagai provenance artifact.
    assert df["embedding_status"].iloc[0] == "ok"
