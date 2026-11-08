"""XAUUSD price acquisition: H1 history patching plus real intraday 5m/15m.

Keyless sources:
- Historical H1: local CSV (no network).
- Recent H1 and intraday 5m/15m: Yahoo Finance ``GC=F`` via yfinance.

Intraday artifacts ``data/raw/price/xauusd_m5.csv`` and ``xauusd_m15.csv`` carry
an ``is_real`` flag (1 = real exchange data, 0 = estimated/derived).
"""

import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Prevent directory from shadowing standard library modules
_script_dir = str(Path(__file__).resolve().parent)
if sys.path and sys.path[0] == _script_dir:
    sys.path.pop(0)

import pandas as pd
import yfinance as yf
import yaml

INTRADAY_INTERVALS = {"m5": "5m", "m15": "15m"}
INTRADAY_CACHE_HOURS = 6


def load_config() -> dict:
    config_path = Path("config.yaml")
    if not config_path.exists():
        config_path = Path("services/sentiment-analysis/config.yaml")
    with open(config_path, "r") as f:
        return yaml.safe_load(f)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _to_utc(index: pd.DatetimeIndex) -> pd.DatetimeIndex:
    """Normalise a yfinance index to tz-aware UTC.

    yfinance returns tz-aware indices for intraday data and tz-naive for daily
    data. ``tz_convert`` on a naive index raises, so localise first.
    """
    if index.tz is None:
        return index.tz_localize("UTC")
    return index.tz_convert("UTC")


def _flatten_yf_columns(df: pd.DataFrame) -> pd.DataFrame:
    """Collapse yfinance's MultiIndex columns (Price, Ticker) to lowercase names."""
    if isinstance(df.columns, pd.MultiIndex):
        df = df.copy()
        df.columns = [str(c[0]).lower() for c in df.columns]
    else:
        df = df.copy()
        df.columns = [str(c).lower() for c in df.columns]
    return df


def refresh_price_data(
    raw_path: str | None = None,
    output_path: str = "data/raw/price/xauusd_h1_complete.csv",
    end_date: str | None = None,
) -> pd.DataFrame:
    """Load historical H1 candles, patch missing recent candles, and save unified UTC CSV.

    ``raw_path`` wajib diset lewat config (``data.price_file_raw``) atau env
    ``EXTERNAL_DATA_DIR``. Tidak ada path hardcoded.
    """
    if not raw_path:
        raise ValueError(
            "raw_path kosong: set 'data.price_file_raw' di config.yaml "
            "atau env EXTERNAL_DATA_DIR."
        )
    if not os.path.exists(raw_path):
        raise FileNotFoundError(f"H1 source CSV not found: {raw_path}")

    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    print(f"[Price] Loading historical prices from {raw_path}...")
    df_raw = pd.read_csv(raw_path)
    df_raw["time"] = pd.to_datetime(df_raw["time"], utc=True)
    df_raw = df_raw.sort_values("time").drop_duplicates(subset=["time"]).reset_index(drop=True)

    last_time = df_raw["time"].max()
    print(f"[Price] Last historical candle: {last_time}")

    end_dt = pd.Timestamp(end_date, tz="UTC") if end_date else pd.Timestamp.now(tz="UTC")

    if last_time < end_dt:
        start_str = (last_time + pd.Timedelta(hours=1)).strftime("%Y-%m-%d")
        end_str = (end_dt + pd.Timedelta(days=1)).strftime("%Y-%m-%d")
        print(f"[Price] Fetching gap candles from {start_str} to {end_str}...")
        try:
            yf_df = yf.download("GC=F", start=start_str, end=end_str, interval="1h", progress=False)
            if yf_df is not None and not yf_df.empty:
                yf_df = _flatten_yf_columns(yf_df)
                yf_df.index = _to_utc(yf_df.index)
                yf_df = yf_df.reset_index()
                date_col = "Datetime" if "Datetime" in yf_df.columns else "index"
                yf_df = yf_df.rename(columns={date_col: "time"})
                if "spread" not in yf_df.columns:
                    yf_df["spread"] = 0.50
                yf_df = yf_df[yf_df["time"] > last_time]

                cols = ["time", "open", "high", "low", "close", "volume", "spread"]
                yf_df = yf_df[[c for c in cols if c in yf_df.columns]]
                if "spread" not in yf_df.columns:
                    yf_df["spread"] = 0.50

                print(f"[Price] Downloaded {len(yf_df)} new H1 candles from Yahoo Finance.")
                df_combined = pd.concat([df_raw, yf_df], ignore_index=True)
            else:
                print("[Price] Yahoo Finance returned empty; using raw dataset.")
                df_combined = df_raw
        except Exception as e:
            print(f"[Price] Warning: Could not fetch from yfinance ({e}); continuing with raw.")
            df_combined = df_raw
    else:
        df_combined = df_raw

    df_combined = df_combined.sort_values("time").drop_duplicates(subset=["time"]).reset_index(drop=True)
    df_combined["time"] = df_combined["time"].dt.strftime("%Y-%m-%d %H:%M:%S+00:00")
    df_combined.to_csv(output_path, index=False)
    print(f"[Price] Complete H1 dataset saved: {output_path} ({len(df_combined)} rows).")
    return df_combined


