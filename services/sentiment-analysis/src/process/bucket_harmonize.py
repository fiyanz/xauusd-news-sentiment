"""4H bucket harmonization, event window tagging, topic interactions, and embargo split engine."""

import os
from pathlib import Path
import numpy as np
import pandas as pd
from sklearn.feature_extraction.text import TfidfVectorizer
import yaml


TOPIC_PATTERNS = {
    "topic_cpi": r"\bcpi\b",
    "topic_fomc": r"\b(?:fomc|fed|federal reserve|monetary|tightening|rate decision|rate cut)\b",
    "topic_yield": r"\b(?:yield|yields|treasury|treasuries)\b",
    "topic_payrolls": r"\b(?:payroll|payrolls|nonfarm|nfp|employment|jobs|labor)\b",
    "topic_inflation": r"\b(?:inflation|cpi|pce|price index)\b",
    "topic_dollar": r"\b(?:dollar|usd|dxy|greenback)\b",
    "topic_safehaven": r"\b(?:safe[- ]haven|safety|geopolitical|reserve accumulation)\b",
}

# Direction for the calendar -> article merge. Must stay "backward": a surprise
# may only be attached to an article published *after* the event, otherwise the
# feature leaks future information (look-ahead). "nearest" would silently pair
# an article with an event that happens up to 2 hours later.
CALENDAR_MERGE_DIRECTION = "backward"


def load_config() -> dict:
    for path in [Path("config.yaml"), Path("services/sentiment-analysis/config.yaml")]:
        if path.exists():
            with open(path, "r") as f:
                return yaml.safe_load(f)
    return {}


