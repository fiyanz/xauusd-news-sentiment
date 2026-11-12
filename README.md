# XAUUSD Market Intelligence Terminal

Sistem informasi pasar emas (XAUUSD) dan analisis dampak rilis berita makro.
Monorepo **Bun + TypeScript** (Next.js, Fastify) dengan service **Python (uv)**
untuk pipeline data dan ML.

> **Integritas data:** seluruh angka analisis bersumber dari data nyata
> (BLS, FRED, yfinance, RSS, CFTC) dan setiap artifact membawa metadata
> *provenance*. Bila sumber tidak tersedia, sistem mengembalikan
> `status: "unavailable"` — bukan angka karangan.

---

## 1. Struktur Repo

```text
sistem-informasi-market-xauusd/
├── apps/
│   ├── api/          # REST + SSE (Fastify) — harga, kalender, event study, COT, digest
│   ├── web/          # Terminal chart (Next.js 15 + lightweight-charts) + API routes
│   └── worker/       # Scheduled ingestion pipeline
├── packages/
│   ├── types/              # Skema Zod bersama (OHLCV, COT, dst.)
│   ├── database/           # Skema Drizzle (PostgreSQL) + migrasi
│   ├── core-analytics/     # Surprise, reaction windows, agregasi event study
│   └── financial-clients/  # Kalender, COT CFTC, candle XAUUSD
├── services/
│   └── sentiment-analysis/ # Pipeline Python: acquire → process → features → ML
├── docs/                   # PRD, arsitektur, diagram
├── .hermes/plans/          # Rencana perbaikan (F1–F4)
└── .env.example
```

## 2. Quickstart

```bash
# 1. Dependensi TypeScript (Bun)
bun install

# 2. Service Python
cd services/sentiment-analysis
uv sync
uv run python -m nltk.downloader vader_lexicon   # sekali saja

# 3. Database PostgreSQL
#    Salin .env.example ke .env (root) dan sesuaikan DATABASE_URL.
cd ../../packages/database
bun run db:migrate        # menerapkan migration dari ./drizzle

# 4. Pipeline data + ML (opsional: config default memakai artifact repo)
cd ../../services/sentiment-analysis
uv run python -m src.pipeline.sync

# 5. Jalankan aplikasi (dari root)
bun run dev
#   web    -> http://localhost:3000
#   api    -> http://localhost:4000
#   worker -> bun x tsx apps/worker/src/index.ts
```

## 3. Sumber Data (keyless)

| Kebutuhan | Sumber | Keterangan |
|---|---|---|
| Actual CPI / core CPI / NFP | BLS API v2 | Tanpa key (batas 25 query/hari, di-cache) |
| Core PCE, FOMC target rate | FRED CSV publik | `fredgraph.csv?id=...` |
| H1 history + intraday 5m/15m | yfinance `GC=F` | Intraday maks ~60 hari |
| Berita & sentimen | 9 RSS feed + VADER (nltk) | URL artikel asli |
| COT | CFTC `deafut.txt` | Non-commercial long/short emas |
| Forecast konsensus | — | Tidak ada sumber keyless; surprise = actual − previous |

`config.yaml` (`services/sentiment-analysis`) memegang daftar feed, ticker makro,
dan *lookback* berita. Path dataset eksternal (`price_file_raw`,
`calendar_file_raw`) bersifat opsional; bila `null`, pipeline memakai artifact
yang sudah ada di repo.

## 4. Pipeline Data & ML

Alur lengkap (`src/pipeline/sync.py`):

```text
price → intraday → macro → calendar → news → harmonize
      → features → buckets → retrain → evaluate → predict → provenance
```

- **Retrain stage** (`src/pipeline/retrain.py`) menjalankan `train → significance
  → eval fair → eval models → predict` di atas artifact terbaru, sehingga model
  dan laporan tidak tertinggal dari data.
