"""Feature preprocessing & dimensionality reduction.

Motivasi: fitur makro, topik, interaksi sentimen, dan TF-IDF saling berkorelasi
dan jumlahnya (32 fitur mentah + 50 TF-IDF) jauh melebihi sampel (~39 bucket).
Alih-alih membuang fitur, setiap blok berkorelasi dikompresi dengan PCA yang
difit pada data training saja, sehingga SEMUA fitur asli tetap berkontribusi
lewat komponennya. Fitur waktu di-encode siklikal. TF-IDF yang sebelumnya
menganggur kini ikut dipakai lewat komponen teks.

Aturan anti look-ahead: PCA (dan scaler) HANYA difit pada data training
(lipatan CV atau Train+Val final); data validasi/test hanya ditransformasi.
Blok ``embedding`` pengecualian yang disengaja: komponennya sudah direduksi di
pipeline dengan PCA yang difit pada train saja, jadi di sini blok tersebut
dibekukan (tidak ada PCA kedua).
"""

from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.decomposition import PCA
from sklearn.preprocessing import StandardScaler

# (nama blok, selector kolom, maksimum komponen PCA)
# ``max_components=None`` menandakan blok *precomputed*: komponennya sudah
# diproduksi oleh reducer yang difit pada data training saja di pipeline
# (``src.features.embeddings.build_bucket_embeddings``), sehingga FeatureReducer
# tidak memfit PCA kedua — basisnya dibekukan dan anti look-ahead tetap berlaku.
BLOCK_SPECS = [
    ("macro", lambda c: c.startswith("macro_"), 3),
    ("topic", lambda c: c.startswith("topic_") and not c.endswith("_x_sentiment"), 2),
    ("interaction", lambda c: c.startswith("sentiment_x_"), 2),
    ("tfidf", lambda c: c.startswith("tfidf_"), 3),
    ("embedding", lambda c: c.startswith("emb_pc"), None),
]

# Fitur non-blok yang dipertahankan apa adanya (tidak berkorelasi tinggi).
BASE_FEATURES = [
    "z_score",
    "surprise_val",
    "surprise_age_hours",
    "has_event",
    "session_Asia",
    "session_London",
    "session_NewYork",
    "sentiment_score",
    "sentiment_min",
    "sentiment_max",
    "overall_sentiment_score",
    "article_count",
    "sentiment_x_surprise_pos",
    "sentiment_x_surprise_neg",
]

CYCLICAL = ["hour_sin", "hour_cos", "dow_sin", "dow_cos"]


def _embedding_block_meta() -> dict:
    """Metadata reducer embedding (``models/embeddings/bucket_reducer_meta.json``).

    Bersifat pelengkap: bila file belum ada, blok embedding tetap terdaftar
    dengan komponen apa adanya.
    """
    try:
        from src.features.embeddings import load_reducer_meta

        return load_reducer_meta()
    except Exception:  # noqa: BLE001 - metadata opsional
        return {}


def add_cyclical_time(df: pd.DataFrame) -> pd.DataFrame:
    """Encode hour/day as sin/cos so the model sees them as periodic."""
    out = df.copy()
    if "hour_utc" in out.columns:
        h = pd.to_numeric(out["hour_utc"], errors="coerce")
        out["hour_sin"] = np.sin(2 * np.pi * h / 24.0)
        out["hour_cos"] = np.cos(2 * np.pi * h / 24.0)
    if "dayofweek" in out.columns:
        d = pd.to_numeric(out["dayofweek"], errors="coerce")
        out["dow_sin"] = np.sin(2 * np.pi * d / 7.0)
        out["dow_cos"] = np.cos(2 * np.pi * d / 7.0)
    return out


