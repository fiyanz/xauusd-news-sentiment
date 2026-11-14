"""Analisis dampak sentimen berita per kelompok, TANPA split waktu.

Modul ini menjawab pertanyaan: *"sentimen berita berdampak positif/negatif/
netral ke harga, atau tidak?"* — dengan mengelompokkan artikel berdasarkan
skor sentimen dan membandingkan return 4 jam (``ret_4h``) setelah terbit.

Anti look-ahead
---------------
``ret_4h`` di ``data/processed/dataset_article.parquet`` sudah dihitung dari
harga SETELAH artikel terbit (lihat ``src/process/price_buckets.py``). Modul
ini tidak menghitung ulang return dan tidak menyentuh label/split.

Dua lexicon
-----------
- VADER: ``overall_sentiment_score``
- Loughran-McDonald: ``sentiment_lm``

Keduanya dianalisis dengan ambang yang sama (``pos_thr``/``neg_thr``) agar
perbandingan adil.
"""

import ast
import json
import os
from datetime import datetime, timezone

import numpy as np
import pandas as pd

DEFAULT_DATASET_PATH = "data/processed/dataset_article.parquet"
DEFAULT_OUTPUT_PATH = "reports/sentiment_impact.json"
DEFAULT_POS_THR = 0.05
DEFAULT_NEG_THR = -0.05
DEFAULT_N_BOOT = 2000
DEFAULT_SEED = 42

SENTIMENT_LEXICONS = {
    "vader": "overall_sentiment_score",
    "loughran_mcdonald": "sentiment_lm",
}


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def _parse_topics(value):
    """Parse kolom ``topics`` menjadi list string.

    Menangani numpy array, list, tuple, dan string repr (mis. ``"['commodities']"``).
    Mengembalikan ``[]`` bila tidak bisa diparse (bukan error).
    """
    if value is None:
        return []
    if isinstance(value, str):
        try:
            value = ast.literal_eval(value)
        except (ValueError, SyntaxError):
            return [value] if value else []
    if isinstance(value, (list, tuple, set, np.ndarray, pd.Series)):
        return [str(t) for t in value if t is not None and str(t) != ""]
    return [str(value)]


def _bootstrap_ci(values, n_boot=2000, seed=42, alpha=0.05):
    """Bootstrap percentile CI95 untuk mean.

    Mengembalikan ``(low, high)``; ``(None, None)`` bila ``values`` kosong.
    """
    values = np.asarray(values, dtype=float)
    n = len(values)
    if n == 0:
        return None, None
    if n == 1:
        return float(values[0]), float(values[0])
    rng = np.random.default_rng(seed)
    # Vectorized resampling: (n_boot, n) -> mean per resample.
    idx = rng.integers(0, n, size=(n_boot, n))
    means = values[idx].mean(axis=1)
    low = float(np.percentile(means, 100 * (alpha / 2)))
    high = float(np.percentile(means, 100 * (1 - alpha / 2)))
    return low, high


def _group_stats(values, n_boot=2000, seed=42):
    """Statistik deskriptif satu kelompok + CI95 bootstrap."""
    values = np.asarray(values, dtype=float)
    n = int(len(values))
    if n == 0:
        return {
            "n": 0,
            "mean_ret_4h": None,
            "ci95_low": None,
            "ci95_high": None,
            "std": None,
        }
    low, high = _bootstrap_ci(values, n_boot=n_boot, seed=seed)
    return {
        "n": n,
        "mean_ret_4h": round(float(values.mean()), 6),
        "ci95_low": None if low is None else round(low, 6),
        "ci95_high": None if high is None else round(high, 6),
        "std": round(float(values.std(ddof=1)), 6) if n > 1 else 0.0,
    }


def _bootstrap_pos_vs_neg(pos_values, neg_values, n_boot=2000, seed=42):
    """Uji bootstrap dua-arah: mean(pos) - mean(neg).

    p-value = proporsi resample di mana selisih <= 0 (satu-arah, sesuai
    hipotesis "positif lebih tinggi dari negatif"). Dua-arah = 2 * min(p, 1-p),
    dibatasi ke [0, 1].
    """
    pos = np.asarray(pos_values, dtype=float)
    neg = np.asarray(neg_values, dtype=float)
    n_pos, n_neg = len(pos), len(neg)
    if n_pos == 0 or n_neg == 0:
        return {
            "delta_mean": None,
            "p_value": None,
            "n_boot": 0,
            "n_pos": n_pos,
            "n_neg": n_neg,
        }

    rng = np.random.default_rng(seed)
    pos_idx = rng.integers(0, n_pos, size=(n_boot, n_pos))
    neg_idx = rng.integers(0, n_neg, size=(n_boot, n_neg))
    diffs = pos[pos_idx].mean(axis=1) - neg[neg_idx].mean(axis=1)

    p_one_sided = float(np.mean(diffs <= 0.0))
    p_two_sided = min(1.0, 2.0 * min(p_one_sided, 1.0 - p_one_sided))

    return {
        "delta_mean": round(float(diffs.mean()), 6),
        "p_value": round(p_two_sided, 5),
        "n_boot": int(n_boot),
        "n_pos": n_pos,
        "n_neg": n_neg,
    }


