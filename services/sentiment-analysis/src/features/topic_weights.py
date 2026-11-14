"""Topic-level sentiment weighting.

Motivasi: analisis per topik menunjukkan kekuatan sinyal sentimen sangat heterogen
— topik tertentu (mis. komoditas) punya perbedaan return positif-vs-negatif yang
jelas, sedangkan topik lain nyaris acak. Memakai sentimen mentah tanpa bobot
membuat topik lemah ikut mendominasi derau.

Modul ini menghitung bobot topik **dari data** (bukan hardcode): bobot = kekuatan
sinyal sentimen topik itu, dihitung hanya dari bucket train yang punya berita.
Kekuatan sinyal = |mean ret_4h kelompok positif − mean ret_4h kelompok negatif|
/ std ret_4h (selisih rata-rata terstandarisasi, mirip Cohen's d).

Aturan anti look-ahead: bobot HANYA dihitung dari split ``train``. Bucket
validasi/test/embargo tidak ikut dihitung; bobot yang sama kemudian diterapkan
ke semua split. Bila topik tidak punya data cukup di train, bobot = 1.0 (netral)
dan dicatat di metadata — tidak pernah diisi angka karangan.
"""

from __future__ import annotations

import json
import os

import numpy as np
import pandas as pd

# Ambang sentimen VADER untuk memisah kelompok positif/negatif (netral di tengah).
SENTIMENT_THRESHOLD = 0.05

# Minimum sampel per kelompok agar selisih rata-rata stabil. Di bawah ini topik
# dianggap tidak punya data cukup -> bobot netral 1.0.
MIN_GROUP_SIZE = 10

# Bobot minimum/maksimum. Topik sinyal lemah/nol tidak dibuang (0.25) tapi tidak
# mendominasi; topik sinyal kuat dibatasi 2.0 agar tidak meledak.
MIN_WEIGHT = 0.25
MAX_WEIGHT = 2.0

# Referensi kekuatan sinyal "sedang". weight = clip(1 + signal / SIGNAL_REF).
SIGNAL_REF = 0.30

# Kolom sentimen yang dikalikan bobot topik per baris.
SENTIMENT_COLS = ["sentiment_score", "sentiment_min", "sentiment_max"]


def _topic_columns(df: pd.DataFrame) -> list[str]:
    """Kolom topik biner (topic_*) tanpa kolom interaksi (_x_sentiment)."""
    return [
        c
        for c in df.columns
        if c.startswith("topic_") and not c.endswith("_x_sentiment")
    ]


def _sentiment_x_columns(df: pd.DataFrame) -> list[str]:
    """Kolom interaksi sentimen-topik (sentiment_x_*)."""
    return [c for c in df.columns if c.startswith("sentiment_x_")]


def compute_topic_weights(
    df: pd.DataFrame,
    split_col: str = "split",
    train_label: str = "train",
    target_col: str = "ret_4h",
    article_count_col: str = "article_count",
    sentiment_col: str = "sentiment_score",
    threshold: float = SENTIMENT_THRESHOLD,
    min_group_size: int = MIN_GROUP_SIZE,
    min_weight: float = MIN_WEIGHT,
    max_weight: float = MAX_WEIGHT,
    signal_ref: float = SIGNAL_REF,
) -> dict:
    """Hitung bobot topik dari bucket train yang punya berita.

    Untuk setiap topik ``topic_X``:
    - ambil bucket train dengan ``article_count > 0`` dan ``topic_X > 0``;
    - kelompokkan berdasarkan tanda ``sentiment_score`` (pos/neg, ambang
      ``threshold``);
    - ``signal = |mean(ret_4h | pos) − mean(ret_4h | neg)| / std(ret_4h)``;
    - ``weight = clip(1 + signal / signal_ref, min_weight, max_weight)``.

    Topik tanpa data cukup (``n_pos < min_group_size`` atau ``n_neg <
    min_group_size``) mendapat bobot 1.0 dan ``reason = "insufficient_data"``.

    Returns dict with ``weights``, ``signals``, ``meta``.
    """
    topics = _topic_columns(df)
    weights: dict[str, float] = {}
    signals: dict[str, float | None] = {}
    details: dict[str, dict] = {}

    if split_col in df.columns:
        train_mask = df[split_col] == train_label
    else:
        # Tanpa kolom split, pakai seluruh df (pemanggil bertanggung jawab
        # untuk mengirim hanya data train).
        train_mask = pd.Series(True, index=df.index)

    train = df[train_mask]
    if article_count_col in train.columns:
        train = train[train[article_count_col] > 0]

    for topic in topics:
        if topic not in train.columns:
            continue
        sub = train[train[topic] > 0]
        n = int(len(sub))

        if n == 0 or sentiment_col not in sub.columns or target_col not in sub.columns:
            weights[topic] = 1.0
            signals[topic] = None
            details[topic] = {
                "n": n,
                "n_pos": 0,
                "n_neg": 0,
                "signal": None,
                "weight": 1.0,
                "reason": "insufficient_data",
            }
            continue

        pos = sub[sub[sentiment_col] > threshold][target_col].dropna()
        neg = sub[sub[sentiment_col] < -threshold][target_col].dropna()

        if len(pos) < min_group_size or len(neg) < min_group_size:
            weights[topic] = 1.0
            signals[topic] = None
            details[topic] = {
                "n": n,
                "n_pos": int(len(pos)),
                "n_neg": int(len(neg)),
                "signal": None,
                "weight": 1.0,
                "reason": "insufficient_data",
            }
            continue

        sd = float(sub[target_col].std())
        if not np.isfinite(sd) or sd <= 0:
            weights[topic] = 1.0
            signals[topic] = None
            details[topic] = {
                "n": n,
                "n_pos": int(len(pos)),
                "n_neg": int(len(neg)),
                "signal": None,
                "weight": 1.0,
                "reason": "zero_variance",
            }
            continue

        signal = float(abs(pos.mean() - neg.mean()) / sd)
        weight = float(np.clip(1.0 + signal / signal_ref, min_weight, max_weight))
        weights[topic] = weight
        signals[topic] = signal
        details[topic] = {
            "n": n,
            "n_pos": int(len(pos)),
            "n_neg": int(len(neg)),
            "signal": round(signal, 6),
            "weight": round(weight, 6),
            "reason": "ok",
        }

    meta = {
        "method": "standardized_mean_difference",
        "formula": "weight = clip(1 + |mean(ret_4h|pos) - mean(ret_4h|neg)| / (std(ret_4h) * signal_ref), min_weight, max_weight)",
        "sentiment_threshold": threshold,
        "min_group_size": min_group_size,
        "min_weight": min_weight,
        "max_weight": max_weight,
        "signal_ref": signal_ref,
        "split_col": split_col,
        "train_label": train_label,
        "target_col": target_col,
        "sentiment_col": sentiment_col,
        "n_train_buckets_with_news": int(len(train)),
        "topics": details,
    }
    return {"weights": weights, "signals": signals, "meta": meta}