class FeatureReducer:
    """PCA per blok berkorelasi + encoding waktu siklikal."""

    def __init__(self, variance: float = 0.90, impute: float = 0.0):
        self.variance = float(variance)
        self.impute = float(impute)
        self.blocks: dict[str, dict] = {}
        self.base_cols: list[str] = []
        self.feature_cols: list[str] = []

    def fit(self, df: pd.DataFrame) -> "FeatureReducer":
        df = add_cyclical_time(df)
        emb_meta = _embedding_block_meta()
        for name, selector, max_components in BLOCK_SPECS:
            cols = [c for c in df.columns if selector(c)]
            if not cols:
                continue
            if max_components is None:
                # Blok precomputed (embedding): komponen sudah direduksi di
                # pipeline dengan PCA yang difit pada train saja. Di sini blok
                # hanya dicatat dan dipakai apa adanya (dengan imputasi netral
                # untuk baris yang kehilangan kolomnya).
                self.blocks[name] = {
                    "cols": cols,
                    "scaler": None,
                    "pca": None,
                    "comps": list(cols),
                    "precomputed": True,
                    "explained_variance": emb_meta.get("explained_variance"),
                    "source": emb_meta.get("reducer_path"),
                    "n_components": emb_meta.get("n_components"),
                }
                continue
            X = df[cols].fillna(self.impute).to_numpy(dtype=float)
            # Blok konstan di training (mis. TF-IDF/sentimen yang belum ada
            # riwayatnya) tidak bisa dikompresi -> dilewati, bukan difabrikasi.
            if X.shape[0] < 2 or np.allclose(X.std(axis=0), 0.0):
                continue
            scaler = StandardScaler().fit(X)
            Xs = scaler.transform(X)
            n_comp = min(max_components, X.shape[1], max(1, X.shape[0] - 1))
            pca = PCA(n_components=self.variance, svd_solver="full").fit(Xs)
            if pca.n_components_ > n_comp:
                pca = PCA(n_components=n_comp, svd_solver="full").fit(Xs)
            comps = [f"{name}_pc{i + 1}" for i in range(pca.n_components_)]
            self.blocks[name] = {
                "cols": cols,
                "scaler": scaler,
                "pca": pca,
                "comps": comps,
                "explained_variance": round(float(pca.explained_variance_ratio_.sum()), 4),
            }
        self.base_cols = [c for c in BASE_FEATURES if c in df.columns] + [
            c for c in CYCLICAL if c in df.columns
        ]
        self.feature_cols = self.base_cols + [
            c for b in self.blocks.values() for c in b["comps"]
        ]
        return self

    def transform(self, df: pd.DataFrame) -> pd.DataFrame:
        df = add_cyclical_time(df)
        out = pd.DataFrame(index=df.index)
        for c in self.base_cols:
            out[c] = df[c].fillna(self.impute).to_numpy(dtype=float)
        for b in self.blocks.values():
            if b.get("precomputed"):
                # Baris/artifact tanpa kolom embedding (legacy atau bucket tanpa
                # berita) diberi nilai netral, bukan NaN liar.
                Z = np.zeros((len(df), len(b["comps"])), dtype=float)
                avail = [c for c in b["cols"] if c in df.columns]
                if avail:
                    idx = [b["cols"].index(c) for c in avail]
                    Z[:, idx] = df[avail].fillna(self.impute).to_numpy(dtype=float)
                for i, c in enumerate(b["comps"]):
                    out[c] = Z[:, i]
                continue
            X = df[b["cols"]].fillna(self.impute).to_numpy(dtype=float)
            Xs = b["scaler"].transform(X)
            Z = b["pca"].transform(Xs)
            for i, c in enumerate(b["comps"]):
                out[c] = Z[:, i]
        return out[self.feature_cols]

    def transform_row(self, row: pd.Series) -> np.ndarray:
        return self.transform(pd.DataFrame([row])).to_numpy(dtype=float)

    def block_columns(self, name: str) -> list[str]:
        b = self.blocks.get(name)
        return list(b["comps"]) if b else []

    def raw_columns(self) -> list[str]:
        cols = list(BASE_FEATURES)
        for b in self.blocks.values():
            cols += b["cols"]
        return cols

    def explained_variance(self) -> dict[str, float]:
        return {name: b["explained_variance"] for name, b in self.blocks.items()}


def apply_bundle_features(bundle: dict, df: pd.DataFrame) -> pd.DataFrame:
    """Return the model-ready matrix for a DataFrame, honoring the bundle reducer.

    Falls back to the raw ``champion_feature_cols`` for legacy bundles without
    a fitted reducer.
    """
    reducer = bundle.get("reducer")
    if reducer is not None:
        return reducer.transform(df)
    cols = bundle.get("champion_feature_cols") or bundle.get("feature_cols")
    return df[cols].fillna(0.0)