def harmonize_buckets(
    article_parquet: str = "data/processed/dataset_article.parquet",
    calendar_csv: str = "data/raw/calendar/economic_calendar_enriched.csv",
    price_csv: str = "data/raw/price/xauusd_h1_complete.csv",
    macro_csv: str = "data/raw/macro/macro_context.csv",
    output_parquet: str = "data/processed/bucketed_features.parquet",
    bucket_freq: str = "4h",
    embargo_hours: int = 24,
    train_ratio: float = 0.6,
    val_ratio: float = 0.2,
    tfidf_max_features: int = 50,
) -> pd.DataFrame:
    """Transform per-article news into 4H buckets, macro interactions, continuous returns, and time split."""
    print(f"[BucketHarmonize] Loading inputs: {article_parquet}, {calendar_csv}...")
    df_art = pd.read_parquet(article_parquet)
    df_art["time_published_utc"] = pd.to_datetime(df_art["time_published_utc"], utc=True)
    df_art = df_art.sort_values("time_published_utc").reset_index(drop=True)

    df_cal = pd.read_csv(calendar_csv)
    df_cal["timestamp_utc"] = pd.to_datetime(df_cal["timestamp_utc"], utc=True)
    df_cal = df_cal.sort_values("timestamp_utc").reset_index(drop=True)

    # 1. Align standardized surprise z_score and surprise_val to articles.
    # direction="backward" (CALENDAR_MERGE_DIRECTION) so a surprise is only
    # attached to articles published at/after the event timestamp — zero look-ahead.
    cal_cols = ["timestamp_utc", "event_name", "surprise_val", "z_score"]
    if "is_simulated" in df_cal.columns:
        cal_cols.append("is_simulated")
    df_cal_merge = df_cal[cal_cols].copy()
    if "is_simulated" in df_cal_merge.columns:
        # Avoid a name clash with the article-level provenance column.
        df_cal_merge = df_cal_merge.rename(columns={"is_simulated": "calendar_is_simulated"})

    df_merged = pd.merge_asof(
        df_art,
        df_cal_merge,
        left_on="time_published_utc",
        right_on="timestamp_utc",
        direction=CALENDAR_MERGE_DIRECTION,
        tolerance=pd.Timedelta(hours=2),
    )
    # Outside the calendar window there is no known event: surprise is unknown,
    # not zero. Keep NaN so aggregation can distinguish "no event" from a real 0.0.
    has_event_mask = df_merged["event_name"].notna()
    if "calendar_is_simulated" in df_merged.columns:
        sim_mask = df_merged["calendar_is_simulated"].fillna(True).astype(bool)
        has_event_mask = has_event_mask & ~sim_mask
    df_merged["_has_event"] = has_event_mask.astype(int)
    df_merged["surprise_val"] = df_merged["surprise_val"].where(has_event_mask)
    df_merged["z_score"] = df_merged["z_score"].where(has_event_mask)

    # 2. Extract macro topics & compute interaction features
    # ponytail: keyword regex fine for known templates; upgrade to zero-shot NLI classifier if noisy uncurated text
    text_corpus = (
        df_merged["title"].fillna("") + " " + df_merged["summary"].fillna("") + " " + df_merged["related_event"].fillna("")
    ).str.lower()

    for topic_col, pattern in TOPIC_PATTERNS.items():
        df_merged[topic_col] = text_corpus.str.contains(pattern, regex=True).astype(float)
        # Interaction without hardcoded inversion: lets model learn directional sign
        inter_name = f"sentiment_x_{topic_col.replace('topic_', '')}"
        df_merged[inter_name] = df_merged["overall_sentiment_score"] * df_merged[topic_col]
        df_merged[f"{topic_col}_x_sentiment"] = df_merged[inter_name]

    # 3. Clean 4H bucketing
    df_merged["time_bucket"] = df_merged["time_published_utc"].dt.floor(bucket_freq)

    # Aggregate the *event* fields with a custom function: prefer a real,
    # non-simulated event over a null one (the first article in a bucket may be
    # unrelated to the macro release that another article covers).
    def _first_event(series: pd.Series):
        non_null = series.dropna()
        return non_null.iloc[0] if len(non_null) else np.nan

    def _first_real(series: pd.Series):
        non_null = series.dropna()
        return non_null.iloc[0] if len(non_null) else np.nan

    agg_spec = {
        "time_published_utc": "first",
        "id": "count",
        "overall_sentiment_score": ["mean", "min", "max"],
        "z_score": _first_real,
        "surprise_val": _first_real,
        "event_name": _first_event,
        "_has_event": "max",
        "p0": "first",
        "vol_pre": "first",
        "ret_4h": "first",
        "ret_24h": "first",
        "is_event_window": "max",
        "session": "first",
        "title": lambda s: " ".join(s.dropna()),
        "summary": lambda s: " ".join(s.dropna()),
    }
    for topic_col in TOPIC_PATTERNS.keys():
        agg_spec[topic_col] = "max"
        short_topic = topic_col.replace("topic_", "")
        agg_spec[f"sentiment_x_{short_topic}"] = "mean"
        agg_spec[f"{topic_col}_x_sentiment"] = "mean"

    df_grouped = df_merged.groupby("time_bucket").agg(agg_spec)

    # Flatten multi-level columns from overall_sentiment_score aggregations
    flat_cols = []
    for c in df_grouped.columns:
        if isinstance(c, tuple):
            if c[0] == "overall_sentiment_score":
                flat_cols.append(f"sentiment_{c[1]}" if c[1] != "mean" else "sentiment_score")
            elif c[0] == "id":
                flat_cols.append("article_count")
            else:
                flat_cols.append(c[0])
        else:
            flat_cols.append(c)
    df_grouped.columns = flat_cols
    df_b = df_grouped.reset_index()

    # A bucket with no real event has no observable surprise: keep it null and
    # flag it, rather than presenting 0.0 (which would read as "in line").
    if "_has_event" in df_b.columns:
        no_event = df_b["_has_event"].fillna(0) == 0
        df_b.loc[no_event, "surprise_val"] = np.nan
        df_b.loc[no_event, "z_score"] = np.nan
        df_b["has_event"] = df_b["_has_event"].fillna(0).astype(int)
        df_b = df_b.drop(columns=["_has_event"])

    # Provenance for the bucketed artifact (schema lock keeps model columns).
    df_b["data_source"] = (
        "rss_feeds+vader | bls_api_v2+fred_csv | yfinance GC=F | yfinance ^TNX/DX-Y.NYB/CL=F"
    )
    df_b["generated_at"] = pd.Timestamp.now(tz="UTC").strftime("%Y-%m-%d %H:%M:%S+00:00")

    df_b["overall_sentiment_score"] = df_b["sentiment_score"]
    # Preserve the legacy column name alongside the raw calendar event name.
    if "event_name" in df_b.columns:
        df_b["related_event"] = df_b["event_name"]
    df_b["text_full"] = df_b["title"].fillna("") + " " + df_b["summary"].fillna("")

    # 4. Continuous returns and binary direction signs
    df_b["sign_4h"] = np.sign(df_b["ret_4h"]).astype(int)
    df_b["sign_24h"] = np.sign(df_b["ret_24h"]).astype(int)
    df_b["direction_4h"] = df_b["sign_4h"]
    df_b["direction_24h"] = df_b["sign_24h"]
    df_b["binary_direction_4h"] = (df_b["ret_4h"] > 0).astype(int)
    df_b["binary_direction_24h"] = (df_b["ret_24h"] > 0).astype(int)

    # 5. Temporal features
    df_b["hour_utc"] = df_b["time_bucket"].dt.hour
    df_b["dayofweek"] = df_b["time_bucket"].dt.day_of_week

    session_dummies = pd.get_dummies(df_b["session"], prefix="session", dtype=float)
    for col in ["session_Asia", "session_London", "session_NewYork"]:
        if col not in session_dummies.columns:
            session_dummies[col] = 0.0
    df_b = pd.concat([df_b, session_dummies], axis=1)

    # 5b. Point-in-Time Lagged Macro Context Merge
    if os.path.exists(macro_csv):
        df_m = pd.read_csv(macro_csv)
        df_m["date"] = pd.to_datetime(df_m["date"], utc=True)
        df_b["date_key"] = df_b["time_bucket"].dt.floor("1D")
        macro_keep_cols = [
            "date",
            "macro_us10y_lag1d",
            "macro_us10y_delta1d",
            "macro_us10y_delta5d",
            "macro_dxy_lag1d",
            "macro_dxy_delta1d",
            "macro_dxy_delta5d",
            "macro_oil_lag1d",
            "macro_oil_delta1d",
            "macro_oil_delta5d",
        ]
        df_m_clean = df_m[[c for c in macro_keep_cols if c in df_m.columns]].sort_values("date")
        df_b = pd.merge_asof(
            df_b.sort_values("time_bucket"),
            df_m_clean,
            left_on="date_key",
            right_on="date",
            direction="backward",
        ).drop(columns=["date_key", "date"])

    # 6. Chronological split: Train (60%), Val (20%), Test (20%) with 24H embargo
    df_b = df_b.sort_values("time_bucket").reset_index(drop=True)
    n_total = len(df_b)
    n_train = int(n_total * train_ratio)
    n_val = int(n_total * val_ratio)

    t_train_end = df_b.iloc[n_train]["time_bucket"]
    t_val_end = df_b.iloc[n_train + n_val]["time_bucket"]
    embargo_delta = pd.Timedelta(hours=embargo_hours)

    splits = []
    for _, row in df_b.iterrows():
        t = row["time_bucket"]
        if t < t_train_end - embargo_delta:
            splits.append("train")
        elif t < t_train_end:
            splits.append("embargo")
        elif t < t_val_end - embargo_delta:
            splits.append("val")
        elif t < t_val_end:
            splits.append("embargo")
        else:
            splits.append("test")

    df_b["split"] = splits

    # 7. TF-IDF feature extraction fitted strictly on train set
    train_mask = df_b["split"] == "train"
    tfidf = TfidfVectorizer(
        max_features=tfidf_max_features,
        ngram_range=(1, 2),
        stop_words="english",
        lowercase=True,
    )
    tfidf.fit(df_b.loc[train_mask, "text_full"])
    tfidf_mat = tfidf.transform(df_b["text_full"]).toarray()
    tfidf_cols = [f"tfidf_{i}" for i in range(tfidf_mat.shape[1])]
    df_tfidf = pd.DataFrame(tfidf_mat, columns=tfidf_cols, index=df_b.index)
    df_out = pd.concat([df_b, df_tfidf], axis=1)

    os.makedirs(os.path.dirname(output_parquet), exist_ok=True)
    df_out.to_parquet(output_parquet, index=False)
    print(
        f"[BucketHarmonize] Output saved: {output_parquet} "
        f"({len(df_out)} rows, {len(df_out.columns)} cols). Split counts: {dict(df_out['split'].value_counts())}"
    )
    return df_out


if __name__ == "__main__":
    cfg = load_config()
    proc_dir = cfg.get("data", {}).get("processed_dir", "data/processed")
    harmonize_buckets(
        article_parquet=os.path.join(proc_dir, "dataset_article.parquet"),
        calendar_csv=cfg.get("data", {}).get("calendar_file_complete", "data/raw/calendar/economic_calendar_enriched.csv"),
        price_csv=cfg.get("data", {}).get("price_file_complete", "data/raw/price/xauusd_h1_complete.csv"),
        output_parquet=os.path.join(proc_dir, "bucketed_features.parquet"),
        embargo_hours=cfg.get("split", {}).get("embargo_hours", 24),
        train_ratio=cfg.get("split", {}).get("train", 0.6),
        val_ratio=cfg.get("split", {}).get("val", 0.2),
    )
