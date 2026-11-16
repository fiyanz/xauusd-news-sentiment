# Sentiment Analysis Pipeline (XAUUSD)

Pipeline Python untuk sistem informasi pasar emas: pengambilan data nyata
(keyless), harmonisasi, feature engineering, pelatihan model, evaluasi, dan
prediksi 4 jam.

- **Repo:** https://github.com/fiyanz/xauusd-news-sentiment
- **Data:** https://www.kaggle.com/datasets/kyoushin/xauusd-news-sentiment-data

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
- **Mode bucket** (`data.bucket_mode`):
  - `price_history` (default): bucket untuk **seluruh history harga**; fitur
    berita netral (0) bila tidak ada artikel. Sampel ~26k bucket (2010–2026),
    jadi CV/evaluasi benar-benar bermakna dan tidak dibatasi cakupan berita.
  - `news_only`: bucket hanya saat ada artikel (legacy, sampel kecil).

## 2. Modul

| Modul | Tanggung jawab |
|---|---|
| `src/acquire/data_sources.py` | Client BLS API v2 + FRED CSV dengan cache |
| `src/acquire/calendar.py` | Enrichment kalender dengan actual BLS/FRED |
| `src/acquire/news.py` | RSS (feedparser) + sentimen VADER |
| `src/acquire/corpus.py` | Korpus berita persisten (append-only, dedupe URL) |
| `src/acquire/gdelt.py` | GDELT Doc API historis (keyless, rate-limited) |
| `src/acquire/hf_news.py` | HuggingFace financial news (keyless, snapshot 2010-2020) |
| `src/acquire/sentiment_lexicon.py` | Loughran-McDonald lexicon keuangan (alternatif VADER) |
| `src/acquire/price.py` | H1 history + intraday GC=F 5m/15m |
| `src/acquire/macro.py` | US10Y, DXY, Oil (PIT lag) |
| `src/process/harmonize.py` | merge_asof backward, return/label |
| `src/process/bucket_harmonize.py` | 4H bucket, topik, interaksi, split+embargo |
| `src/process/price_buckets.py` | Bucket 4H dari full history harga (berita sebagai fitur sparse) |
| `src/features/build_features.py` | TF-IDF + split + provenance |
| `src/features/reduce.py` | Preprocessing: PCA per blok berkorelasi + encoding waktu siklikal (TF-IDF ikut dipakai) |
| `src/models/train.py` | 4 model, CV, champion by CV |
| `src/models/predict.py` | Prediksi 4H live |
| `src/evaluate/significance.py` | p-value, Wilson CI, Pesaran-Timmermann |
| `src/evaluate/evaluate_fair.py` | Baseline vs full model |
| `src/evaluate/evaluate_models.py` | Metrik lengkap + laporan markdown |

## 3. Menjalankan

### Preprocessing & reduksi fitur

`src/features/reduce.py`:
- Blok berkorelasi (`macro_*`, `topic_*`, `sentiment_x_*`, `tfidf_*`) dikompresi
  PCA (90% varians, maks 2-3 komponen per blok), **difit pada data training
  saja** (anti look-ahead) — semua fitur asli tetap berkontribusi lewat
  komponennya, tidak ada yang dibuang.
- Fitur waktu di-encode siklikal (`hour_sin/cos`, `dow_sin/cos`).
- TF-IDF (50 kolom) yang dulu dihitung tapi menganggur kini masuk lewat
  `tfidf_pc1..3`.
- Surprise makro di-carry-forward: bila tidak ada rilis dalam 2 jam, fitur diisi
  surprise rilis terakhir yang sudah terbit + `surprise_age_hours`
  (point-in-time safe, `merge_asof backward` tanpa tolerance).
- Hasil: 26 fitur dari 85 mentah; `block_explained_variance` tersimpan di bundle.
- **Baseline pembanding** didefinisikan sekali di bundle
  (`models/champion_fair_model.joblib` → `baseline_model` + `baseline_feature_cols`,
  21 fitur: event/makro + skor sentimen mentah, tanpa blok topik/TF-IDF/interaksi).
  Semua laporan membaca baseline yang sama lewat `baseline_descriptor()` di
  `src/evaluate/significance.py` — bukan "model terlatih yang bukan champion".

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
- `data.news_corpus` — korpus berita persisten (JSONL, append-only, dedupe URL).
- `news.rss_feeds`, `news.lookback_days`, `news.max_articles_per_feed`.
- `news.gdelt` — sumber historis keyless (rate-limit ~1 request/5 detik):
  `enabled`, `query`, `start_date`, `end_date`, `max_records_per_window`,
  `window_days`, `max_windows`, `delay_seconds`. Bila API memblokir (429),
  pipeline tetap jalan dengan korpus RSS.
- `news.hf_news` — HuggingFace `ashraq/financial-news` (keyless, snapshot statis
  2010-2020). Di-filter jadi ~12.5k headline emas unik; mengisi periode training
  yang tidak bisa dijangkau RSS. `cache` menyimpan hasil filter (raw 142MB
  dihapus setelah difilter).
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
| `reports/significance.json` | kontrak signifikansi + uji delta vs baseline (paired bootstrap) |
| `reports/fair_comparison_results.json` | fair baseline vs full model (dibangun oleh `evaluate_fair`, dipakai ulang oleh `evaluate_models`) |
| `reports/reformed_evaluation.md` | laporan markdown fair baseline vs full model |
| `reports/full_metrics_evaluation.json` | metrik semua model |
| `reports/full_metrics_evaluation.md` | laporan markdown metrik semua model |

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
