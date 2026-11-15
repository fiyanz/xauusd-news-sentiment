"""Embedding kalimat dengan sentence-transformers.

Membuat representasi vektor dari judul + isi berita. Embedding kontekstual
menangkap makna yang tidak tertangkap TF-IDF (mis. "Fed hawkish" vs "Fed dovish").

Model default: ``all-MiniLM-L6-v2`` (384 dimensi, ringan, Inggris).
Embedding dikompresi dengan PCA yang difit pada data training saja
(anti look-ahead), lalu dipakai sebagai fitur model.
"""

from __future__ import annotations

import os

import numpy as np
import pandas as pd

DEFAULT_MODEL = "sentence-transformers/all-MiniLM-L6-v2"
CACHE_DIR = "models/embeddings"


def _load_encoder(model_name: str = DEFAULT_MODEL):
    """Lazy-load SentenceTransformer (butuh torch)."""
    from sentence_transformers import SentenceTransformer

    return SentenceTransformer(model_name)


def encode_texts(
    texts: list[str],
    model_name: str = DEFAULT_MODEL,
    batch_size: int = 64,
    show_progress: bool = False,
) -> np.ndarray:
    """Encode daftar teks menjadi matriks embedding (n x dim)."""
    encoder = _load_encoder(model_name)
    return np.asarray(encoder.encode(texts, batch_size=batch_size, show_progress_bar=show_progress))


def build_embedding_features(
    df: pd.DataFrame,
    text_col: str = "text",
    model_name: str = DEFAULT_MODEL,
    n_components: int = 32,
    train_mask: pd.Series | None = None,
    cache_path: str | None = None,
) -> tuple[pd.DataFrame, dict]:
    """Bangun fitur embedding + PCA (fit pada train saja).

    Returns:
        (DataFrame fitur [emb_pc1..N], metadata)
    """
    from sklearn.decomposition import PCA
    from sklearn.preprocessing import StandardScaler

    texts = df[text_col].fillna("").astype(str).tolist()

    # Cache embedding mentah supaya tidak encode ulang.
    emb = None
    if cache_path and os.path.exists(cache_path):
        emb = np.load(cache_path)
        if emb.shape[0] != len(texts):
            emb = None
    if emb is None:
        emb = encode_texts(texts, model_name=model_name)
        if cache_path:
            os.makedirs(os.path.dirname(cache_path), exist_ok=True)
            np.save(cache_path, emb)

    if train_mask is None:
        train_mask = pd.Series(True, index=df.index)

    scaler = StandardScaler().fit(emb[train_mask.values])
    emb_scaled = scaler.transform(emb)
    n_comp = min(n_components, emb_scaled.shape[1], max(1, int(train_mask.sum()) - 1))
    pca = PCA(n_components=n_comp, random_state=42).fit(emb_scaled[train_mask.values])
    reduced = pca.transform(emb_scaled)

    cols = [f"emb_pc{i + 1}" for i in range(reduced.shape[1])]
    out = pd.DataFrame(reduced, columns=cols, index=df.index)

    meta = {
        "model": model_name,
        "raw_dim": int(emb.shape[1]),
        "n_components": int(n_comp),
        "explained_variance": round(float(pca.explained_variance_ratio_.sum()), 4),
        "n_texts": int(len(texts)),
    }
    return out, meta


def text_for_row(row: pd.Series) -> str:
    """Gabungkan judul + isi untuk satu artikel."""
    title = row.get("title") or ""
    body = row.get("summary") or ""
    return f"{title} {body}".strip()
