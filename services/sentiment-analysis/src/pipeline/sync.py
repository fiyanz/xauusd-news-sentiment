"""Automated End-to-End Pipeline Sync Engine.

Order matters for point-in-time integrity:

    price -> intraday -> macro -> calendar -> news -> harmonize -> buckets

The calendar must be enriched *before* news so the harmonizer can attribute
articles to events using only already-published events (merge_asof backward).
``data/processed/provenance.json`` is written last and records the source and
simulation status of every artifact.
"""

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

# Make ``src`` importable when run as a plain script from the repo root.
_repo_service_dir = Path(__file__).resolve().parents[2]
if str(_repo_service_dir) not in sys.path:
    sys.path.insert(0, str(_repo_service_dir))

from src.acquire.price import (
    refresh_intraday_data,
    refresh_price_data,
    write_price_provenance,
)
from src.acquire.macro import fetch_and_align_macro_data
from src.acquire.calendar import enrich_economic_calendar, write_calendar_provenance
from src.acquire.news import acquire_news_sentiment, write_news_provenance, load_config
from src.process.harmonize import harmonize_dataset
from src.process.bucket_harmonize import harmonize_buckets


def _now_str() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S+00:00")


def _merge_provenance(manifest_path: str, entries: list[dict]) -> dict:
    """Merge artifact entries into the provenance manifest on disk.

    ``is_simulated`` is True only when *every* artifact is fully simulated;
    partial simulation is reported through ``has_simulated_rows``.
    """
    now = _now_str()
    manifest: dict = {"artifacts": {}, "generated_at": now}
    if Path(manifest_path).exists():
        try:
            with open(manifest_path, "r") as f:
                existing = json.load(f)
            manifest["artifacts"] = existing.get("artifacts", {})
        except (json.JSONDecodeError, OSError):
            pass

    for entry in entries:
        artifact = entry.get("artifact")
        if not artifact:
            # Nested provenance (e.g. price artifacts dict)
            for key, value in entry.get("artifacts", {}).items():
                manifest["artifacts"][key] = value
            continue
        manifest["artifacts"][artifact] = entry

    manifest["generated_at"] = entries[-1]["generated_at"] if entries else manifest.get("generated_at")
    all_sim = bool(manifest["artifacts"]) and all(
        v.get("is_simulated", False) for v in manifest["artifacts"].values()
    )
    manifest["is_simulated"] = all_sim
    manifest["has_simulated_rows"] = any(
        v.get("is_simulated", False) or v.get("rows_real", v.get("rows", 0)) < v.get("rows", 0)
        for v in manifest["artifacts"].values()
    )
    return manifest


