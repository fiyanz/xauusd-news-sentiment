"""Shared keyless data-source clients with on-disk caching.

Every client here talks to a public, keyless endpoint and caches raw responses
under ``data/cache/`` so repeated pipeline runs do not hammer the provider
(BLS API v2 allows only 25 queries/day without a key).
"""

import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
import requests

CACHE_DIR = Path("data/cache")
DEFAULT_TIMEOUT = 45
USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"


def utc_now() -> str:
    """Current UTC timestamp in the canonical CSV format used across artifacts."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S+00:00")


def _cache_path(name: str) -> Path:
    return CACHE_DIR / name


def _read_json_cache(name: str, max_age_hours: float | None = None) -> object | None:
    """Return a cached JSON payload, or None if missing / stale / corrupt."""
    path = _cache_path(name)
    if not path.exists():
        return None
    if max_age_hours is not None:
        age_h = (time.time() - path.stat().st_mtime) / 3600.0
        if age_h > max_age_hours:
            return None
    try:
        with open(path, "r") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return None


# Backwards-compatible alias for callers that used the dict-typed name.
read_cache = _read_json_cache  # noqa: N816  (kept for compatibility)


def _read_fred_cache(name: str, max_age_hours: float | None = None) -> list[dict] | None:
    """FRED cache stores rows as JSON: {"rows": [{"observation_date":..., "value":...}]}."""
    payload = _read_json_cache(name, max_age_hours=max_age_hours)
    if payload is None:
        return None
    if isinstance(payload, dict):
        payload = payload.get("rows")
    if isinstance(payload, list):
        return payload
    return None


def _read_bls_cache(name: str, max_age_hours: float | None = None) -> dict | None:
    payload = _read_json_cache(name, max_age_hours=max_age_hours)
    return payload if isinstance(payload, dict) else None


def write_cache(name: str, payload) -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    path = _cache_path(name)
    with open(path, "w") as f:
        json.dump(payload, f)
    print(f"[DataSource] cached {path}")


# --------------------------------------------------------------------------- #
# BLS Public API v2 (no key required)
# --------------------------------------------------------------------------- #
BLS_URL = "https://api.bls.gov/publicAPI/v2/timeseries/data/"
BLS_MAX_SPAN_YEARS = 10  # API v2 hard limit without a registration key


def fetch_bls_series(
    series_id: str,
    start_year: int,
    end_year: int,
    cache_max_age_hours: float | None = None,
) -> tuple[pd.DataFrame, str]:
    """Fetch a BLS time series, cached per series.

    Returns ``(monthly_dataframe, status)`` where status is ``"ok"`` or
    ``"unavailable: <reason>"``. The dataframe has columns ``year``, ``month``,
    ``value`` and is sorted ascending; it is empty when the source failed.
    """
    cache_name = f"bls_{series_id}.json"
    cached = _read_bls_cache(cache_name, max_age_hours=cache_max_age_hours)
    if cached is not None:
        print(f"[DataSource] BLS {series_id}: using cache {cache_name}")
        return _bls_to_frame(cached, series_id), "ok"

    rows: list[dict] = []
    status = "ok"
    # Chunk into <=10-year windows to respect the API v2 limit.
    for chunk_start in range(start_year, end_year + 1, BLS_MAX_SPAN_YEARS):
        chunk_end = min(chunk_start + BLS_MAX_SPAN_YEARS - 1, end_year)
        payload = {
            "seriesid": [series_id],
            "startyear": str(chunk_start),
            "endyear": str(chunk_end),
        }
        try:
            resp = requests.post(BLS_URL, json=payload, timeout=DEFAULT_TIMEOUT)
            resp.raise_for_status()
            body = resp.json()
        except Exception as exc:  # network / HTTP / JSON
            print(f"[DataSource] BLS {series_id} failed: {exc}")
            status = f"unavailable: {exc}"
            break

        if body.get("status") != "REQUEST_SUCCEEDED":
            msg = body.get("message") or body.get("status")
            print(f"[DataSource] BLS {series_id} rejected: {msg}")
            status = f"unavailable: {msg}"
            break

        for s in body.get("Results", {}).get("series", []):
            for item in s.get("data", []):
                period = item.get("period", "")
                if not period.startswith("M"):
                    continue
                try:
                    rows.append(
                        {
                            "year": int(item["year"]),
                            "month": int(period[1:]),
                            "value": float(item["value"]),
                        }
                    )
                except (TypeError, ValueError):
                    # BLS uses "-" for suppressed observations.
                    continue

    if status == "ok" and rows:
        write_cache(cache_name, {"seriesid": series_id, "rows": rows})

    if not rows:
        status = status if status != "ok" else "unavailable: empty response"
        return pd.DataFrame(columns=["year", "month", "value"]), status

    return _bls_to_frame({"seriesid": series_id, "rows": rows}, series_id), status


def _bls_to_frame(payload: dict, series_id: str) -> pd.DataFrame:
    df = pd.DataFrame(payload.get("rows", []))
    if df.empty:
        return df
    df = df.drop_duplicates(subset=["year", "month"]).sort_values(["year", "month"]).reset_index(drop=True)
    df.attrs["seriesid"] = series_id
    return df


# --------------------------------------------------------------------------- #
# FRED public CSV (no key required)
# --------------------------------------------------------------------------- #
FRED_CSV_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id={series}"


def fetch_fred_series(
    series_id: str,
    cache_max_age_hours: float | None = None,
) -> tuple[pd.DataFrame, str]:
    """Fetch a FRED series as a daily dataframe ``observation_date, value``.

    Returns ``(df, status)``; df is empty when unavailable.
    """
    cache_name = f"fred_{series_id}.csv"
    cached = _read_fred_cache(cache_name, max_age_hours=cache_max_age_hours)
    if cached is not None:
        print(f"[DataSource] FRED {series_id}: using cache {cache_name}")
        return _fred_to_frame(cached, series_id), "ok"

    try:
        df = pd.read_csv(
            FRED_CSV_URL.format(series=series_id),
            na_values=["."],
            dtype={"observation_date": str},
        )
    except Exception as exc:
        print(f"[DataSource] FRED {series_id} failed: {exc}")
        return pd.DataFrame(columns=["observation_date", "value"]), f"unavailable: {exc}"

    if df.empty or len(df.columns) < 2:
        return pd.DataFrame(columns=["observation_date", "value"]), "unavailable: empty response"

    df = df.rename(columns={df.columns[1]: "value"})
    df["observation_date"] = pd.to_datetime(df["observation_date"], errors="coerce")
    df["value"] = pd.to_numeric(df["value"], errors="coerce")
    df = df.dropna(subset=["observation_date"]).sort_values("observation_date").reset_index(drop=True)

    if df.empty:
        return df, "unavailable: no numeric observations"

    records = [
        {"observation_date": d.strftime("%Y-%m-%d"), "value": (None if pd.isna(v) else float(v))}
        for d, v in zip(df["observation_date"], df["value"])
    ]
    write_cache(cache_name, {"rows": records})
    return df, "ok"


def _fred_to_frame(records: list[dict] | dict, series_id: str) -> pd.DataFrame:
    if isinstance(records, dict):
        records = [records]
    df = pd.DataFrame(records)
    if df.empty:
        return pd.DataFrame(columns=["observation_date", "value"])
    df["observation_date"] = pd.to_datetime(df["observation_date"], errors="coerce")
    df["value"] = pd.to_numeric(df["value"], errors="coerce")
    return df.dropna(subset=["observation_date"]).sort_values("observation_date").reset_index(drop=True)
