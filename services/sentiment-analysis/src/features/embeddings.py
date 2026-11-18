"""Embedding kalimat dengan sentence-transformers.

Membuat representasi vektor dari judul + isi berita. Embedding kontekstual
menangkap makna yang tidak tertangkap TF-IDF (mis. "Fed hawkish" vs "Fed dovish").

Model default: ``all-MiniLM-L6-v2`` (384 dimensi, ringan, Inggris).
Embedding dikompresi dengan PCA yang difit pada data training saja
(anti look-ahead), lalu dipakai sebagai fitur model.
"""

from __future__ import annotations

import hashlib
import json
import os
from typing import Callable

import numpy as np
import pandas as pd

DEFAULT_MODEL = "sentence-transformers/all-MiniLM-L6-v2"
CACHE_DIR = "models/embeddings"

# Awalan kolom komponen embedding (konsumen: blok "embedding" di reduce.py).
EMB_BLOCK_PREFIX = "emb_pc"
DEFAULT_N_COMPONENTS = 16

# Artefak pipeline: cache embedding mentah + reducer (scaler & PCA) yang difit
# pada data training saja. Reducer ini yang dipakai inferensi lewat bundle.
REDUCER_DIR = "models/embeddings"
EMBEDDING_CACHE_PATH = os.path.join(REDUCER_DIR, "bucket_embeddings.npy")
REDUCER_PATH = os.path.join(REDUCER_DIR, "bucket_reducer.joblib")
REDUCER_META_PATH = os.path.join(REDUCER_DIR, "bucket_reducer_meta.json")

EncodeFn = Callable[[list[str]], np.ndarray]


def _load_encoder(model_name: str = DEFAULT_MODEL):
    """Lazy-load SentenceTransformer (butuh torch)."""
    from sentence_transformers import SentenceTransformer

    return SentenceTransformer(model_name)


