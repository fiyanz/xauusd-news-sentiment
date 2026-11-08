"""Economic calendar acquisition with REAL keyless macro actuals.

Replaces the previous synthetic generator (``rng.normal`` over hardcoded
``EVENT_PARAMS``). Actuals come from public, keyless sources:

- CPI m/m            -> BLS API v2 series ``CUSR0000SA0`` (index -> % m/m)
- Core CPI m/m       -> BLS API v2 series ``CUSR0000SA0L1E``
- Non-Farm Payrolls  -> BLS API v2 series ``CES0000000001`` (thousands -> K)
- Core PCE m/m       -> FRED public CSV ``PCEPILFE`` (index -> % m/m)
- FOMC rate decision -> FRED public CSV ``DFEDTARU``/``DFEDTARL`` (range change)

Consensus forecasts have no reliable keyless source, so ``forecast`` is null and
the surprise is computed as ``actual - previous`` (method ``actual_minus_previous``).

Rows that could not be filled from a real source are kept with null numeric
fields and ``is_simulated = true`` (``source = "simulated"``) — never with
invented numbers.
"""

import json
import os
import sys
from datetime import date, datetime, timezone
from pathlib import Path

# Prevent directory from shadowing standard library modules
_script_dir = str(Path(__file__).resolve().parent)
if sys.path and sys.path[0] == _script_dir:
    sys.path.pop(0)

import pandas as pd
import yaml

from src.acquire.data_sources import fetch_bls_series, fetch_fred_series, utc_now

# BLS series -> event mapping. Unit is expressed as "index" (needs a derivative)
# or "level" (already in reporting units).
SERIES_REGISTRY: dict[str, dict] = {
    "CUSR0000SA0": {
        "source": "bls_api_v2",
        "label": "US CPI All Items (SA, index)",
        "transform": "mom_pct",
    },
    "CUSR0000SA0L1E": {
        "source": "bls_api_v2",
        "label": "US Core CPI (SA, index)",
        "transform": "mom_pct",
    },
    "CES0000000001": {
        "source": "bls_api_v2",
        "label": "US Nonfarm Payrolls (thousands)",
        "transform": "level",
        "scale": 1000.0,  # BLS reports level in thousands; reporting unit is K
    },
    "PCEPILFE": {
        "source": "fred_csv",
        "label": "US Core PCE Price Index (index)",
        "transform": "mom_pct",
    },
    "DFEDTARU": {
        "source": "fred_csv",
        "label": "FOMC Target Range Upper Bound",
        "transform": "level",
    },
}

# Event name -> (primary series, transform). FOMC is handled specially from the
# target-range series. EVENT_PARAMS no longer carries fabricated forecasts; it
# only keeps a *historical* dispersion scale used to normalise the surprise.
EVENT_SERIES: dict[str, str] = {
    "Non-Farm Employment Change (NFP)": "CES0000000001",
    "CPI m/m & y/y": "CUSR0000SA0",
    "Core CPI m/m": "CUSR0000SA0L1E",
    "Core PCE Price Index": "PCEPILFE",
}

EVENT_PARAMS = {
    "Non-Farm Employment Change (NFP)": {"unit": "K", "std_dev": 55.0},
    "CPI m/m & y/y": {"unit": "%", "std_dev": 0.15},
    "Core CPI m/m": {"unit": "%", "std_dev": 0.10},
    "Core PCE Price Index": {"unit": "%", "std_dev": 0.12},
    "FOMC Statement & Rate Decision": {"unit": "%", "std_dev": 0.25},
}

FOMC_SERIES = ("DFEDTARU", "DFEDTARL")


def load_config() -> dict:
    config_path = Path("config.yaml")
    if not config_path.exists():
        config_path = Path("services/sentiment-analysis/config.yaml")
    with open(config_path, "r") as f:
        return yaml.safe_load(f)


# --------------------------------------------------------------------------- #
# Source loaders
# --------------------------------------------------------------------------- #
def _load_bls_monthly(series_id: str, start_year: int, end_year: int) -> tuple[dict, str]:
    """Return {(year, month): value} plus a status string."""
    df, status = fetch_bls_series(series_id, start_year, end_year)
    if df.empty:
        return {}, status
    return {(int(r.year), int(r.month)): float(r.value) for r in df.itertuples()}, "ok"