def _intraday_output_path(key: str) -> str:
    return f"data/raw/price/xauusd_{key}.csv"


def _cache_is_fresh(path: str, max_age_hours: float = INTRADAY_CACHE_HOURS) -> bool:
    if not os.path.exists(path):
        return False
    age_h = (datetime.now(timezone.utc).timestamp() - os.path.getmtime(path)) / 3600.0
    return age_h <= max_age_hours


def refresh_intraday_data(
    output_dir: str = "data/raw/price",
    periods: str = "30d",
    intervals: dict[str, str] | None = None,
    force: bool = False,
    cache_hours: float = INTRADAY_CACHE_HOURS,
) -> dict[str, pd.DataFrame]:
    """Download real GC=F intraday candles for each interval.

    Writes ``xauusd_m5.csv`` / ``xauusd_m15.csv`` with columns
    ``time,open,high,low,close,volume,is_real``. Files younger than
    ``cache_hours`` are left untouched. Returns ``{key: dataframe}`` where the
    dataframe is empty when the download failed.
    """
    intervals = intervals or INTRADAY_INTERVALS
    os.makedirs(output_dir, exist_ok=True)
    results: dict[str, pd.DataFrame] = {}

    for key, yf_interval in intervals.items():
        out_path = os.path.join(output_dir, f"xauusd_{key}.csv")

        if not force and _cache_is_fresh(out_path, cache_hours):
            print(f"[Price] Intraday {key} cache fresh (<{cache_hours}h); skipping download.")
            existing = pd.read_csv(out_path)
            results[key] = existing
            continue

        print(f"[Price] Downloading GC=F {yf_interval} ({periods}) from Yahoo Finance...")
        try:
            df = yf.download("GC=F", period=periods, interval=yf_interval, progress=False, auto_adjust=False)
        except Exception as exc:
            print(f"[Price] Warning: intraday {key} download failed: {exc}")
            results[key] = pd.DataFrame(columns=["time", "open", "high", "low", "close", "volume", "is_real"])
            continue

        if df is None or df.empty:
            print(f"[Price] Warning: intraday {key} returned no data.")
            results[key] = pd.DataFrame(columns=["time", "open", "high", "low", "close", "volume", "is_real"])
            continue

        df = _flatten_yf_columns(df)
        df.index = _to_utc(df.index)
        df = df.reset_index()
        date_col = "Datetime" if "Datetime" in df.columns else "index"
        df = df.rename(columns={date_col: "time"})

        out = pd.DataFrame(
            {
                "time": df["time"].dt.strftime("%Y-%m-%d %H:%M:%S+00:00"),
                "open": pd.to_numeric(df["open"], errors="coerce"),
                "high": pd.to_numeric(df["high"], errors="coerce"),
                "low": pd.to_numeric(df["low"], errors="coerce"),
                "close": pd.to_numeric(df["close"], errors="coerce"),
                "volume": pd.to_numeric(df["volume"], errors="coerce"),
                "is_real": 1,
            }
        ).dropna(subset=["close"]).reset_index(drop=True)

        out.to_csv(out_path, index=False)
        print(f"[Price] Saved {len(out)} real {key} candles to {out_path}.")
        results[key] = out

    return results


def write_price_provenance(
    h1_csv: str = "data/raw/price/xauusd_h1_complete.csv",
    intraday_dir: str = "data/raw/price",
) -> dict:
    """Build the price entry of the provenance manifest."""
    provenance: dict = {"artifacts": {}}

    h1 = pd.read_csv(h1_csv)
    provenance["artifacts"][h1_csv] = {
        "artifact": h1_csv,
        "source": "local H1 CSV + yfinance GC=F (keyless)",
        "rows": int(len(h1)),
        "as_of": str(h1["time"].iloc[-1]),
        "is_simulated": False,
    }

    for key in INTRADAY_INTERVALS:
        path = os.path.join(intraday_dir, f"xauusd_{key}.csv")
        if os.path.exists(path):
            df = pd.read_csv(path)
            provenance["artifacts"][path] = {
                "artifact": path,
                "source": "yfinance GC=F (keyless)",
                "generated_at": datetime.fromtimestamp(
                    os.path.getmtime(path), tz=timezone.utc
                ).strftime("%Y-%m-%d %H:%M:%S+00:00"),
                "as_of": str(df["time"].iloc[-1]) if len(df) else None,
                "is_simulated": False,
                "rows": int(len(df)),
                "is_real": 1,
            }
        else:
            provenance["artifacts"][path] = {
                "artifact": path,
                "source": "yfinance GC=F (keyless)",
                "status": "unavailable",
                "is_simulated": True,
            }

    provenance["generated_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S+00:00")
    provenance["is_simulated"] = all(v.get("is_simulated") for v in provenance["artifacts"].values())
    return provenance


if __name__ == "__main__":
    cfg = load_config()
    raw = cfg["data"].get("price_file_raw")
    out = cfg["data"]["price_file_complete"]
    if not raw:
        raise SystemExit("data.price_file_raw tidak diset di config.yaml")
    refresh_price_data(raw, out)
    refresh_intraday_data()
