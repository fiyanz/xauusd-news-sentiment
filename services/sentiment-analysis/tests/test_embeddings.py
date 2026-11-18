"""Tests for sentence-embedding features (anti look-ahead & neutral fallback).

The encoder is injected as a deterministic fake so these tests never need
torch/sentence-transformers, while the scaler/PCA fit logic is the real one.
"""

import numpy as np
import pandas as pd
import pytest

from src.features.embeddings import build_bucket_embeddings


def _fake_encode(texts):
    """Deterministic pseudo-encoder: one vector per text, dim=8."""
    out = np.zeros((len(texts), 8), dtype=np.float64)
    for i, t in enumerate(texts):
        seed = abs(hash(t)) % 1000
        rng = np.random.default_rng(seed)
        out[i] = rng.normal(size=8)
    return out


def _frame(n_train=6, n_val=3, n_test=3) -> pd.DataFrame:
    rows = []
    for split, n in (("train", n_train), ("val", n_val), ("test", n_test)):
        for i in range(n):
            rows.append(
                {
                    "time_bucket": pd.Timestamp("2026-01-01", tz="UTC") + pd.Timedelta(hours=4 * len(rows)),
                    "text_full": f"gold rally news {split} {i}" if i % 2 == 0 else "",
                    "article_count": 1 if i % 2 == 0 else 0,
                    "split": split,
                }
            )
    return pd.DataFrame(rows)


def test_embedding_columns_and_neutral_buckets(tmp_path):
    df = _frame()
    emb, meta = build_bucket_embeddings(df, cache_dir=str(tmp_path), encode_fn=_fake_encode)

    assert meta["status"] == "ok"
    assert list(emb.columns) == [f"emb_pc{i + 1}" for i in range(meta["n_components"])]
    assert len(emb) == len(df)

    # Bucket tanpa berita -> netral (0), bukan NaN liar.
    empty_rows = df["text_full"].str.strip() == ""
    assert empty_rows.any()
    assert (emb.loc[empty_rows.to_numpy()] == 0.0).all().all()
    assert emb.notna().all().all()

    # Baris berteks dapat nilai komponen (bukan semua nol).
    assert (emb.loc[~empty_rows.to_numpy()].abs().sum(axis=1) > 0).all()

    # Yang difit hanya baris train berteks.
    train_text = ((df["split"] == "train") & ~empty_rows).sum()
    assert meta["n_train_fit"] == int(train_text)
    assert meta["n_neutral"] == int(empty_rows.sum())


def test_scaler_pca_fitted_on_train_only(tmp_path):
    """Mengubah teks val/test TIDAK boleh mengubah scaler/PCA (anti look-ahead)."""
    df = _frame()

    def _reducer_params(frame):
        cache = tmp_path / f"cache_{abs(id(frame))}"
        _, meta = build_bucket_embeddings(frame, cache_dir=str(cache), encode_fn=_fake_encode, n_components=4)
        assert meta["status"] == "ok"
        import joblib

        red = joblib.load(meta["reducer_path"])
        return red["scaler"].mean_, red["pca"].components_

    mean_a, comp_a = _reducer_params(df)

    changed = df.copy()
    val_test = changed["split"] != "train"
    changed.loc[val_test, "text_full"] = "KOMPLETLY DIUBAH " + changed.loc[val_test, "text_full"]
    mean_b, comp_b = _reducer_params(changed)

    np.testing.assert_allclose(mean_a, mean_b, atol=1e-9)
    np.testing.assert_allclose(comp_a, comp_b, atol=1e-9)


def test_unavailable_when_encoder_fails(tmp_path):
    def _boom(texts):
        raise RuntimeError("model weights not found")

    df = _frame()
    emb, meta = build_bucket_embeddings(df, cache_dir=str(tmp_path), encode_fn=_boom)

    assert meta["status"] == "unavailable"
    assert "RuntimeError" in meta["reason"]
    assert emb.empty


def test_unavailable_without_train_text(tmp_path):
    df = _frame()
    df.loc[df["split"] == "train", "text_full"] = ""
    emb, meta = build_bucket_embeddings(df, cache_dir=str(tmp_path), encode_fn=_fake_encode)

    assert meta["status"] == "unavailable"
    assert emb.empty


def test_reducer_meta_written_for_provenance(tmp_path):
    df = _frame(n_train=12, n_val=4, n_test=4)
    _, meta = build_bucket_embeddings(df, cache_dir=str(tmp_path), encode_fn=_fake_encode, n_components=5)
    assert meta["status"] == "ok"
    assert meta["n_components"] == 5

    import json

    with open(tmp_path / "bucket_reducer_meta.json", encoding="utf-8") as f:
        saved = json.load(f)
    assert saved["status"] == "ok"
    assert saved["n_components"] == 5
    assert saved["fit_split"] == "train"
    assert saved["reducer_path"].endswith("bucket_reducer.joblib")