def _load_fred_monthly(series_id: str) -> tuple[dict, str]:
    """Return {(year, month): value} for a monthly FRED series (e.g. PCEPILFE)."""
    df, status = fetch_fred_series(series_id)
    if df.empty:
        return {}, status
    return {
        (d.year, d.month): float(v)
        for d, v in zip(df["observation_date"], df["value"])
        if pd.notna(v)
    }, "ok"


def _load_fred_daily(series_id: str) -> tuple[dict, str]:
    df, status = fetch_fred_series(series_id)
    if df.empty:
        return {}, status
    return {d.normalize(): float(v) for d, v in zip(df["observation_date"], df["value"])}, "ok"


def _mom_pct(values: dict, year: int, month: int) -> float | None:
    """Month-over-month percent change for ``year``-``month`` from an index series."""
    cur = values.get((year, month))
    prev = values.get((year, month - 1)) if month > 1 else values.get((year - 1, 12))
    if cur is None or prev is None or prev == 0:
        return None
    return (cur / prev - 1.0) * 100.0


def _fomc_value(values: dict, year: int, month: int) -> float | None:
    """Most recent FOMC target value at or before mid-month of the release."""
    target = pd.Timestamp(year=year, month=month, day=15)
    keys = [k for k in values if k <= target]
    if not keys:
        return None
    return values[max(keys)]


def _series_status(series_id: str, statuses: dict[str, str]) -> str:
    return statuses.get(series_id, "ok")


