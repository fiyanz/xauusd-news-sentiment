"""Feature engineering, TF-IDF vectorization, time-based split, and 24H embargo engine."""

import os
from pathlib import Path
import numpy as np
import pandas as pd
from sklearn.feature_extraction.text import TfidfVectorizer
import yaml


def load_config() -> dict:
    config_path = Path("config.yaml")
    if not config_path.exists():
        config_path = Path("services/sentiment-analysis/config.yaml")
    with open(config_path, "r") as f:
        return yaml.safe_load(f)


def build_features(
    input_parquet: str = "data/processed/dataset_article.parquet",
    output_parquet: str = "data/processed/features.parquet",
    embargo_hours: int = 24,
    train_ratio: float = 0.6,
    val_ratio: float = 0.2,
) -> pd.DataFrame:
    """Build feature matrix, apply time-based split with embargo, and save features dataset."""
    print(f"[Features] Loading processed dataset from {input_parquet}...")
    df = pd.read_parquet(input_parquet)
    df["time_published_utc"] = pd.to_datetime(df["time_published_utc"], utc=True)
    df = df.sort_values("time_published_utc").reset_index(drop=True)

    n_total = len(df)
    n_train = int(n_total * train_ratio)
    n_val = int(n_total * val_ratio)

    t_train_end = df.iloc[n_train]["time_published_utc"]
    t_val_end = df.iloc[n_train + n_val]["time_published_utc"]

    # Assign time-based splits with 24H embargo buffer
    embargo_delta = pd.Timedelta(hours=embargo_hours)
    splits = []

    for _, row in df.iterrows():
        t = row["time_published_utc"]
        if t < t_train_end - embargo_delta:
            splits.append("train")
        elif t < t_train_end:
            splits.append("embargo")  # Dropped from train to prevent look-ahead leak into val
        elif t < t_val_end - embargo_delta:
            splits.append("val")
        elif t < t_val_end:
            splits.append("embargo")  # Dropped from val to prevent leak into test
        else:
            splits.append("test")

    df["split"] = splits
    print(f"[Features] Split distribution:\n{df['split'].value_counts()}")

    # Ordinal sentiment label
    sentiment_map = {"Bearish": -1.0, "Neutral": 0.0, "Bullish": 1.0}
    df["sentiment_ordinal"] = df["overall_sentiment_label"].map(sentiment_map).fillna(0.0)

    # Session one-hot
    session_dummies = pd.get_dummies(df["session"], prefix="session", dtype=float)
    for col in ["session_Asia", "session_London", "session_NewYork"]:
        if col not in session_dummies.columns:
            session_dummies[col] = 0.0

    # TF-IDF Feature Extraction (Fitted strictly on train set only!)
    df["text_full"] = df["title"].fillna("") + " " + df["summary"].fillna("")
    train_mask = df["split"] == "train"

    tfidf = TfidfVectorizer(
        max_features=150,
        ngram_range=(1, 2),
        stop_words="english",
        lowercase=True,
    )
    tfidf.fit(df.loc[train_mask, "text_full"])

    tfidf_matrix = tfidf.transform(df["text_full"]).toarray()
    tfidf_cols = [f"tfidf_{i}" for i in range(tfidf_matrix.shape[1])]
    df_tfidf = pd.DataFrame(tfidf_matrix, columns=tfidf_cols, index=df.index)

    df["sentiment_score"] = df["overall_sentiment_score"].astype(float)
    df_out = pd.concat([df, session_dummies, df_tfidf], axis=1)

    # Provenance: record where this matrix came from and when it was built.
    df_out["data_source"] = "rss_feeds+vader | bls_api_v2+fred_csv | yfinance GC=F"
    df_out["generated_at"] = pd.Timestamp.now(tz="UTC").strftime("%Y-%m-%d %H:%M:%S+00:00")

    os.makedirs(os.path.dirname(output_parquet), exist_ok=True)
    df_out.to_parquet(output_parquet, index=False)

    print(f"[Features] Successfully built feature dataset: {output_parquet} ({len(df_out)} rows, {len(df_out.columns)} cols).")
    return df_out


if __name__ == "__main__":
    cfg = load_config()
    in_pq = os.path.join(cfg["data"]["processed_dir"], "dataset_article.parquet")
    out_pq = os.path.join(cfg["data"]["processed_dir"], "features.parquet")
    build_features(
        input_parquet=in_pq,
        output_parquet=out_pq,
        embargo_hours=cfg["split"]["embargo_hours"],
        train_ratio=cfg["split"]["train"],
        val_ratio=cfg["split"]["val"],
    )
