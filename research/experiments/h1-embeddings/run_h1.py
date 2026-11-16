"""Eksperimen H1: apakah embedding kalimat menambah nilai prediksi?

Protokol (locked sebelum dijalankan):
- Hipotesis H1: menambah fitur embedding kalimat (sentence-transformers,
  PCA fit on train) ke model meningkatkan rank IC test di atas baseline makro.
- Prediksi: delta_rank_ic > 0 pada split news_era (dan chronological).
- Metode: paired bootstrap 1.000 resampling, full vs baseline makro.
- Anti look-ahead: PCA + scaler difit pada train saja.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

_REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(_REPO / "services" / "sentiment-analysis"))

from src.features.embeddings import build_embedding_features  # noqa: E402

BUCKET = "data/processed/bucketed_features.parquet"
CACHE = "models/embeddings/bucket_text.npy"
OUT = "research/experiments/h1-embeddings"


def main() -> None:
    Path(OUT).mkdir(parents=True, exist_ok=True)

    df = pd.read_parquet(BUCKET)
    print(f"[H1] bucket: {df.shape}")

    # Embedding untuk semua bucket (teks kosong -> vektor netral).
    train_mask = (df["split"] == "train")
    emb_df, meta = build_embedding_features(
        df,
        text_col="text_full",
        n_components=16,
        train_mask=train_mask,
        cache_path=CACHE,
    )
    print(f"[H1] embedding meta: {meta}")

    df = pd.concat([df, emb_df], axis=1)
    emb_cols = list(emb_df.columns)

    # Simpan dataset ber-embedding untuk repro.
    df.to_parquet(f"{OUT}/bucketed_with_emb.parquet", index=False)
    with open(f"{OUT}/protocol.json", "w") as f:
        json.dump({"hypothesis": "H1", "emb_meta": meta, "emb_cols": emb_cols}, f, indent=2)

    print(f"[H1] fitur embedding: {len(emb_cols)}")
    print(f"[H1] tersimpan: {OUT}/bucketed_with_emb.parquet")


if __name__ == "__main__":
    main()
