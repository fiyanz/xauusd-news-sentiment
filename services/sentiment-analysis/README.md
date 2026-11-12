# Sentiment Analysis Pipeline (XAUUSD)

Pipeline Python untuk sistem informasi pasar emas: pengambilan data nyata
(keyless), harmonisasi, feature engineering, pelatihan model, evaluasi, dan
prediksi 4 jam.

> Semua input bersumber dari data nyata (BLS, FRED, yfinance, RSS, CFTC).
> Bila sumber gagal, pipeline menghasilkan `unavailable`/NaN dan menandainya di
> `data/processed/provenance.json` — tidak ada data karangan.

---

## 1. Alur

```text
src/pipeline/sync.py
  price → intraday → macro → calendar → news
        → harmonize → features → buckets
        → retrain → evaluate → predict
        → provenance.json
```

- **`src/pipeline/retrain.py`** — tahap ML: `train → significance → eval fair →
  eval models → predict` di atas artifact terbaru. Guard: sampel < 20 bucket →
  training dilewati, model lama dipertahankan.
- **`src/pipeline/provenance.py`** — helper manifest provenance bersama.

## 2. Modul

| Modul | Tanggung jawab |
|---|---|
| `src/acquire/data_sources.py` | Client BLS API v2 + FRED CSV dengan cache |
| `src/acquire/calendar.py` | Enrichment kalender dengan actual BLS/FRED |
| `src/acquire/news.py` | RSS (feedparser) + sentimen VADER |
| `src/acquire/price.py` | H1 history + intraday GC=F 5m/15m |
| `src/acquire/macro.py` | US10Y, DXY, Oil (PIT lag) |
| `src/process/harmonize.py` | merge_asof backward, return/label |
| `src/process/bucket_harmonize.py` | 4H bucket, topik, interaksi, split+embargo |
| `src/features/build_features.py` | TF-IDF + split + provenance |
| `src/models/train.py` | 4 model, CV, champion by CV |
| `src/models/predict.py` | Prediksi 4H live |
| `src/evaluate/significance.py` | p-value, Wilson CI, Pesaran-Timmermann |
| `src/evaluate/evaluate_fair.py` | Baseline vs full model |
| `src/evaluate/evaluate_models.py` | Metrik lengkap + laporan markdown |

## 3. Menjalankan

```bash
uv sync
uv run python -m nltk.downloader vader_lexicon   # sekali

# Pipeline penuh (data + retrain + evaluasi + prediksi + provenance)
uv run python -m src.pipeline.sync

# Hanya retrain + evaluasi di atas artifact yang ada
uv run python -m src.pipeline.retrain

# Per modul
uv run python -m src.acquire.price
uv run python -m src.acquire.calendar
uv run python -m src.acquire.news
uv run python -m src.process.harmonize
uv run python -m src.models.train
uv run python -m src.evaluate.significance
```

## 4. Konfigurasi

`config.yaml`:

- `data.price_file_raw` / `data.calendar_file_raw` — sumber eksternal opsional.
  `null` → pakai artifact repo yang sudah ada.
- `news.rss_feeds`, `news.lookback_days`, `news.max_articles_per_feed`.
- `macro.tickers`, `macro.start_date`, `macro.end_date` (`null` = hari ini),
  `macro.lag_days`.
- `split.train/val/test`, `split.embargo_hours`, `split.walk_forward_folds`.

## 5. Artifact

| Path | Isi |
|---|---|
| `data/raw/price/xauusd_h1_complete.csv` | H1 history + patch yfinance |
| `data/raw/price/xauusd_m5.csv`, `xauusd_m15.csv` | intraday nyata (`is_real`) |
| `data/raw/calendar/economic_calendar_enriched.csv` | actual + provenance |
| `data/raw/news/news_sentiment_feed.json` | artikel RSS + sentimen |
| `data/raw/macro/macro_context.csv` | makro PIT |
| `data/processed/dataset_article.parquet` | artikel ter-harmonisasi |
| `data/processed/bucketed_features.parquet` | matriks fitur 4H |
| `data/processed/provenance.json` | manifest provenance |
| `models/champion_fair_model.joblib` | bundle model (champion by CV) |
| `reports/significance.json` | kontrak signifikansi |
| `reports/full_metrics_evaluation.json` | metrik semua model |
| `reports/reformed_evaluation.md` | laporan markdown |

## 6. Testing

```bash
.venv/bin/python -m pytest -q
```

Test mencakup: struktur data, anti look-ahead, provenance, signifikansi,
skema fitur, dan logika labeling.

## 7. Keterbatasan

- RSS keyless hanya mengembalikan berita ~14 hari terakhir → 20–40 bucket.
  CV pada sampel sekecil itu *noise*; laporan menampilkan p-value/CI apa adanya.
- Bila tidak ada rilis makro dengan actual yang overlap jendela berita,
  `surprise_val`/`z_score` NaN → diimputasi 0 dengan `has_event = 0`.
- Migrasi database aplikasi (`packages/database`) di luar service ini; pipeline
  Python berdiri sendiri.