def run_full_sync(write_prediction: bool = True) -> dict:
    print("=" * 60)
    print("[PipelineSync] Starting Automated Market Intelligence Pipeline...")
    print("=" * 60)

    cfg = load_config()
    data_cfg = cfg.get("data", {})
    processed_dir = data_cfg.get("processed_dir", "data/processed")
    provenance_path = f"{processed_dir}/provenance.json"
    Path(processed_dir).mkdir(parents=True, exist_ok=True)

    provenance_entries: list[dict] = []

    # 1. H1 Price Data Refresh
    print("\n--- Step 1/8: H1 Price Data Sync ---")
    refresh_price_data(data_cfg.get("price_file_raw"), data_cfg.get("price_file_complete"))
    provenance_entries.append(write_price_provenance())

    # 2. Intraday 5m/15m (real GC=F)
    print("\n--- Step 2/8: Intraday 5m/15m Sync ---")
    refresh_intraday_data()

    # 3. Macro Data Refresh (US10Y, DXY, Oil with PIT lag)
    print("\n--- Step 3/8: Macro Covariates Sync ---")
    m_cfg = cfg.get("macro", {})
    fetch_and_align_macro_data(
        tickers=m_cfg.get("tickers", {"us10y": "^TNX", "dxy": "DX-Y.NYB", "oil": "CL=F"}),
        start_date=m_cfg.get("start_date", "2010-01-01"),
        end_date=m_cfg.get("end_date"),  # None -> today
        output_path=m_cfg.get("output_file", "data/raw/macro/macro_context.csv"),
        lag_days=m_cfg.get("lag_days", 1),
    )

    # 4. Calendar Data Enrichment (real BLS/FRED actuals)
    print("\n--- Step 4/8: Economic Calendar Sync ---")
    calendar_csv = data_cfg.get("calendar_file_complete", "data/raw/calendar/economic_calendar_enriched.csv")
    enrich_economic_calendar(data_cfg.get("calendar_file_raw"), calendar_csv)
    provenance_entries.append(write_calendar_provenance(calendar_csv))

    # 5. News Sentiment Stream (real RSS + VADER)
    print("\n--- Step 5/8: News Sentiment Feed Sync ---")
    news_dir = data_cfg.get("news_dir_raw", "data/raw/news")
    news_cfg = cfg.get("news", {})
    acquire_news_sentiment(
        output_dir=news_dir,
        feeds=news_cfg.get("rss_feeds"),
        max_articles_per_feed=news_cfg.get("max_articles_per_feed", 60),
        lookback_days=news_cfg.get("lookback_days", 14),
        calendar_path=calendar_csv,
    )
    provenance_entries.append(
        write_news_provenance(f"{news_dir}/news_sentiment_feed.json")
    )

    # 6. Harmonization (news + price -> returns/labels)
    print("\n--- Step 6/8: Harmonization ---")
    harmonize_dataset(
        price_path=data_cfg.get("price_file_complete", "data/raw/price/xauusd_h1_complete.csv"),
        news_path=f"{news_dir}/news_sentiment_feed.json",
        calendar_path=calendar_csv,
        output_dir=processed_dir,
        threshold_k=cfg.get("label", {}).get("threshold_k", 0.5),
        vol_lookback_days=cfg.get("label", {}).get("vol_lookback_days", 20),
    )

    # 6b. Feature matrix (TF-IDF, split, session dummies) from the same real input
    print("\n--- Step 6b/8: Feature Matrix Build ---")
    try:
        from src.features.build_features import build_features

        build_features(
            input_parquet=f"{processed_dir}/dataset_article.parquet",
            output_parquet=f"{processed_dir}/features.parquet",
            embargo_hours=cfg.get("split", {}).get("embargo_hours", 24),
            train_ratio=cfg.get("split", {}).get("train", 0.6),
            val_ratio=cfg.get("split", {}).get("val", 0.2),
        )
    except Exception as exc:
        print(f"[PipelineSync] Feature matrix build failed: {exc}")

    # 7. 4H Bucketing & Interaction Features
    print("\n--- Step 7/8: 4H Bucketing & Interaction Features ---")
    harmonize_buckets(
        article_parquet=f"{processed_dir}/dataset_article.parquet",
        calendar_csv=calendar_csv,
        price_csv=data_cfg.get("price_file_complete", "data/raw/price/xauusd_h1_complete.csv"),
        macro_csv=m_cfg.get("output_file", "data/raw/macro/macro_context.csv"),
        output_parquet=f"{processed_dir}/bucketed_features.parquet",
        embargo_hours=cfg.get("split", {}).get("embargo_hours", 24),
        train_ratio=cfg.get("split", {}).get("train", 0.6),
        val_ratio=cfg.get("split", {}).get("val", 0.2),
    )

    # 8. Provenance manifest
    print("\n--- Step 8/8: Provenance Manifest ---")
    bucketed_entry = {
        "artifact": f"{processed_dir}/bucketed_features.parquet",
        "source": "rss_feeds+vader | bls_api_v2+fred_csv | yfinance GC=F | yfinance ^TNX/DX-Y.NYB/CL=F",
        "generated_at": _now_str(),
        "as_of": None,
        "is_simulated": False,
    }
    manifest = _merge_provenance(provenance_path, provenance_entries + [bucketed_entry])
    with open(provenance_path, "w") as f:
        json.dump(manifest, f, indent=2)
    print(f"[PipelineSync] Provenance manifest written: {provenance_path}")

    # 9. Live AI Model Prediction (optional: model bundle may not exist yet)
    prediction = None
    if write_prediction:
        print("\n--- Step 9/9: Live Model Inference ---")
        try:
            from src.models.predict import generate_live_prediction

            prediction = generate_live_prediction()
        except Exception as exc:
            print(f"[PipelineSync] Model inference skipped: {exc}")
            prediction = {"status": "unavailable", "reason": str(exc)}

    print("\n" + "=" * 60)
    if prediction:
        print(f"[PipelineSync] Pipeline Sync Finished! Status: {prediction.get('status', 'ok')}")
    else:
        print("[PipelineSync] Pipeline Sync Finished!")
    print("=" * 60)

    return {"prediction": prediction, "provenance": provenance_path}


if __name__ == "__main__":
    run_full_sync()
