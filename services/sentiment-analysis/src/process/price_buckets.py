"""Build 4H buckets from the FULL price history.

The news-only path (``bucket_harmonize.harmonize_buckets``) creates a bucket only
when an article falls inside it, so the sample is capped by news coverage (~14
days of RSS). That makes CV/evaluation pure noise.

This module instead creates a bucket for every 4H window in the price series.
News features are aggregated per bucket and are neutral (0) when no article falls
in it, so the sample size is independent of news coverage and the model can
actually be evaluated on tens of thousands of buckets.

Point-in-time rules are preserved:
- ``ret_4h`` / ``ret_24h`` use closes at/after the bucket start (no look-ahead).
- ``vol_pre`` uses a shifted rolling volatility.
- the macro merge is ``merge_asof backward`` on date.
- the surprise is a backward carry-forward of the last *released* event, with
  ``surprise_age_hours`` so stale values are distinguishable.
"""

import os

import numpy as np
import pandas as pd
from sklearn.feature_extraction.text import TfidfVectorizer

from src.process.bucket_harmonize import TOPIC_PATTERNS

SESSIONS = ["session_Asia", "session_London", "session_NewYork"]


def _assign_session(h: int) -> str:
    if 0 <= h < 7:
        return "Asia"
    if 7 <= h < 13:
        return "London"
    return "NewYork"