# --------------------------------------------------------------------------- #
# Core analysis
# --------------------------------------------------------------------------- #
def analyze_sentiment_impact(
    df: pd.DataFrame,
    sentiment_col: str,
    pos_thr: float = DEFAULT_POS_THR,
    neg_thr: float = DEFAULT_NEG_THR,
    n_boot: int = DEFAULT_N_BOOT,
    seed: int = DEFAULT_SEED,
) -> dict:
    """Analisis dampak sentimen per kelompok (positif/netral/negatif).

    Parameters
    ----------
    df : DataFrame artikel dengan kolom ``sentiment_col`` dan ``ret_4h``.
    sentiment_col : nama kolom skor sentimen.
    pos_thr : ambang bawah kelompok positif (skor > pos_thr).
    neg_thr : ambang atas kelompok negatif (skor < neg_thr).
    n_boot : jumlah resample bootstrap.
    seed : seed RNG.

    Returns
    -------
    dict dengan kunci ``groups`` (per kelompok) dan ``pos_vs_neg_test``.
    Kelompok kosong -> ``n=0`` dan statistik ``None`` (bukan NaN).
    """
    if sentiment_col not in df.columns:
        raise ValueError(f"Kolom sentimen {sentiment_col!r} tidak ada di DataFrame")
    if "ret_4h" not in df.columns:
        raise ValueError("Kolom 'ret_4h' tidak ada di DataFrame")

    work = df[[sentiment_col, "ret_4h"]].copy()
    work[sentiment_col] = pd.to_numeric(work[sentiment_col], errors="coerce")
    work["ret_4h"] = pd.to_numeric(work["ret_4h"], errors="coerce")
    work = work.dropna(subset=[sentiment_col, "ret_4h"])

    scores = work[sentiment_col].to_numpy(dtype=float)
    rets = work["ret_4h"].to_numpy(dtype=float)

    pos_mask = scores > pos_thr
    neg_mask = scores < neg_thr
    neu_mask = (~pos_mask) & (~neg_mask)

    groups = {
        "positif": _group_stats(rets[pos_mask], n_boot=n_boot, seed=seed),
        "netral": _group_stats(rets[neu_mask], n_boot=n_boot, seed=seed),
        "negatif": _group_stats(rets[neg_mask], n_boot=n_boot, seed=seed),
    }

    pos_vs_neg = _bootstrap_pos_vs_neg(
        rets[pos_mask], rets[neg_mask], n_boot=n_boot, seed=seed
    )

    return {
        "sentiment_col": sentiment_col,
        "pos_thr": pos_thr,
        "neg_thr": neg_thr,
        "n_articles": int(len(work)),
        "groups": groups,
        "pos_vs_neg_test": pos_vs_neg,
        "n_boot": n_boot,
        "seed": seed,
    }


def analyze_by_topic(
    df: pd.DataFrame,
    sentiment_col: str,
    topics=None,
    pos_thr: float = DEFAULT_POS_THR,
    neg_thr: float = DEFAULT_NEG_THR,
    n_boot: int = DEFAULT_N_BOOT,
    seed: int = DEFAULT_SEED,
) -> dict:
    """Ulangi analisis sentimen per topik.

    ``topics`` bila ``None`` -> semua topik yang ditemukan di kolom ``topics``.
    Artikel dengan multi-topik dihitung di masing-masing topik (bukan duplikat
    global, hanya per topik).
    """
    if "topics" not in df.columns:
        raise ValueError("Kolom 'topics' tidak ada di DataFrame")

    parsed = df["topics"].apply(_parse_topics)
    if topics is None:
        seen = set()
        for lst in parsed:
            seen.update(lst)
        topics = sorted(seen)

    result = {}
    for topic in topics:
        mask = parsed.apply(lambda lst, t=topic: t in lst)
        sub = df[mask].reset_index(drop=True)
        result[topic] = analyze_sentiment_impact(
            sub,
            sentiment_col,
            pos_thr=pos_thr,
            neg_thr=neg_thr,
            n_boot=n_boot,
            seed=seed,
        )
    return result


