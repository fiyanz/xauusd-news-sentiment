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
├── .agents/skills/         # Skill agent (Claude Code / Hermes)
├── turbo.json
└── package.json
```

---

## 2. Alur Data & ML (services/sentiment-analysis)

```mermaid
flowchart TB
    subgraph ACQ[Acquire — keyless / API]
        BLS[BLS API v2]
        FRED[FRED CSV]
        YF[yfinance GC=F]
        CAL[Calendar]
        RSS[RSS 9 feed + VADER]
        HF[HuggingFace news]
        GD[GDELT 2022]
        API[newsapi.org + GNews]
    end

    subgraph CORPUS[Korpus berita]
        NC[(news_corpus.jsonl<br/>35.100 artikel)]
    end

    subgraph RAW[Data mentah]
        DR[(data/raw<br/>price, macro, news)]
    end

    BLS --> DR
    FRED --> DR
    YF --> DR
    CAL --> DR
    RSS --> NC
    HF --> NC
    GD --> NC
    API --> NC

    DR --> H[harmonize<br/>merge_asof backward]
    NC --> H
    H --> F[features<br/>TF-IDF + embedding + PCA]
    F --> B[bucket 4H<br/>topic weights + surprise]
    B --> R[retrain]
    R --> S[significance<br/>paired bootstrap]
    R --> E[eval fair]
    R --> P[predict 4H]
    R --> O[reports + provenance]
    R --> M[(models/joblib)]
```

```text
price → intraday → macro → calendar → news → harmonize
      → features → buckets → retrain → evaluate → predict → provenance
```

Semua artifact membawa metadata *provenance* (`source`, `generated_at`,
`is_simulated`). Bila sumber gagal, nilai yang dikembalikan adalah
`unavailable`/NaN — bukan pengganti karangan.

### 2.1 Pilihan representasi teks

| Tahap | Modul | Keterangan |
|---|---|---|
| Tokenisasi + stemming | `features/text_preprocess.py` | Porter stemmer, stop words, TF-IDF n-gram (1,2) 300 fitur |
| Embedding kalimat | `features/embeddings.py` | sentence-transformers `all-MiniLM-L6-v2` (384 dim), PCA fit on train |
| Reduksi blok | `features/reduce.py` | PCA per blok (macro/topic/interaction/tfidf), 90% varians |
| Bobot topik | `features/topic_weights.py` | SMD return train, clip 0,25–2,0 |

### 2.2 Pipeline realtime

`src/pipeline/realtime.py` menjalankan siklus sync penuh berulang dengan jeda
`--interval` (default 30 menit). Status tercatat di
`data/processed/realtime_status.json`; loop berhenti anggun saat Ctrl+C dan
kegagalan satu siklus tidak menghentikan loop.

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
        Kaggle[("Kaggle dataset<br/>kyoushin/xauusd-news-sentiment-data")]
    end

    subgraph External["Sumber Eksternal (keyless / API)"]
        BLS["BLS API v2"]
        FRED["FRED CSV"]
        YF["yfinance GC=F"]
        RSS["RSS feeds"]
        CFTC["CFTC COT"]
        HF["HuggingFace"]
        GD["GDELT"]
        NEWS["newsapi.org / GNews"]
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
    Python --> HF
    Python --> GD
    Python --> NEWS
    API --> CFTC
    Python --> Files
    Files -.->|arsip data| Kaggle
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

## 7. Repositori & Penyimpanan Data

- **Repo GitHub** (`fiyanz/xauusd-news-sentiment`) hanya berisi **kode**.
  Data dan cache di-gitignore; riwayat pernah di-rewrite dengan
  `git-filter-repo` untuk menghapus cache parquet >100 MB.
- **Kaggle** menyimpan data olahan:
  `kyoushin/xauusd-news-sentiment-data` (korpus, fitur, bucket, harga, makro).
- **Skill agent** dipusatkan di `.agents/skills/`; `.claude/` dan `.hermes/`
  di-gitignore.

```mermaid
flowchart LR
    Kode["Repo GitHub<br/>kode + skill"] -->|pipeline menghasilkan| Data["Data olahan"]
    Data -->|unggah| Kaggle["Kaggle dataset"]
    Kaggle -->|unduh| Lokal["data/ lokal<br/>(gitignored)"]
    Lokal --> Kode
```