def build_price_history_buckets(
    price_csv: str = "data/raw/price/xauusd_h1_complete.csv",
    article_parquet: str = "data/processed/dataset_article.parquet",
    calendar_csv: str = "data/raw/calendar/economic_calendar_enriched.csv",
    macro_csv: str = "data/raw/macro/macro_context.csv",
    output_parquet: str = "data/processed/bucketed_features.parquet",
    bucket_freq: str = "4h",
    embargo_hours: int = 24,
    train_ratio: float = 0.6,
    val_ratio: float = 0.2,
    tfidf_max_features: int = 50,
    vol_lookback_days: int = 20,
    sentiment_col: str = "overall_sentiment_score",
) -> pd.DataFrame:
    """Create 4H buckets covering the whole price history, with sparse news."""
    print(f"[PriceBuckets] Building 4H buckets from {price_csv}...")

    # 1. Price -> 4H buckets -------------------------------------------------
    df_price = pd.read_csv(price_csv)
    df_price["time"] = pd.to_datetime(df_price["time"], utc=True)
    df_price = df_price.sort_values("time").drop_duplicates("time").reset_index(drop=True)
    df_price["hourly_ret"] = df_price["close"].pct_change()
    lookback_hours = vol_lookback_days * 24
    df_price["rolling_vol"] = (
        df_price["hourly_ret"].shift(1).rolling(window=lookback_hours, min_periods=48).std()
    )
    default_vol = float(df_price["hourly_ret"].std())
    if not np.isfinite(default_vol) or default_vol <= 0:
        default_vol = 0.0035
    df_price["rolling_vol"] = df_price["rolling_vol"].fillna(default_vol)
    df_price["time_bucket"] = df_price["time"].dt.floor(bucket_freq)

    buckets = (
        df_price.groupby("time_bucket")
        .agg(p0=("close", "first"), vol_pre=("rolling_vol", "first"))
        .reset_index()
    )

    close_by_time = df_price.set_index("time")["close"]

    def _close_at(t: pd.Timestamp) -> float:
        idx = close_by_time.index.searchsorted(t)
        if idx >= len(close_by_time):
            return np.nan
        return float(close_by_time.iloc[idx])

    buckets["p_4h"] = buckets["time_bucket"].apply(lambda t: _close_at(t + pd.Timedelta(hours=4)))
    buckets["p_24h"] = buckets["time_bucket"].apply(lambda t: _close_at(t + pd.Timedelta(hours=24)))
    buckets["ret_4h"] = (buckets["p_4h"] - buckets["p0"]) / buckets["p0"]
    buckets["ret_24h"] = (buckets["p_24h"] - buckets["p0"]) / buckets["p0"]
    buckets = buckets.dropna(subset=["ret_4h", "ret_24h"]).reset_index(drop=True)
    print(f"[PriceBuckets] {len(buckets)} buckets ({buckets['time_bucket'].min()} .. {buckets['time_bucket'].max()}).")

    # 2. News aggregated per bucket (sparse: neutral 0 when no article) -------
    if os.path.exists(article_parquet):
        df_art = pd.read_parquet(article_parquet)
        df_art["time_published_utc"] = pd.to_datetime(df_art["time_published_utc"], utc=True)
        df_art["time_bucket"] = df_art["time_published_utc"].dt.floor(bucket_freq)
        text_corpus = (
            df_art["title"].fillna("") + " " + df_art["summary"].fillna("") + " " + df_art["related_event"].fillna("")
        ).str.lower()
        if sentiment_col not in df_art.columns:
            print(f"[PriceBuckets] kolom sentimen {sentiment_col!r} tidak ada; memakai overall_sentiment_score.")
            sentiment_col = "overall_sentiment_score"
        for topic_col, pattern in TOPIC_PATTERNS.items():
            df_art[topic_col] = text_corpus.str.contains(pattern, regex=True).astype(float)
            short = topic_col.replace("topic_", "")
            df_art[f"sentiment_x_{short}"] = df_art[sentiment_col] * df_art[topic_col]
            df_art[f"{topic_col}_x_sentiment"] = df_art[f"sentiment_x_{short}"]

        agg_spec = {
            "id": "count",
            sentiment_col: ["mean", "min", "max"],
            "title": lambda s: " ".join(s.dropna()),
            "summary": lambda s: " ".join(s.dropna()),
            "related_event": lambda s: " ".join(s.dropna()),
        }
        for topic_col in TOPIC_PATTERNS:
            agg_spec[topic_col] = "max"
            short = topic_col.replace("topic_", "")
            agg_spec[f"sentiment_x_{short}"] = "mean"
            agg_spec[f"{topic_col}_x_sentiment"] = "mean"

        news_b = df_art.groupby("time_bucket").agg(agg_spec)
        flat = []
        for c in news_b.columns:
            if isinstance(c, tuple):
                if c[0] == sentiment_col:
                    flat.append("sentiment_score" if c[1] == "mean" else f"sentiment_{c[1]}")
                elif c[0] == "id":
                    flat.append("article_count")
                else:
                    flat.append(c[0])
            else:
                flat.append(c)
        news_b.columns = flat
        news_b = news_b.reset_index()
        buckets = buckets.merge(news_b, on="time_bucket", how="left")
    else:
        buckets["article_count"] = 0
        buckets["sentiment_score"] = 0.0
        buckets["sentiment_min"] = 0.0
        buckets["sentiment_max"] = 0.0
        buckets["title"] = ""
        buckets["summary"] = ""
        buckets["related_event"] = ""
        for topic_col in TOPIC_PATTERNS:
            buckets[topic_col] = 0.0
            short = topic_col.replace("topic_", "")
            buckets[f"sentiment_x_{short}"] = 0.0
            buckets[f"{topic_col}_x_sentiment"] = 0.0

    news_cols = (
        ["article_count", "sentiment_score", "sentiment_min", "sentiment_max"]
        + [c for c in buckets.columns if c.startswith("topic_") or c.startswith("sentiment_x_")]
    )
    for c in news_cols:
        buckets[c] = buckets[c].fillna(0.0)
    for c in ("title", "summary", "related_event"):
        buckets[c] = buckets[c].fillna("")

    # 3. Calendar: carry-forward surprise + in-window event flag -------------
    df_cal = pd.read_csv(calendar_csv)
    df_cal["timestamp_utc"] = pd.to_datetime(df_cal["timestamp_utc"], utc=True)
    real_cal = df_cal.copy()
    if "is_simulated" in real_cal.columns:
        real_cal = real_cal[~real_cal["is_simulated"].fillna(True).astype(bool)]
    real_cal = real_cal.dropna(subset=["surprise_val"])

    if not real_cal.empty:
        cf_right = (
            real_cal[["timestamp_utc", "event_name", "surprise_val", "z_score"]]
            .sort_values("timestamp_utc")
            .rename(
                columns={
                    "timestamp_utc": "cf_timestamp_utc",
                    "event_name": "cf_event_name",
                    "surprise_val": "surprise_val_cf",
                    "z_score": "z_score_cf",
                }
            )
        )
        buckets = pd.merge_asof(
            buckets.sort_values("time_bucket"),
            cf_right,
            left_on="time_bucket",
            right_on="cf_timestamp_utc",
            direction="backward",
        )
        buckets["surprise_age_hours"] = (
            buckets["time_bucket"] - buckets["cf_timestamp_utc"]
        ).dt.total_seconds() / 3600.0
        buckets["surprise_val"] = buckets["surprise_val_cf"]
        buckets["z_score"] = buckets["z_score_cf"]
        buckets["related_event"] = buckets["cf_event_name"].fillna("") + buckets["related_event"].fillna("")
        buckets = buckets.drop(columns=["cf_timestamp_utc", "cf_event_name", "surprise_val_cf", "z_score_cf"])

        def _has_event(t: pd.Timestamp) -> int:
            nxt = t + pd.Timedelta(hours=4)
            return int(((real_cal["timestamp_utc"] >= t) & (real_cal["timestamp_utc"] < nxt)).any())

        buckets["has_event"] = buckets["time_bucket"].apply(_has_event)
    else:
        buckets["surprise_val"] = np.nan
        buckets["z_score"] = np.nan
        buckets["surprise_age_hours"] = np.nan
        buckets["has_event"] = 0

    # 4. Temporal / session --------------------------------------------------
    buckets["hour_utc"] = buckets["time_bucket"].dt.hour
    buckets["dayofweek"] = buckets["time_bucket"].dt.day_of_week
    buckets["session"] = buckets["hour_utc"].apply(_assign_session)
    session_dummies = pd.get_dummies(buckets["session"], prefix="session", dtype=float)
    for col in SESSIONS:
        if col not in session_dummies.columns:
            session_dummies[col] = 0.0
    buckets = pd.concat([buckets, session_dummies[SESSIONS]], axis=1)

    # 5. Point-in-Time lagged macro context ---------------------------------
    if os.path.exists(macro_csv):
        df_m = pd.read_csv(macro_csv)
        df_m["date"] = pd.to_datetime(df_m["date"], utc=True)
        buckets["date_key"] = buckets["time_bucket"].dt.floor("1D")
        macro_keep_cols = [
            "date",
            "macro_us10y_lag1d", "macro_us10y_delta1d", "macro_us10y_delta5d",
            "macro_dxy_lag1d", "macro_dxy_delta1d", "macro_dxy_delta5d",
            "macro_oil_lag1d", "macro_oil_delta1d", "macro_oil_delta5d",
        ]
        df_m_clean = df_m[[c for c in macro_keep_cols if c in df_m.columns]].sort_values("date")
        buckets = pd.merge_asof(
            buckets.sort_values("time_bucket"),
            df_m_clean,
            left_on="date_key",
            right_on="date",
            direction="backward",
        ).drop(columns=["date_key", "date"])

    # 6. Chronological split with embargo -----------------------------------
    buckets = buckets.sort_values("time_bucket").reset_index(drop=True)
    n_total = len(buckets)
    n_train = int(n_total * train_ratio)
    n_val = int(n_total * val_ratio)
    n_val = min(n_val, n_total - n_train)
    t_train_end = buckets.iloc[n_train]["time_bucket"]
    t_val_end = buckets.iloc[n_train + n_val]["time_bucket"]
    embargo_delta = pd.Timedelta(hours=embargo_hours)

    splits = []
    for _, row in buckets.iterrows():
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
    buckets["split"] = splits

    # 7. TF-IDF fitted strictly on train ------------------------------------
    buckets["text_full"] = buckets["title"].fillna("") + " " + buckets["summary"].fillna("")
    train_mask = buckets["split"] == "train"
    train_texts = buckets.loc[train_mask, "text_full"]
    train_texts = train_texts[train_texts.str.strip().str.len() > 0]
    if train_texts.empty:
        # Berita belum ada di periode training (mis. RSS hanya ~14 hari terakhir
        # dan jatuh di split test). Fitur teks dilewati, bukan diisi karangan.
        print("[PriceBuckets] Tidak ada teks berita di train; fitur TF-IDF dilewati.")
    else:
        tfidf = TfidfVectorizer(
            max_features=tfidf_max_features, ngram_range=(1, 2), stop_words="english", lowercase=True
        )
        tfidf.fit(train_texts)
        tfidf_mat = tfidf.transform(buckets["text_full"]).toarray()
        tfidf_cols = [f"tfidf_{i}" for i in range(tfidf_mat.shape[1])]
        df_tfidf = pd.DataFrame(tfidf_mat, columns=tfidf_cols, index=buckets.index)
        buckets = pd.concat([buckets, df_tfidf], axis=1)

    # 8. Direction / provenance ---------------------------------------------
    buckets["sign_4h"] = np.sign(buckets["ret_4h"]).astype(int)
    buckets["sign_24h"] = np.sign(buckets["ret_24h"]).astype(int)
    buckets["direction_4h"] = buckets["sign_4h"]
    buckets["direction_24h"] = buckets["sign_24h"]
    buckets["binary_direction_4h"] = (buckets["ret_4h"] > 0).astype(int)
    buckets["binary_direction_24h"] = (buckets["ret_24h"] > 0).astype(int)
    buckets["overall_sentiment_score"] = buckets["sentiment_score"]
    buckets["is_event_window"] = buckets["has_event"]
    buckets["event_name"] = buckets["related_event"]
    buckets["data_source"] = (
        "yfinance GC=F | rss_feeds+vader | bls_api_v2+fred_csv | yfinance ^TNX/DX-Y.NYB/CL=F"
    )
    buckets["generated_at"] = pd.Timestamp.now(tz="UTC").strftime("%Y-%m-%d %H:%M:%S+00:00")

    os.makedirs(os.path.dirname(output_parquet), exist_ok=True)
    buckets.to_parquet(output_parquet, index=False)
    print(
        f"[PriceBuckets] Output saved: {output_parquet} "
        f"({len(buckets)} rows, {len(buckets.columns)} cols). "
        f"Split counts: {dict(buckets['split'].value_counts())}"
    )
    return buckets


if __name__ == "__main__":
    build_price_history_buckets()