# --------------------------------------------------------------------------- #
# Report
# --------------------------------------------------------------------------- #
def write_sentiment_impact_report(
    output_path: str = DEFAULT_OUTPUT_PATH,
    dataset_path: str = DEFAULT_DATASET_PATH,
    pos_thr: float = DEFAULT_POS_THR,
    neg_thr: float = DEFAULT_NEG_THR,
    n_boot: int = DEFAULT_N_BOOT,
    seed: int = DEFAULT_SEED,
) -> dict:
    """Analisis VADER + LM sekaligus, simpan JSON, kembalikan report."""
    if not os.path.exists(dataset_path):
        raise FileNotFoundError(f"Dataset tidak ditemukan: {dataset_path}")

    df = pd.read_parquet(dataset_path)

    lexicons = {}
    for name, col in SENTIMENT_LEXICONS.items():
        if col not in df.columns:
            continue
        overall = analyze_sentiment_impact(
            df, col, pos_thr=pos_thr, neg_thr=neg_thr, n_boot=n_boot, seed=seed
        )
        by_topic = analyze_by_topic(
            df, col, pos_thr=pos_thr, neg_thr=neg_thr, n_boot=n_boot, seed=seed
        )
        lexicons[name] = {
            "sentiment_col": col,
            "overall": overall,
            "by_topic": by_topic,
        }

    report = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "dataset_path": dataset_path,
        "metadata": {
            "n_articles": int(len(df)),
            "pos_thr": pos_thr,
            "neg_thr": neg_thr,
            "n_boot": n_boot,
            "seed": seed,
            "sentiment_columns": list(SENTIMENT_LEXICONS.values()),
            "time_range": [
                str(df["time_published_utc"].min()) if "time_published_utc" in df.columns else None,
                str(df["time_published_utc"].max()) if "time_published_utc" in df.columns else None,
            ],
            "note": (
                "Analisis TANPA split waktu. ret_4h dihitung dari harga setelah "
                "artikel terbit (anti look-ahead). Kelompok kosong -> n=0 dan null."
            ),
        },
        "lexicons": lexicons,
    }

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, "w") as f:
        json.dump(report, f, indent=2)

    return report


def _fmt_group(stats):
    if stats["n"] == 0:
        return "n=0 (kosong)"
    return (
        f"n={stats['n']}, mean={stats['mean_ret_4h']:+.4%}, "
        f"CI95=[{stats['ci95_low']:+.4%}, {stats['ci95_high']:+.4%}], "
        f"std={stats['std']:.4%}"
    )


def print_summary(report: dict) -> None:
    """Cetak ringkasan human-readable."""
    meta = report["metadata"]
    print("=" * 72)
    print("ANALISIS DAMPAK SENTIMEN (tanpa split waktu)")
    print("=" * 72)
    print(
        f"Artikel: {meta['n_articles']} | ambang: pos>{meta['pos_thr']}, "
        f"neg<{meta['neg_thr']} | n_boot={meta['n_boot']} | seed={meta['seed']}"
    )
    print(f"Periode: {meta['time_range'][0]} .. {meta['time_range'][1]}")
    print()

    for name, block in report["lexicons"].items():
        print(f"--- {name.upper()} ({block['sentiment_col']}) ---")
        overall = block["overall"]
        for gname, stats in overall["groups"].items():
            print(f"  {gname:>8}: {_fmt_group(stats)}")
        test = overall["pos_vs_neg_test"]
        if test["p_value"] is not None:
            print(
                f"  pos vs neg: delta={test['delta_mean']:+.4%}, "
                f"p={test['p_value']:.5f} (n_boot={test['n_boot']})"
            )
        else:
            print("  pos vs neg: N/A (kelompok kosong)")
        print()

        print("  Per topik:")
        for topic, res in block["by_topic"].items():
            print(f"    [{topic}]")
            for gname, stats in res["groups"].items():
                print(f"      {gname:>8}: {_fmt_group(stats)}")
            test = res["pos_vs_neg_test"]
            if test["p_value"] is not None:
                print(
                    f"      pos vs neg: delta={test['delta_mean']:+.4%}, "
                    f"p={test['p_value']:.5f}"
                )
        print()


if __name__ == "__main__":
    report = write_sentiment_impact_report()
    print_summary(report)
    print(f"[SentimentImpact] Report saved to: {DEFAULT_OUTPUT_PATH}")
