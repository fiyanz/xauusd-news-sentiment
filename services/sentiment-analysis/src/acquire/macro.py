"""Point-in-Time Macro Context Acquisition Engine (US10Y, DXY, WTI Oil).

Downloads daily macro drivers from Yahoo Finance, enforces zero-lookahead
point-in-time lagging (shift 1 day), and computes short-horizon change deltas.

Fallback policy: when a download fails the series stays ``NaN`` and the row is
marked ``is_simulated = true`` / ``macro_status = "unavailable"``. The previous
implementation silently substituted a random-walk series; that is gone.
"""

import os
import sys
from pathlib import Path

# Prevent directory from shadowing standard library modules
_script_dir = str(Path(__file__).resolve().parent)
if sys.path and sys.path[0] == _script_dir:
    sys.path.pop(0)

import numpy as np
import pandas as pd
import yfinance as yf
import yaml


def load_config() -> dict:
    """Load configuration from config.yaml."""
    config_path = Path("config.yaml")
    if not config_path.exists():
        config_path = Path("services/sentiment-analysis/config.yaml")
    with open(config_path, "r") as f:
        return yaml.safe_load(f)


def _download_series_yf(ticker: str, start_date: str = "2009-12-01", end_date: str | None = None) -> pd.Series:
    """Download single ticker closing price series via yfinance with error handling."""
    print(f"[Macro] Downloading {ticker} from {start_date}...")
    try:
        df = yf.download(ticker, start=start_date, end=end_date, progress=False)
        if df.empty:
            raise ValueError(f"Empty data returned for ticker {ticker}")

        if isinstance(df.columns, pd.MultiIndex):
            if "Close" in df.columns.levels[0]:
                close_df = df["Close"]
                if ticker in close_df.columns:
                    s = close_df[ticker]
                else:
                    s = close_df.iloc[:, 0]
            else:
                s = df.iloc[:, 0]
        elif "Close" in df.columns:
            s = df["Close"]
        else:
            s = df.iloc[:, 0]

        s = pd.to_numeric(s, errors="coerce").dropna()
        s.index = pd.to_datetime(s.index, utc=True).normalize()
        s = s[~s.index.duplicated(keep="last")]
        return s.sort_index()

    except Exception as e:
        print(f"[Macro] Warning: yfinance download failed for {ticker}: {e}")
        return pd.Series(dtype=float)


def fetch_and_align_macro_data(
    tickers: dict[str, str] | None = None,
    start_date: str = "2010-01-01",
    end_date: str | None = None,
    output_path: str = "data/raw/macro/macro_context.csv",
    lag_days: int = 1,
) -> pd.DataFrame:
    """Acquire, align, compute deltas, and PIT-shift macro series.

    Zero-lookahead: features at date T only contain information from T - lag_days.
    Failed series are kept as NaN with ``is_simulated = True`` — never filled
    with synthetic values.
    """
    if tickers is None:
        tickers = {
            "us10y": "^TNX",
            "dxy": "DX-Y.NYB",
            "oil": "CL=F",
        }

    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    # Default to "today" so the artifact is never stale by construction.
    end_dt = pd.Timestamp(end_date, tz="UTC") if end_date else pd.Timestamp.now(tz="UTC")
    end_iso = end_dt.strftime("%Y-%m-%d")

    # Pre-buffer by 35 days so delta_5d and shift(1) have no NaNs on start_date
    pre_buffer_start = (pd.to_datetime(start_date, utc=True) - pd.Timedelta(days=35)).strftime("%Y-%m-%d")

    raw_series: dict[str, pd.Series] = {}
    series_status: dict[str, str] = {}
    for name, ticker in tickers.items():
        # yfinance `end` is exclusive; add a day so the requested end is included.
        end_iso = (end_dt + pd.Timedelta(days=1)).strftime("%Y-%m-%d")
        s = _download_series_yf(ticker, start_date=pre_buffer_start, end_date=end_iso)
        raw_series[name] = s
        series_status[name] = "ok" if not s.empty else "unavailable: download failed"

    # Determine master calendar dates (business days)
    valid_dates = [s.index.max() for s in raw_series.values() if not s.empty]
    max_dt = max(valid_dates) if valid_dates else end_dt.normalize()
    min_dt = pd.to_datetime(pre_buffer_start, utc=True)

    master_dates = pd.bdate_range(start=min_dt, end=max_dt, tz="UTC")

    aligned_raw: dict[str, pd.Series] = {}
    for name in tickers:
        s = raw_series[name]
        if s.empty:
            print(f"[Macro] {name}: source unavailable — leaving NaN and marking is_simulated.")
            aligned = pd.Series(np.nan, index=master_dates, name=name)
        else:
            aligned = s.reindex(master_dates)
            # Forward-fill only *observed* values; do not backfill before the
            # first real observation (that would invent history).
            aligned = aligned.ffill()
        aligned_raw[name] = aligned

    df_features = pd.DataFrame(index=master_dates)

    for name in tickers:
        s_raw = aligned_raw[name]
        is_sim = s_raw.isna()

        df_features[f"{name}_raw_close"] = s_raw
        df_features[f"{name}_is_simulated"] = is_sim.astype(int)

        delta_1d = s_raw.diff(1)
        delta_5d = s_raw.diff(5)

        df_features[f"{name}_close"] = s_raw.shift(lag_days)
        df_features[f"{name}_delta_1d"] = delta_1d.shift(lag_days)
        df_features[f"{name}_delta_5d"] = delta_5d.shift(lag_days)

        df_features[f"macro_{name}_lag1d"] = df_features[f"{name}_close"]
        df_features[f"macro_{name}_delta1d"] = df_features[f"{name}_delta_1d"]
        df_features[f"macro_{name}_delta5d"] = df_features[f"{name}_delta_5d"]

    # Row-level provenance flag: True when any underlying source was unavailable.
    df_features["is_simulated"] = df_features[[f"{n}_is_simulated" for n in tickers]].max(axis=1).astype(int)
    df_features["macro_status"] = np.where(
        df_features["is_simulated"] == 1, "unavailable", "ok"
    )

    start_dt = pd.to_datetime(start_date, utc=True)
    df_sliced = df_features[df_features.index >= start_dt].copy()

    df_sliced = df_sliced.reset_index(names=["date"])
    df_sliced["date"] = df_sliced["date"].dt.strftime("%Y-%m-%d %H:%M:%S+00:00")

    df_sliced.to_csv(output_path, index=False)
    n_sim = int(df_sliced["is_simulated"].sum())
    print(
        f"[Macro] Point-in-time macro context saved: {output_path} "
        f"({len(df_sliced)} rows, {n_sim} simulated/unavailable)."
    )
    print(f"[Macro] series status: {series_status}")
    return df_sliced


if __name__ == "__main__":
    cfg = load_config()
    m_cfg = cfg.get("macro", {})
    t_map = m_cfg.get("tickers", {"us10y": "^TNX", "dxy": "DX-Y.NYB", "oil": "CL=F"})
    s_date = m_cfg.get("start_date", "2010-01-01")
    e_date = m_cfg.get("end_date")  # None -> today
    out = m_cfg.get("output_file", "data/raw/macro/macro_context.csv")
    lag = m_cfg.get("lag_days", 1)

    fetch_and_align_macro_data(
        tickers=t_map,
        start_date=s_date,
        end_date=e_date,
        output_path=out,
        lag_days=lag,
    )
