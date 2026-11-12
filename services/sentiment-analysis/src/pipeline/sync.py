"""Automated End-to-End Pipeline Sync Engine.

Order matters for point-in-time integrity:

    price -> intraday -> macro -> calendar -> news -> harmonize -> buckets
    -> retrain -> evaluate -> predict -> provenance

The calendar must be enriched *before* news so the harmonizer can attribute
articles to events using only already-published events (merge_asof backward).
``data/processed/provenance.json`` is written last and records the source and
simulation status of every artifact (data, model, and reports).
"""

import sys
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
from src.pipeline.provenance import merge_provenance, now_str, write_provenance


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
    price_raw = data_cfg.get("price_file_raw")
    if price_raw:
        refresh_price_data(price_raw, data_cfg.get("price_file_complete"))
    else:
        # Tanpa sumber eksternal: pakai CSV repo sebagai base history dan
        # tambal ekor dengan yfinance supaya H1 tidak basi.
        refresh_price_data(None, data_cfg.get("price_file_complete"))
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
    calendar_raw = data_cfg.get("calendar_file_raw")
    if calendar_raw:
        enrich_economic_calendar(calendar_raw, calendar_csv)
    else:
        print(
            "[PipelineSync] calendar_file_raw tidak diset; memakai kalender yang sudah ada di repo."
        )
    provenance_entries.append(write_calendar_provenance(calendar_csv))

    # 5. News Sentiment Stream (real RSS + VADER) -> korpus persisten
    print("\n--- Step 5/8: News Sentiment Feed Sync ---")
    news_dir = data_cfg.get("news_dir_raw", "data/raw/news")
    news_cfg = cfg.get("news", {})
    corpus_path = data_cfg.get("news_corpus", "data/processed/news_corpus.jsonl")
    acquire_news_sentiment(
        output_dir=news_dir,
        feeds=news_cfg.get("rss_feeds"),
        max_articles_per_feed=news_cfg.get("max_articles_per_feed", 60),
        lookback_days=news_cfg.get("lookback_days", 14),
        calendar_path=calendar_csv,
        corpus_path=corpus_path,
    )
    provenance_entries.append(
        write_news_provenance(f"{news_dir}/news_sentiment_feed.json")
    )

    # 5b. GDELT historical news (keyless, rate-limited) -> korpus yang sama.
    gdelt_cfg = news_cfg.get("gdelt", {})
    if gdelt_cfg.get("enabled"):
        print("\n--- Step 5b/8: GDELT Historical News Sync ---")
        try:
            from src.acquire.gdelt import fetch_gdelt_articles

            added = fetch_gdelt_articles(
                corpus_path=corpus_path,
                query=gdelt_cfg.get("query", "gold futures language:eng"),
                start_date=gdelt_cfg.get("start_date"),
                end_date=gdelt_cfg.get("end_date"),
                max_records=gdelt_cfg.get("max_records_per_window", 250),
                window_days=gdelt_cfg.get("window_days", 31),
                max_windows=gdelt_cfg.get("max_windows", 12),
                delay=gdelt_cfg.get("delay_seconds", 6.5),
            )
            print(f"[PipelineSync] GDELT: +{added} artikel baru di korpus.")
        except Exception as exc:  # noqa: BLE001 - rate limit / network; jangan crash
            print(f"[PipelineSync] GDELT dilewati: {type(exc).__name__}: {exc}")
    else:
        print("[PipelineSync] GDELT disabled; korpus hanya dari RSS.")

    # 6. Harmonization (korpus berita + price -> returns/labels)
    print("\n--- Step 6/8: Harmonization ---")
    harmonize_dataset(
        price_path=data_cfg.get("price_file_complete", "data/raw/price/xauusd_h1_complete.csv"),
        news_path=corpus_path,
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
    bucket_mode = data_cfg.get("bucket_mode", "price_history")
    if bucket_mode == "price_history":
        # Bucket untuk SELURUH history harga; fitur berita netral (0) bila tidak
        # ada artikel, sehingga ukuran sampel tidak dibatasi cakupan berita.
        from src.process.price_buckets import build_price_history_buckets

        build_price_history_buckets(
            price_csv=data_cfg.get("price_file_complete", "data/raw/price/xauusd_h1_complete.csv"),
            article_parquet=f"{processed_dir}/dataset_article.parquet",
            calendar_csv=calendar_csv,
            macro_csv=m_cfg.get("output_file", "data/raw/macro/macro_context.csv"),
            output_parquet=f"{processed_dir}/bucketed_features.parquet",
            embargo_hours=cfg.get("split", {}).get("embargo_hours", 24),
            train_ratio=cfg.get("split", {}).get("train", 0.6),
            val_ratio=cfg.get("split", {}).get("val", 0.2),
            vol_lookback_days=cfg.get("label", {}).get("vol_lookback_days", 20),
        )
    else:
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

    # 8. Provenance manifest (artefak data) — ditulis dulu agar stage
    #    signifikansi bisa memverifikasi artifact (parquet <= provenance).
    print("\n--- Step 8/9: Provenance Manifest ---")
    bucketed_entry = {
        "artifact": f"{processed_dir}/bucketed_features.parquet",
        "source": "rss_feeds+vader | bls_api_v2+fred_csv | yfinance GC=F | yfinance ^TNX/DX-Y.NYB/CL=F",
        "generated_at": now_str(),
        "as_of": None,
        "is_simulated": False,
    }
    manifest = merge_provenance(provenance_path, provenance_entries + [bucketed_entry])
    write_provenance(provenance_path, manifest)
    print(f"[PipelineSync] Provenance manifest written: {provenance_path}")

    # 9. Retrain + evaluasi + prediksi di atas artifact baru.
    #    Data yang di-refresh tapi model tidak di-retrain akan membuat prediksi
    #    dan laporan tertinggal dari data — stage ini menjaga konsistensi.
    #    (Stage ini juga menambahkan entri model & significance ke provenance.)
    print("\n--- Step 9/9: Retrain, Evaluation & Prediction ---")
    retrain_result = None
    prediction = None
    try:
        from src.pipeline.retrain import run_training_and_evaluation

        retrain_result = run_training_and_evaluation(
            features_parquet=f"{processed_dir}/bucketed_features.parquet",
            write_prediction=write_prediction,
        )
        prediction = retrain_result.get("prediction")
        if retrain_result.get("status") != "ok":
            print(f"[PipelineSync] Training dilewati: {retrain_result.get('reason')}")
            prediction = prediction or {
                "status": "skipped",
                "reason": retrain_result.get("reason"),
            }
    except Exception as exc:
        print(f"[PipelineSync] Retrain/evaluasi gagal: {exc}")
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