# --------------------------------------------------------------------------- #
# Enrichment
# --------------------------------------------------------------------------- #
def enrich_economic_calendar(
    raw_path: str = "/home/kazu/Projects/magang/expert-advisor-trade/data/news_calendar_high_impact.csv",
    output_path: str = "data/raw/calendar/economic_calendar_enriched.csv",
    start_year: int | None = None,
    end_year: int | None = None,
    seed: int | None = None,  # kept for backwards-compatible signatures; unused
) -> pd.DataFrame:
    """Enrich the raw calendar with real actuals from keyless sources.

    Adds provenance columns: ``source``, ``forecast_source``,
    ``surprise_method``, ``is_simulated``.
    """
    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    print(f"[Calendar] Loading calendar from {raw_path}...")
    df = pd.read_csv(raw_path)
    df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True)
    df = df.sort_values("timestamp").reset_index(drop=True)

    min_year = int(df["timestamp"].dt.year.min())
    max_year = int(df["timestamp"].dt.year.max())
    start_year = start_year or min_year
    end_year = end_year or max_year

    # ---- Load sources once (cached) -------------------------------------- #
    statuses: dict[str, str] = {}
    cpi_idx, s = _load_bls_monthly("CUSR0000SA0", start_year, end_year)
    statuses["CUSR0000SA0"] = s
    core_cpi_idx, s = _load_bls_monthly("CUSR0000SA0L1E", start_year, end_year)
    statuses["CUSR0000SA0L1E"] = s
    nfp_level, s = _load_bls_monthly("CES0000000001", start_year, end_year)
    statuses["CES0000000001"] = s
    pce_idx, s = _load_fred_monthly("PCEPILFE")
    statuses["PCEPILFE"] = s
    taru, s = _load_fred_daily("DFEDTARU")
    statuses["DFEDTARU"] = s
    tarl, s = _load_fred_daily("DFEDTARL")
    statuses["DFEDTARL"] = s

    bls_status = "; ".join(f"{k}={statuses[k]}" for k in ("CUSR0000SA0", "CUSR0000SA0L1E", "CES0000000001"))
    fred_status = "; ".join(f"{k}={statuses[k]}" for k in ("PCEPILFE", "DFEDTARU", "DFEDTARL"))
    print(f"[Calendar] BLS: {bls_status}")
    print(f"[Calendar] FRED: {fred_status}")

    enriched_records: list[dict] = []

    for _, row in df.iterrows():
        name = str(row["name"]).strip()
        ts = row["timestamp"]
        currency = row["currency"]
        impact = row["impact"]
        year, month = int(ts.year), int(ts.month)

        params = EVENT_PARAMS.get(name, {"unit": "", "std_dev": 0.5})
        std = float(params["std_dev"])

        actual = None
        previous = None
        source = "unavailable"
        unit = params["unit"]

        if name in EVENT_SERIES:
            series_id = EVENT_SERIES[name]
            meta = SERIES_REGISTRY[series_id]
            status = _series_status(series_id, statuses)
            if status == "ok":
                if series_id == "CUSR0000SA0":
                    actual = _mom_pct(cpi_idx, year, month)
                elif series_id == "CUSR0000SA0L1E":
                    actual = _mom_pct(core_cpi_idx, year, month)
                elif series_id == "CES0000000001":
                    actual = nfp_level.get((year, month))
                    if actual is not None:
                        actual = actual / SERIES_REGISTRY[series_id]["scale"]
                elif series_id == "PCEPILFE":
                    actual = _mom_pct(pce_idx, year, month)

                if actual is not None:
                    source = f"{meta['source']}:{series_id}"
                    prev_year, prev_month = (year, month - 1) if month > 1 else (year - 1, 12)
                    if series_id == "CES0000000001":
                        previous = nfp_level.get((prev_year, prev_month))
                        if previous is not None:
                            previous = previous / SERIES_REGISTRY[series_id]["scale"]
                    elif series_id == "CUSR0000SA0":
                        previous = _mom_pct(cpi_idx, prev_year, prev_month)
                    elif series_id == "CUSR0000SA0L1E":
                        previous = _mom_pct(core_cpi_idx, prev_year, prev_month)
                    else:
                        previous = _mom_pct(pce_idx, prev_year, prev_month)
                else:
                    source = "simulated"
            else:
                source = "simulated"

        elif "FOMC" in name or "Federal Reserve" in name:
            upper = _fomc_value(taru, year, month)
            lower = _fomc_value(tarl, year, month)
            if upper is not None and lower is not None:
                actual = upper
                prev_ts = ts - pd.Timedelta(days=45)
                previous = _fomc_value(taru, int(prev_ts.year), int(prev_ts.month))
                source = "fred_csv:DFEDTARU"
                unit = "%"
            else:
                source = "simulated"
        else:
            source = "simulated"

        actual = None if actual is None else round(float(actual), 4)
        previous = None if previous is None else round(float(previous), 4)

        if actual is None:
            # Explicit unavailable marker — no invented replacement value.
            is_simulated = True
            surprise_val = None
            z_score = None
            forecast = None
            forecast_source = "unavailable"
            surprise_method = "unavailable"
            source = "simulated"
        else:
            is_simulated = False
            forecast = None  # no keyless consensus source
            forecast_source = "unavailable"
            if previous is None:
                surprise_val = None
                z_score = None
                surprise_method = "unavailable"
            else:
                surprise_val = round(actual - previous, 4)
                z_score = round(surprise_val / std, 4) if std > 0 else None
                surprise_method = "actual_minus_previous"

        enriched_records.append(
            {
                "timestamp_utc": ts.strftime("%Y-%m-%d %H:%M:%S+00:00"),
                "currency": currency,
                "event_name": name,
                "impact": impact,
                "actual": actual,
                "forecast": forecast,
                "previous": previous,
                "surprise_val": surprise_val,
                "z_score": z_score,
                "historical_std_dev": std,
                "source": source,
                "forecast_source": forecast_source,
                "surprise_method": surprise_method,
                "is_simulated": is_simulated,
            }
        )

    df_enriched = pd.DataFrame(enriched_records)
    df_enriched.to_csv(output_path, index=False)

    n_real = int((~df_enriched["is_simulated"]).sum())
    print(
        f"[Calendar] Enriched calendar saved: {output_path} "
        f"({len(df_enriched)} events, {n_real} real, {len(df_enriched) - n_real} simulated/unavailable)."
    )
    return df_enriched


def write_calendar_provenance(
    calendar_csv: str = "data/raw/calendar/economic_calendar_enriched.csv",
    output_path: str = "data/processed/provenance.json",
) -> dict:
    """Write the calendar entry of the provenance manifest (merged by sync)."""
    df = pd.read_csv(calendar_csv)
    manifest = {
        "artifact": calendar_csv,
        "source": "bls_api_v2 + fred_csv (keyless)",
        "generated_at": utc_now(),
        "as_of": utc_now(),
        "is_simulated": bool(df["is_simulated"].all()) if "is_simulated" in df.columns else False,
        "rows": int(len(df)),
        "rows_real": int((~df["is_simulated"]).sum()) if "is_simulated" in df.columns else 0,
        "forecast_available": False,
        "forecast_source": "unavailable",
        "surprise_method": "actual_minus_previous",
        "details": {
            "series": {
                sid: {"source": meta["source"], "label": meta["label"]}
                for sid, meta in SERIES_REGISTRY.items()
            }
        },
    }
    return manifest


if __name__ == "__main__":
    cfg = load_config()
    raw = cfg["data"]["calendar_file_raw"]
    out = cfg["data"]["calendar_file_complete"]
    enrich_economic_calendar(raw, out)