def load_reducer_meta(path: str = REDUCER_META_PATH) -> dict:
    """Metadata reducer embedding; ``{}`` bila belum pernah dibangun."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:  # noqa: BLE001 - metadata bersifat pelengkap
        return {}


def _texts_digest(texts: list[str]) -> str:
    """SHA-256 atas urutan teks (panjang + isi) supaya cache tidak salah pakai."""
    h = hashlib.sha256()
    for t in texts:
        b = str(t).encode("utf-8")
        h.update(len(b).to_bytes(8, "little"))
        h.update(b)
    return h.hexdigest()


def _load_cached_embeddings(path: str, digest: str, n_texts: int) -> np.ndarray | None:
    """Embedding cache hanya dipakai kalau digest teks dan jumlah cocok."""
    meta_path = path + ".meta.json"
    if not (os.path.exists(path) and os.path.exists(meta_path)):
        return None
    try:
        with open(meta_path, "r", encoding="utf-8") as f:
            meta = json.load(f)
    except Exception:  # noqa: BLE001
        return None
    if meta.get("sha256") != digest or int(meta.get("n_texts", -1)) != int(n_texts):
        return None
    try:
        emb = np.load(path)
    except Exception:  # noqa: BLE001
        return None
    if emb.ndim != 2 or emb.shape[0] != int(n_texts):
        return None
    return np.asarray(emb, dtype=np.float64)


def _save_cached_embeddings(path: str, emb: np.ndarray, digest: str, n_texts: int) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    np.save(path, np.asarray(emb, dtype=np.float32))
    with open(path + ".meta.json", "w", encoding="utf-8") as f:
        json.dump(
            {"sha256": digest, "n_texts": int(n_texts), "dim": int(emb.shape[1])},
            f,
            indent=2,
        )


def build_bucket_embeddings(
    df: pd.DataFrame,
    text_col: str = "text_full",
    split_col: str = "split",
    train_value: str = "train",
    model_name: str = DEFAULT_MODEL,
    n_components: int = DEFAULT_N_COMPONENTS,
    cache_dir: str = REDUCER_DIR,
    encode_fn: EncodeFn | None = None,
    neutral_value: float = 0.0,
) -> tuple[pd.DataFrame, dict]:
    """Fitur embedding per bucket + PCA yang difit pada TRAIN saja.

    Aturan anti look-ahead:
    - Hanya baris dengan teks non-kosong yang di-encode.
    - ``StandardScaler`` dan ``PCA`` difit pada irisan ``split == train`` dan
      berteks; baris val/test hanya ditransformasi.
    - Bucket tanpa berita (teks kosong) mendapat nilai ``neutral_value`` (0),
      bukan NaN liar dan bukan embedding dari teks kosong.

    Returns ``(DataFrame[emb_pc1..N], meta)``. Bila encoding gagal atau tidak ada
    teks di train, kembalian ``(DataFrame kosong, meta)`` dengan
    ``meta["status"] == "unavailable"`` — pipeline dilanjutkan tanpa fitur
    embedding (bukan diisi angka karangan).
    """
    empty = pd.DataFrame(index=df.index)
    if text_col not in df.columns:
        return empty, {"status": "unavailable", "reason": f"kolom {text_col!r} tidak ada di artifact."}
    if split_col not in df.columns:
        return empty, {"status": "unavailable", "reason": f"kolom {split_col!r} tidak ada di artifact."}

    texts = df[text_col].fillna("").astype(str)
    has_text = texts.str.strip().str.len() > 0
    train_mask = df[split_col].astype(str) == str(train_value)
    fit_mask = has_text & train_mask
    n_fit = int(fit_mask.sum())

    if n_fit < 2:
        return empty, {
            "status": "unavailable",
            "reason": (
                f"hanya {n_fit} bucket berteks pada split {train_value!r}; "
                "scaler/PCA tidak bisa difit (minimal 2)."
            ),
        }

    all_texts = texts[has_text].tolist()
    cache_path = os.path.join(cache_dir, "bucket_embeddings.npy")
    digest = _texts_digest(all_texts)

    try:
        emb_all = _load_cached_embeddings(cache_path, digest, len(all_texts))
        if emb_all is None:
            if encode_fn is None:
                raw = encode_texts(all_texts, model_name=model_name)
            else:
                raw = encode_fn(all_texts)
            emb_all = np.asarray(raw, dtype=np.float64)
            if emb_all.ndim != 2 or emb_all.shape[0] != len(all_texts):
                raise ValueError(f"encoder menghasilkan bentuk {emb_all.shape}, diharapkan ({len(all_texts)}, dim)")
            _save_cached_embeddings(cache_path, emb_all, digest, len(all_texts))

        # Posisi baris berteks dalam df -> indeks baris fit di matriks embedding.
        row_positions = np.flatnonzero(has_text.to_numpy())
        fit_positions = np.flatnonzero(fit_mask.to_numpy())
        pos_in_all = np.searchsorted(row_positions, fit_positions)
        emb_fit = emb_all[pos_in_all]

        from sklearn.decomposition import PCA
        from sklearn.preprocessing import StandardScaler

        scaler = StandardScaler().fit(emb_fit)  # <-- fit on train text only
        emb_fit_scaled = scaler.transform(emb_fit)
        n_comp = int(min(int(n_components), emb_all.shape[1], max(1, n_fit - 1)))
        pca = PCA(n_components=n_comp, random_state=42).fit(emb_fit_scaled)  # <-- train only
        reduced = pca.transform(scaler.transform(emb_all))
    except Exception as exc:  # noqa: BLE001 - laporkan, jangan crash pipeline
        return empty, {
            "status": "unavailable",
            "reason": f"{type(exc).__name__}: {exc}",
            "model": model_name,
        }

    arr = np.full((len(df), reduced.shape[1]), float(neutral_value), dtype=float)
    arr[row_positions, :] = reduced
    cols = [f"{EMB_BLOCK_PREFIX}{i + 1}" for i in range(reduced.shape[1])]
    out = pd.DataFrame(arr, columns=cols, index=df.index)

    reducer_path = os.path.join(cache_dir, "bucket_reducer.joblib")
    meta = {
        "status": "ok",
        "model": model_name,
        "raw_dim": int(emb_all.shape[1]),
        "n_components": int(reduced.shape[1]),
        "explained_variance": round(float(pca.explained_variance_ratio_.sum()), 4),
        "n_encoded": int(len(all_texts)),
        "n_neutral": int((~has_text).sum()),
        "n_train_fit": n_fit,
        "fit_split": str(train_value),
        "neutral_value": float(neutral_value),
        "cache_path": cache_path,
        "reducer_path": reducer_path,
        "method": (
            "sentence-transformers + StandardScaler + PCA; scaler & PCA difit pada "
            "baris train berteks saja, val/test hanya ditransformasi"
        ),
    }

    try:
        import joblib

        os.makedirs(cache_dir, exist_ok=True)
        joblib.dump(
            {
                "scaler": scaler,
                "pca": pca,
                "model": model_name,
                "n_components": int(reduced.shape[1]),
                "n_train_fit": n_fit,
                "fit_rows": fit_positions.tolist(),
            },
            reducer_path,
        )
        with open(os.path.join(cache_dir, "bucket_reducer_meta.json"), "w", encoding="utf-8") as f:
            json.dump(meta, f, indent=2)
    except Exception as exc:  # noqa: BLE001 - reducer gagal disimpan; fitur tetap valid
        meta["warning"] = f"reducer gagal disimpan: {type(exc).__name__}: {exc}"

    return out, meta


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
