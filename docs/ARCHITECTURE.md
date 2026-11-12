# Arsitektur Sistem Informasi Pasar Emas (XAUUSD) & Analisis Dampak Berita

Dokumen ini menjelaskan arsitektur teknis sistem: monorepo TypeScript (Bun),
service pipeline Python, alur data, dan integrasi model ML.

---

## 1. Struktur Monorepo (Bun + Turborepo)

```text
sistem-informasi-market-xauusd/
├── apps/
│   ├── api/          # Fastify — REST + SSE (port 4000)
│   ├── web/          # Next.js 15 App Router + lightweight-charts (port 3000)
│   └── worker/       # Scheduled ingestion (tsx)
├── packages/
│   ├── types/              # Skema Zod bersama (OHLCV, COT, EconomicRelease, dst.)
│   ├── database/           # Skema Drizzle (PostgreSQL) + drizzle-kit migration
│   ├── core-analytics/     # Surprise, reaction windows, agregasi event study
│   └── financial-clients/  # Kalender, COT CFTC, candle XAUUSD (CSV parser)
├── services/
│   └── sentiment-analysis/ # Pipeline Python (uv): acquire → process → ML
├── docs/                   # PRD, arsitektur, diagram
├── .hermes/plans/          # Rencana perbaikan
├── turbo.json
└── package.json
```

---

## 2. Alur Data & ML (services/sentiment-analysis)

```text
┌──────────────────── ACQUIRE (keyless) ────────────────────┐
│  BLS API v2   : CPI, core CPI, NFP                         │
│  FRED CSV     : core PCE, FOMC target range                │
│  yfinance GC=F: H1 history + intraday 5m/15m               │
│  RSS (9 feed) : berita + sentimen VADER                    │
│  CFTC         : COT report                                 │
└───────────────────────────┬───────────────────────────────┘
                            ▼
┌──────────────────── PROCESS / FEATURES ────────────────────┐
│  harmonize  : merge_asof backward (anti look-ahead)        │
│  features   : TF-IDF, session, temporal, split + embargo   │
│  buckets    : 4H bucket, topic interactions, PIT macro     │
└───────────────────────────┬───────────────────────────────┘
                            ▼
┌──────────────────── RETRAIN & EVALUATE ────────────────────┐
│  train         : champion dipilih by CV (bukan hardcode)   │
│  significance  : p-value, Wilson CI, Pesaran-Timmermann    │
│  eval fair     : baseline makro vs full (sentimen)         │
│  predict       : prediksi 4H terbaru                       │
│  provenance    : manifest sumber & status simulasi          │
└────────────────────────────────────────────────────────────┘
```

Semua artifact membawa metadata *provenance* (`source`, `generated_at`,
`is_simulated`). Bila sumber gagal, nilai yang dikembalikan adalah
`unavailable`/NaN — bukan pengganti karangan.

---

## 3. Integrasi Aplikasi TypeScript

```mermaid
sequenceDiagram
    autonumber
    actor Analyst
    participant Web as apps/web (Next.js)
    participant API as apps/api (Fastify)
    participant FS as File pipeline (CSV/JSON)
    participant Worker as apps/worker

    Note over Worker: Scheduled (cron / recursive)
    Worker->>FS: Jalankan src.pipeline.sync (data + retrain)
    Worker->>FS: Update latest_prediction.json & significance.json

    Analyst->>Web: Buka terminal
    Web->>FS: /api/market/candles (cache TTL)
    FS-->>Web: candle (source: real | estimated)
    Web->>API: /api/v1/analytics/event-study/:code
    API->>FS: kalender + candle nyata
    API-->>Web: surprise, reactions, historical logs
    Web->>API: /api/v1/market/xauusd/stream (SSE)
    API-->>Web: tick (ditandai isSimulated)
    Web-->>Analyst: chart + panel analitik
```

---

## 4. Diagram Deployment

```mermaid
graph TB
    subgraph Client
        Browser["Browser<br/>Next.js + lightweight-charts"]
    end

    subgraph Host
        Web["apps/web<br/>Next.js :3000"]
        API["apps/api<br/>Fastify :4000"]
        Worker["apps/worker<br/>ingestion loop"]
        Python["services/sentiment-analysis<br/>uv pipeline"]
    end

    subgraph Storage
        Postgres[("PostgreSQL<br/>Drizzle migration")]
        Files[("data/ + reports/<br/>CSV, parquet, joblib, JSON")]
    end

    subgraph External["Sumber Eksternal (keyless)"]
        BLS["BLS API v2"]
        FRED["FRED CSV"]
        YF["yfinance GC=F"]
        RSS["RSS feeds"]
        CFTC["CFTC COT"]
    end

    Browser -->|HTTPS| Web
    Web -->|internal /api/market/*| Files
    Web -->|REST/SSE| API
    API -->|read| Files
    API -->|optional| Postgres
    Worker -->|spawn| Python
    Python --> BLS
    Python --> FRED
    Python --> YF
    Python --> RSS
    API --> CFTC
    Python --> Files
```

---

## 5. Hubungan Antar Modul

1. **`packages/types`** adalah kontrak data tunggal (Zod) yang dipakai
   `database`, `core-analytics`, `api`, dan `web`.
2. **`packages/financial-clients`** mengisolasi pembacaan data (CSV parser
   tahan-quote, path portabel via `REPO_ROOT`) sehingga ganti sumber data tidak
   mengubah modul analitik.
3. **`packages/core-analytics`** berisi matematika event study murni (tanpa I/O),
   sehingga teruji unit secara terisolasi.
4. **`services/sentiment-analysis`** bersifat otonom: pipeline dapat dijalankan
   tanpa aplikasi TypeScript, dan sebaliknya aplikasi tetap berjalan dengan
   artifact yang sudah ada.
5. **`apps/web`** membaca pipeline output langsung (fallback) selain lewat API,
   sehingga chart tetap cepat walau API analitik sedang mati.

---

## 6. Integritas & Pelaporan

- Setiap angka analitik dapat ditelusuri ke sumbernya lewat
  `data/processed/provenance.json`.
- Model dilatih di atas fitur nyata; hasil yang tidak signifikan dilaporkan
  jujur (`sentiment_adds_value: false`), bukan dipaksa terlihat sebagai *alpha*.
- Regression tests menjaga: anti look-ahead (merge `backward`), provenance,
  signifikansi, dan skema fitur.