def topic_weight_factor(df: pd.DataFrame, weights: dict) -> pd.Series:
    """Rata-rata bobot topik aktif per baris; 1.0 bila tidak ada topik aktif."""
    topics = _topic_columns(df)
    active = [t for t in topics if t in df.columns]
    if not active:
        return pd.Series(1.0, index=df.index, dtype=float)

    # Bobot aktif per topik (0 bila topik tidak aktif di baris itu).
    w = pd.DataFrame(index=df.index)
    active_count = pd.Series(0.0, index=df.index, dtype=float)
    for t in active:
        flag = df[t].fillna(0.0).astype(float)
        w[t] = flag * float(weights.get(t, 1.0))
        active_count = active_count + flag

    weight_sum = w.sum(axis=1)
    factor = weight_sum / active_count.where(active_count > 0)
    return factor.fillna(1.0).astype(float)


def apply_topic_weights(df: pd.DataFrame, weights: dict) -> pd.DataFrame:
    """Kalikan kolom sentimen dengan rata-rata bobot topik aktif per baris.

    Kolom yang dikalikan: ``sentiment_score``, ``sentiment_min``,
    ``sentiment_max``, dan semua ``sentiment_x_*``. Baris tanpa topik aktif
    mendapat faktor 1.0 (tidak berubah). Mengembalikan DataFrame baru; input
    tidak diubah.
    """
    out = df.copy()
    factor = topic_weight_factor(df, weights)

    cols = [c for c in SENTIMENT_COLS if c in out.columns]
    cols += [c for c in _sentiment_x_columns(out) if c in out.columns]
    for c in cols:
        out[c] = out[c].astype(float) * factor

    return out


def save_topic_weights(
    path: str,
    weights: dict,
    signals: dict | None = None,
    meta: dict | None = None,
) -> None:
    """Simpan bobot topik + metadata ke JSON."""
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    payload = {
        "weights": {k: float(v) for k, v in weights.items()},
        "signals": {k: (None if v is None else float(v)) for k, v in (signals or {}).items()},
        "meta": meta or {},
    }
    with open(path, "w") as f:
        json.dump(payload, f, indent=2)


def load_topic_weights(path: str) -> dict:
    """Baca bobot topik dari JSON."""
    with open(path, "r") as f:
        payload = json.load(f)
    return payload.get("weights", {})


def fit_and_save_topic_weights(
    df: pd.DataFrame,
    output_path: str = "data/processed/topic_weights.json",
    **kwargs,
) -> dict:
    """Hitung bobot dari train, simpan ke JSON, kembalikan bobot."""
    result = compute_topic_weights(df, **kwargs)
    save_topic_weights(
        output_path,
        weights=result["weights"],
        signals=result["signals"],
        meta=result["meta"],
    )
    return result["weights"]


if __name__ == "__main__":
    import sys

    src = sys.argv[1] if len(sys.argv) > 1 else "data/processed/bucketed_features.parquet"
    out = sys.argv[2] if len(sys.argv) > 2 else "data/processed/topic_weights.json"
    _df = pd.read_parquet(src)
    _w = fit_and_save_topic_weights(_df, out)
    print(json.dumps(_w, indent=2))
