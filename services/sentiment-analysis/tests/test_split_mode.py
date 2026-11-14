"""Tests for the split_mode option in the full-history price bucket builder.

Covers:
- ``split_mode="chronological"`` keeps the legacy behaviour.
- ``split_mode="news_era"`` produces a test period that actually contains news,
  while remaining strictly out-of-time.
- ``report_split_coverage`` returns the documented structure.
"""

import pandas as pd
import pytest

from src.process.price_buckets import (
    VALID_SPLIT_MODES,
    build_price_history_buckets,
    report_split_coverage,
)

OUTPUT = "data/processed/bucketed_features_split_mode_test.parquet"


def _build(split_mode: str) -> pd.DataFrame:
    return build_price_history_buckets(
        output_parquet=OUTPUT,
        split_mode=split_mode,
    )


@pytest.fixture(scope="module")
def chronological() -> pd.DataFrame:
    return _build("chronological")


@pytest.fixture(scope="module")
def news_era() -> pd.DataFrame:
    return _build("news_era")


def test_chronological_matches_legacy_behaviour(chronological):
    """Default mode must reproduce the old positional split exactly."""
    df = chronological
    n_total = len(df)
    n_train = int(n_total * 0.6)
    n_val = min(int(n_total * 0.2), n_total - n_train)
    embargo_delta = pd.Timedelta(hours=24)

    assert df["split"].isin(["train", "val", "test", "embargo"]).all()

    # Recompute the legacy boundaries and verify every row's label matches.
    t_train_end = df["time_bucket"].iloc[n_train]
    t_val_end = df["time_bucket"].iloc[n_train + n_val]
    expected = []
    for t in df["time_bucket"]:
        if t < t_train_end - embargo_delta:
            expected.append("train")
        elif t < t_train_end:
            expected.append("embargo")
        elif t < t_val_end - embargo_delta:
            expected.append("val")
        elif t < t_val_end:
            expected.append("embargo")
        else:
            expected.append("test")
    assert list(df["split"]) == expected

    # Legacy split is positional: train ends before val, val before test.
    train_end = df.loc[df["split"] == "train", "time_bucket"].max()
    val_start = df.loc[df["split"] == "val", "time_bucket"].min()
    val_end = df.loc[df["split"] == "val", "time_bucket"].max()
    test_start = df.loc[df["split"] == "test", "time_bucket"].min()
    assert train_end < val_start <= val_end < test_start
    # The legacy test period is the tail of the price history.
    assert df["time_bucket"].max() in set(df.loc[df["split"] == "test", "time_bucket"])


def test_news_era_test_period_has_news(news_era):
    """news_era must give the test period articles, unlike the legacy split."""
    df = news_era
    test = df[df["split"] == "test"]
    assert len(test) > 0
    assert (test["article_count"] > 0).sum() > 0, "test period must contain news"
    # And it must not be the whole sample.
    assert len(test) < len(df)


def test_news_era_is_out_of_time(news_era):
    """test must be strictly after train/val (no look-ahead)."""
    df = news_era
    train_end = df.loc[df["split"] == "train", "time_bucket"].max()
    val_end = df.loc[df["split"] == "val", "time_bucket"].max()
    test_start = df.loc[df["split"] == "test", "time_bucket"].min()
    assert train_end < val_end < test_start


def test_news_era_has_news_in_every_split(news_era):
    """Each split should carry at least some news buckets."""
    df = news_era
    for split in ("train", "val", "test"):
        grp = df[df["split"] == split]
        assert len(grp) > 0
        assert (grp["article_count"] > 0).sum() > 0, f"{split} has no news buckets"


def test_report_split_coverage_structure(news_era):
    """report_split_coverage returns the documented per-split dict."""
    cov = report_split_coverage(news_era)
    assert isinstance(cov, dict)
    assert {"train", "val", "test"}.issubset(cov.keys())
    for split, info in cov.items():
        assert set(info.keys()) == {"n_buckets", "n_buckets_with_news", "start", "end"}
        assert isinstance(info["n_buckets"], int)
        assert isinstance(info["n_buckets_with_news"], int)
        assert info["n_buckets_with_news"] <= info["n_buckets"]
        assert info["start"] is None or isinstance(info["start"], str)
        assert info["end"] is None or isinstance(info["end"], str)
    # Coverage numbers must agree with the dataframe itself.
    for split in ("train", "val", "test"):
        grp = news_era[news_era["split"] == split]
        assert cov[split]["n_buckets"] == len(grp)
        assert cov[split]["n_buckets_with_news"] == int((grp["article_count"] > 0).sum())


def test_report_split_coverage_handles_missing_columns():
    """Helper must not crash on a dataframe without news/time columns."""
    df = pd.DataFrame({"split": ["train", "train", "test"]})
    cov = report_split_coverage(df)
    assert cov["train"]["n_buckets"] == 2
    assert cov["train"]["n_buckets_with_news"] == 0
    assert cov["train"]["start"] is None
    assert cov["test"]["n_buckets"] == 1


def test_invalid_split_mode_raises():
    with pytest.raises(ValueError):
        build_price_history_buckets(output_parquet=OUTPUT, split_mode="bogus")


def test_valid_split_modes_constant():
    assert "chronological" in VALID_SPLIT_MODES
    assert "news_era" in VALID_SPLIT_MODES