- **Preprocessing fitur** (`src/features/reduce.py`): blok berkorelasi (makro,
  topik, interaksi sentimen, TF-IDF) dikompresi PCA yang difit pada data
  training saja; waktu di-encode siklikal; TF-IDF ikut dipakai. Hasil: 25 fitur
  dari 84 mentah, dengan explained variance per blok tercatat di bundle.
- Guard: bila sampel < 20 bucket, training dilewati dan model lama dipertahankan
  (tidak ada hasil yang difabrikasi).
- `data/processed/provenance.json` mencatat sumber, `generated_at`, dan status
  simulasi setiap artifact.

## 5. Output & Laporan

| File | Isi |
|---|---|
| `reports/significance.json` | champion, rank IC + p-value, hit ratio + CI95 + p-value, Pesaran-Timmermann, negative control, `sentiment_adds_value` |
| `reports/full_metrics_evaluation.json` | metrik lengkap semua model pada test set |
| `reports/fair_comparison_results.json` | baseline vs full model |
| `reports/reformed_evaluation.md` | laporan markdown (jujur soal signifikansi) |
| `data/processed/latest_prediction.json` | prediksi 4H terbaru untuk API |

## 6. API (ringkas)

| Endpoint | Fungsi |
|---|---|
| `GET /api/v1/market/xauusd/latest` | harga terakhir |
| `GET /api/v1/market/xauusd/candles` | candle per timeframe (intraday nyata bila ada) |
| `GET /api/v1/market/xauusd/stream` | SSE tick (ditandai `isSimulated`) |
| `GET /api/v1/calendar/upcoming` | kalender ekonomi |
| `GET /api/v1/analytics/event-study/:code` | event study dari data nyata |
| `GET /api/v1/analytics/macro-sentiment/latest` | prediksi model |
| `GET /api/v1/reports/cot/latest` | COT CFTC |
| `GET /api/v1/reports/daily/latest` | digest harian |
| `POST /api/v1/pipeline/sync` | trigger pipeline (wajib `x-pipeline-token`) |

Route web (`/api/market/*`) adalah proksi/fallback yang membaca file pipeline
secara langsung; semua menerapkan kontrak `unavailable`.

## 7. Testing

```bash
bun run test          # TypeScript (core-analytics)
bun run check-types   # tsc --noEmit semua package
bun run lint
bun run build

cd services/sentiment-analysis
.venv/bin/python -m pytest -q
```

## 8. Known Limitations

- **Sampel kecil.** RSS keyless hanya menyediakan berita ~14 hari terakhir,
  menghasilkan 20–40 bucket 4H. CV/evaluasi pada sampel sekecil itu sangat
  *noise* dan hampir pasti tidak signifikan — sistem melaporkannya apa adanya
  (`sentiment_adds_value: false`), bukan menyembunyikannya.
- **Surprise makro seringkali kosong.** Bila tidak ada rilis makro dengan
  *actual* yang overlap jendela berita (mis. rilis belum masuk BLS), fitur
  `surprise_val`/`z_score` bernilai NaN dan diimputasi 0 dengan `has_event = 0`;
  ini diungkapkan di bundle model.
- **Migrasi DB** butuh PostgreSQL yang sedang jalan (`bun run db:migrate`).
- **Dataset eksternal lama** (`expert-advisor-trade`) opsional; regenerasi
  historis penuh butuh path tersebut di `config.yaml`.

## 9. Keamanan & Operasi

- `PIPELINE_SYNC_TOKEN` wajib untuk trigger pipeline via API; token belum diset
  → `503`, token salah → `401`. Pipeline dibatasi timeout 15 menit.
- CORS dibatasi ke `WEB_ORIGIN` (default `http://localhost:3000`).
- Path data portabel via `REPO_ROOT` (env) atau diturunkan dari cwd.
- `.env` dibaca dari repo root oleh `loadEnv()` (turbo menjalankan task per-package).
