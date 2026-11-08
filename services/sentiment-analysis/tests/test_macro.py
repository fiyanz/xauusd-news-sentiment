"""Unit tests for point-in-time macro data acquisition and lag validation."""

import os
from pathlib import Path
import numpy as np
import pandas as pd
import pytest

from src.acquire.macro import fetch_and_align_macro_data, load_config


MACRO_FILE = "data/raw/macro/macro_context.csv"


def test_macro_file_exists_and_non_empty():
    """Verify macro context CSV exists and contains substantial historical data (2010-2026)."""
    assert os.path.exists(MACRO_FILE), f"Macro dataset missing at {MACRO_FILE}"
    df = pd.read_csv(MACRO_FILE)
    assert len(df) >= 3500, f"Expected >= 3500 trading days, got {len(df)}"


def test_macro_required_columns():
    """Verify presence of all expected macro features and asset columns."""
    df = pd.read_csv(MACRO_FILE)
    assert "date" in df.columns

    assets = ["us10y", "dxy", "oil"]
    for asset in assets:
        assert f"{asset}_close" in df.columns, f"Missing {asset}_close"
        assert f"{asset}_delta_1d" in df.columns, f"Missing {asset}_delta_1d"
        assert f"{asset}_delta_5d" in df.columns, f"Missing {asset}_delta_5d"
        assert f"{asset}_raw_close" in df.columns, f"Missing {asset}_raw_close"

        # Model alias columns
        assert f"macro_{asset}_lag1d" in df.columns
        assert f"macro_{asset}_delta1d" in df.columns
        assert f"macro_{asset}_delta5d" in df.columns

    # Verify no NaN values in features
    assert df.isna().sum().sum() == 0, "Macro context should have zero missing values"


def test_strictly_monotonic_utc_dates():
    """Verify date column is strictly monotonic increasing UTC timestamps."""
    df = pd.read_csv(MACRO_FILE)
    date_col = df["date"]

    # Verify UTC indicator in strings
    assert "+00:00" in str(date_col.iloc[0]) or "UTC" in str(date_col.iloc[0])
    assert "+00:00" in str(date_col.iloc[-1]) or "UTC" in str(date_col.iloc[-1])

    # Parse and check strict monotonicity
    dt_series = pd.to_datetime(date_col, utc=True)
    assert dt_series.is_monotonic_increasing, "Macro dates must be strictly monotonic increasing"
    assert not dt_series.duplicated().any(), "Macro dates must have no duplicate timestamps"


def test_point_in_time_shift1_lag():
    """Verify strictly zero-lookahead point-in-time shift(1) alignment.

    At date T, feature_close must equal raw_close at date T-1.
    """
    df = pd.read_csv(MACRO_FILE)
    assets = ["us10y", "dxy", "oil"]

    for asset in assets:
        close_lagged = df[f"{asset}_close"].to_numpy()
        raw_close = df[f"{asset}_raw_close"].to_numpy()
        delta_1d = df[f"{asset}_delta_1d"].to_numpy()

        # At row i >= 1, lagged close must equal raw close at row i-1
        diff_close = np.abs(close_lagged[1:] - raw_close[:-1])
        assert np.max(diff_close) < 1e-4, f"Shift(1) lag violation on {asset}_close: {np.max(diff_close)}"

        # At row i >= 2, lagged delta_1d must equal raw diff (raw[i-1] - raw[i-2])
        expected_delta = raw_close[1:-1] - raw_close[:-2]
        diff_delta = np.abs(delta_1d[2:] - expected_delta)
        assert np.max(diff_delta) < 1e-4, f"Shift(1) lag violation on {asset}_delta_1d: {np.max(diff_delta)}"

        # Verify not identical to current unlagged price (would be lookahead)
        assert not np.allclose(close_lagged[1:], raw_close[1:]), f"Lookahead detected: {asset} lagged matches current raw"


def test_fetch_and_align_execution(tmp_path: Path):
    """Test the acquisition function runs end-to-end and outputs valid CSV."""
    out_file = str(tmp_path / "test_macro.csv")
    df = fetch_and_align_macro_data(
        tickers={"us10y": "^TNX"},
        start_date="2024-01-01",
        end_date="2024-01-31",
        output_path=out_file,
        lag_days=1,
    )
    assert os.path.exists(out_file)
    assert len(df) >= 15
    assert "us10y_close" in df.columns
    assert "us10y_raw_close" in df.columns
    # Check shift 1
    assert np.isclose(df["us10y_close"].iloc[1], df["us10y_raw_close"].iloc[0])
