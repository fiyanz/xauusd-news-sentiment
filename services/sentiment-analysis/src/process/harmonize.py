"""Data harmonization, merge_asof alignment, and dynamic rolling volatility labeling engine."""

import json
import os
from pathlib import Path
import numpy as np
import pandas as pd
import yaml


def load_config() -> dict:
    config_path = Path("config.yaml")
    if not config_path.exists():
        config_path = Path("services/sentiment-analysis/config.yaml")
    with open(config_path, "r") as f:
        return yaml.safe_load(f)


def calculate_labels(return_val: float, threshold: float) -> int:
    """Label mapping: +1 (Naik), -1 (Turun), 0 (Datar)."""
    if np.isnan(return_val) or np.isnan(threshold) or threshold <= 0:
        return 0
    if return_val > threshold:
        return 1
    elif return_val < -threshold:
        return -1
    return 0


def harmonize_dataset(
    price_path: str = "data/raw/price/xauusd_h1_complete.csv",
    news_path: str = "data/raw/news/news_sentiment_feed.json",
    calendar_path: str = "data/raw/calendar/economic_calendar_enriched.csv",
    output_dir: str = "data/processed",
    threshold_k: float = 0.5,
    vol_lookback_days: int = 20,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Align news with price candles using merge_asof, calculate forward returns, and compute labels."""
    os.makedirs(output_dir, exist_ok=True)
    print("[Harmonize] Loading price, calendar, and news data...")

    # 1. Load price
    df_price = pd.read_csv(price_path)
    df_price["time"] = pd.to_datetime(df_price["time"], utc=True)
    df_price = df_price.sort_values("time").drop_duplicates(subset=["time"]).reset_index(drop=True)

    # Compute hourly return and rolling volatility (20 days * 24 hours = 480 hours)
    df_price["hourly_ret"] = df_price["close"].pct_change()
    lookback_hours = vol_lookback_days * 24
    # Shift by 1 hour to guarantee zero look-ahead: volatility at t0 uses only data up to t0-1h
    df_price["rolling_vol"] = (
        df_price["hourly_ret"]
        .shift(1)
        .rolling(window=lookback_hours, min_periods=48)
        .std()
    )
    # Default fallback volatility ~0.35% per hour if insufficient lookback
    default_vol = float(df_price["hourly_ret"].std()) if not np.isnan(df_price["hourly_ret"].std()) else 0.0035
    df_price["rolling_vol"] = df_price["rolling_vol"].fillna(default_vol)

    # 2. Load calendar for event window markers
    df_cal = pd.read_csv(calendar_path)
    df_cal["timestamp_utc"] = pd.to_datetime(df_cal["timestamp_utc"], utc=True)
    calendar_is_simulated = bool(df_cal["is_simulated"].all()) if "is_simulated" in df_cal.columns else False

    # 3. Load news. Accept both the legacy bare list and the provenance envelope
    # {"status": ..., "articles": [...]}.
    with open(news_path, "r") as f:
        news_data = json.load(f)
    if isinstance(news_data, dict):
        articles = news_data.get("articles", [])
        news_status = news_data.get("status", "ok" if articles else "unavailable")
        news_generated_at = news_data.get("generated_at")
    else:
        articles = news_data
        news_status = "ok" if articles else "unavailable"
        news_generated_at = None
    if not articles:
        print(f"[Harmonize] WARNING: news feed unavailable/empty (status={news_status}); no articles to align.")
        articles = []
    df_news = pd.DataFrame(articles)
    if df_news.empty:
        df_news["time_published_utc"] = pd.Series(dtype="datetime64[ns, UTC]")
    else:
        df_news["time_published_utc"] = pd.to_datetime(df_news["time_published_utc"], utc=True)
    df_news = df_news.sort_values("time_published_utc").reset_index(drop=True)

    print(f"[Harmonize] Processing {len(df_news)} news articles with merge_asof...")

    # Merge asof backward: match news at t0 with the latest available H1 candle
    df_merged = pd.merge_asof(
        df_news,
        df_price[["time", "close", "rolling_vol"]].rename(
            columns={"time": "candle_time", "close": "p0", "rolling_vol": "vol_pre"}
        ),
        left_on="time_published_utc",
        right_on="candle_time",
        direction="backward",
        tolerance=pd.Timedelta(hours=2),
    )

    # Drop articles without nearby candle
    df_merged = df_merged.dropna(subset=["p0"]).reset_index(drop=True)

    # When the news feed is empty/unavailable, carry explicit provenance so the
    # derived dataset can never be mistaken for a complete observation of news.
    news_is_simulated = int(news_status != "ok" or not articles or calendar_is_simulated)
    if df_merged.empty:
        df_merged["is_simulated"] = 1
        df_merged["news_status"] = news_status
    else:
        df_merged["is_simulated"] = news_is_simulated
        df_merged["news_status"] = news_status

    # Forward price matching helper
    # Prepare forward lookup tables
    price_series = df_price.set_index("time")["close"]

    ret_1h, ret_4h, ret_24h = [], [], []
    label_1h, label_4h, label_24h = [], [], []
    is_event_window = []

    cal_times = df_cal["timestamp_utc"].values

    for _, row in df_merged.iterrows():
        t0 = row["time_published_utc"]
        p0 = row["p0"]
        vol = row["vol_pre"]
        thresh = threshold_k * vol

        # Future timestamps
        t_1h = t0 + pd.Timedelta(hours=1)
        t_4h = t0 + pd.Timedelta(hours=4)
        t_24h = t0 + pd.Timedelta(hours=24)

        # Nearest future candle prices
        idx_1h = price_series.index.searchsorted(t_1h)
        idx_4h = price_series.index.searchsorted(t_4h)
        idx_24h = price_series.index.searchsorted(t_24h)

        p_1h = price_series.iloc[min(idx_1h, len(price_series) - 1)] if idx_1h < len(price_series) else p0
        p_4h = price_series.iloc[min(idx_4h, len(price_series) - 1)] if idx_4h < len(price_series) else p0
        p_24h = price_series.iloc[min(idx_24h, len(price_series) - 1)] if idx_24h < len(price_series) else p0

        r1 = float((p_1h - p0) / p0)
        r4 = float((p_4h - p0) / p0)
        r24 = float((p_24h - p0) / p0)

        ret_1h.append(r1)
        ret_4h.append(r4)
        ret_24h.append(r24)

        label_1h.append(calculate_labels(r1, thresh))
        label_4h.append(calculate_labels(r4, thresh))
        label_24h.append(calculate_labels(r24, thresh))

        # Check if t0 is within 2 hours of any high-impact event.
        # Guard against an empty calendar (no events -> no event window).
        if len(cal_times) == 0:
            in_event = 0
        else:
            min_diff = np.min(np.abs(cal_times - t0.to_datetime64()))
            in_event = int(min_diff <= np.timedelta64(2, "h"))
        is_event_window.append(in_event)

    df_merged["ret_1h"] = ret_1h
    df_merged["ret_4h"] = ret_4h
    df_merged["ret_24h"] = ret_24h
    df_merged["label_1h"] = label_1h
    df_merged["label_4h"] = label_4h
    df_merged["label_24h"] = label_24h
    df_merged["is_event_window"] = is_event_window

    # Add hour of day and session
    df_merged["hour_utc"] = df_merged["time_published_utc"].dt.hour

    def assign_session(h: int) -> str:
        if 0 <= h < 7:
            return "Asia"
        elif 7 <= h < 13:
            return "London"
        else:
            return "NewYork"

    df_merged["session"] = df_merged["hour_utc"].apply(assign_session)

    # Variant 1: Per-article dataset
    article_path = os.path.join(output_dir, "dataset_article.parquet")
    df_merged.to_parquet(article_path, index=False)
    print(f"[Harmonize] Saved article dataset to {article_path} ({len(df_merged)} rows).")

    # Variant 2: Per-hourly aggregated dataset
    df_merged["hour_bin"] = df_merged["time_published_utc"].dt.floor("1h")
    df_hourly = (
        df_merged.groupby("hour_bin")
        .agg(
            article_count=("id", "count"),
            avg_sentiment=("overall_sentiment_score", "mean"),
            min_sentiment=("overall_sentiment_score", "min"),
            max_sentiment=("overall_sentiment_score", "max"),
            p0=("p0", "first"),
            vol_pre=("vol_pre", "first"),
            ret_1h=("ret_1h", "first"),
            ret_4h=("ret_4h", "first"),
            ret_24h=("ret_24h", "first"),
            label_1h=("label_1h", "first"),
            label_4h=("label_4h", "first"),
            label_24h=("label_24h", "first"),
            is_event_window=("is_event_window", "max"),
            session=("session", "first"),
        )
        .reset_index()
    )
    hourly_path = os.path.join(output_dir, "dataset_hourly.parquet")
    df_hourly.to_parquet(hourly_path, index=False)
    print(f"[Harmonize] Saved hourly aggregated dataset to {hourly_path} ({len(df_hourly)} rows).")

    return df_merged, df_hourly


if __name__ == "__main__":
    cfg = load_config()
    harmonize_dataset(
        price_path=cfg["data"]["price_file_complete"],
        news_path=os.path.join(cfg["data"]["news_dir_raw"], "news_sentiment_feed.json"),
        calendar_path=cfg["data"]["calendar_file_complete"],
        output_dir=cfg["data"]["processed_dir"],
        threshold_k=cfg["label"]["threshold_k"],
        vol_lookback_days=cfg["label"]["vol_lookback_days"],
    )
