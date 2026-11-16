"""Eksperimen H2: apakah isi berita (body) memperkuat embedding?

Protokol:
- H2: menambahkan isi artikel (summary) ke teks embedding meningkatkan delta
  rank IC pada bucket berita, dibanding judul saja.
- Prediksi: delta (body) > delta (title-only).
- Metode: dua set embedding — title-only vs title+body; paired bootstrap.
- Anti look-ahead: PCA fit on train.
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

OUT = "research/experiments/h2-body"
BUCKET = "data/processed/bucketed_features.parquet"


def main() -> None:
    Path(OUT).mkdir(parents=True, exist_ok=True)
    df = pd.read_parquet(BUCKET)
    train_mask = df["split"] == "train"

    # Teks versi judul saja vs judul+isi.
    title_only = df["title"].fillna("").astype(str)
    with_body = (df["title"].fillna("").astype(str) + " " + df["summary"].fillna("").astype(str)).str.strip()

    df["_title_only"] = title_only
    df["_with_body"] = with_body

    for tag, col in [("title", "_title_only"), ("body", "_with_body")]:
        emb, meta = build_embedding_features(
            df, text_col=col, n_components=16, train_mask=train_mask,
            cache_path=f"models/embeddings/bucket_{tag}.npy",
        )
        emb.columns = [f"{tag}_{c}" for c in emb.columns]
        df = pd.concat([df, emb], axis=1)
        print(f"[H2] {tag}: {meta}")

    df.to_parquet(f"{OUT}/bucketed_title_body.parquet", index=False)
    print(f"[H2] tersimpan: {OUT}/bucketed_title_body.parquet")


if __name__ == "__main__":
    main()
