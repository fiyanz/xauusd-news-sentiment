# Arsitektur Sistem Informasi Pasar Emas (XAUUSD) & Analisis Dampak Berita

Dokumen ini menjelaskan struktur arsitektur teknis, desain monorepo TypeScript, dan diagram pemodelan sistem formal (**Activity Diagram**, **Sequence Diagram**, dan **Deployment Diagram**).

---

## 1. Desain Struktur Monorepo (Turborepo + pnpm)

Sistem menggunakan arsitektur monorepo modular untuk memastikan integritas tipe (*end-to-end type safety*), *code reuse*, dan isolasi dependensi:

```text
sistem-informasi-market-xauusd/
├── apps/
│   ├── web/                     # Next.js 15 App Router (Dashboard UI, Recharts, Server Actions)
│   ├── api/                     # Fastify / Hono TS (High-throughput REST API Service)
│   └── worker/                  # BullMQ / Cron Ingestion Service (Background Tasks)
├── packages/
│   ├── database/                # Drizzle ORM Schema, PostgreSQL Client, Migrations
│   ├── core-analytics/          # Event Study Math Engine, Surprise Formula, Statistics
│   ├── financial-clients/       # Ingestion Adapters (Alpha Vantage, Twelve Data, COT Parser)
│   ├── types/                   # Zod Schemas, Domain Enums, Shared Interfaces
│   ├── ui/                      # Shared UI Components (Tailwind v4, Radix Primitives)
│   ├── eslint-config/           # Shared Linting Rules
│   └── tsconfig/                # Base TypeScript Configs (Strict Mode)
├── docs/                        # Dokumentasi Sistem, PRD & Architecture
├── turbo.json                   # Pipeline task caching configuration
├── pnpm-workspace.yaml          # Workspace mapping
└── package.json                 # Monorepo root manifest
```

---

## 2. Activity Sequence Diagram (Pipeline Otomatisasi & Ringkasan Harian)

Diagram sekuens aktivitas di bawah menggambarkan seluruh tahapan alur kerja proses bisnis (*activity workflow*) dari trigger cron scheduler, ingestion data, validasi, kalkulasi event study, hingga publikasi daily digest:

```mermaid
sequenceDiagram
    autonumber
    participant Cron as Cron / Scheduler Trigger
    participant IngestService as Worker Ingestion Service
    participant CalendarAPI as External Calendar API
    participant PriceAPI as External Price API
    participant Validator as Zod Schema Validator
    participant DB as PostgreSQL Database
    participant Analytics as Event Study Engine
    participant Digest as Daily Digest Generator
    participant Audit as Audit Log Service

    %% Step 1: Trigger & Ingestion
    Cron->>IngestService: Trigger Jadwal Ingestion (Daily / Intraday)
    activate IngestService
    
    par Ambil Kalender Ekonomi
        IngestService->>CalendarAPI: Request Economic Calendar Events
        CalendarAPI-->>IngestService: Raw Calendar Data (JSON)
        IngestService->>Validator: Validate Releases Schema
        Validator-->>IngestService: Valid Release Records
    and Ambil Data Harga XAUUSD
        IngestService->>PriceAPI: Request OHLCV Candles (1m, 5m, 15m)
        PriceAPI-->>IngestService: Raw Candle Data (JSON)
        IngestService->>Validator: Validate Candles Schema
        Validator-->>IngestService: Valid Candle Records
    end

    %% Step 2: Persistence
    IngestService->>DB: Batch Upsert economic_releases & price_candles
    DB-->>IngestService: Rows Inserted Acknowledged

    %% Step 3: Event Study Processing
    IngestService->>Analytics: Trigger calculateEventImpact(releases)
    activate Analytics
    Analytics->>DB: Fetch 5m, 15m, 60m Pre/Post Event Price Windows
    DB-->>Analytics: Return Price Windows
    Analytics->>Analytics: Compute Surprise Score (Actual - Forecast)
    Analytics->>Analytics: Compute Delta Pips, Max Spike, Max Drawdown, Retrace
    Analytics->>DB: INSERT INTO event_reactions
    DB-->>Analytics: Reactions Saved
    deactivate Analytics

    %% Step 4: Daily Digest Compilation
    IngestService->>Digest: Trigger generateDailyDigest()
    activate Digest
    Digest->>DB: Fetch Today's Price Range, Impact Events, COT Position
    DB-->>Digest: Market Data Summary
    Digest->>Digest: Format Markdown / JSON Summary
    Digest->>Digest: Append Mandatory Compliance Disclaimer (FR-10)
    Digest->>DB: INSERT INTO daily_summaries
    DB-->>Digest: Summary Saved
    deactivate Digest

    %% Step 5: Audit Logging
    IngestService->>Audit: Record Job Run (Status: SUCCESS, Total Rows, Duration)
    Audit->>DB: INSERT INTO collection_logs
    deactivate IngestService
```

---

## 3. Sequence Diagram

Diagram sekuens ini memodelkan interaksi saat Market Analyst membuka **Event Study Explorer** di web dashboard untuk menganalisis dampak rilis NFP terhadap XAUUSD:

```mermaid
sequenceDiagram
    autonumber
    actor Analyst as Market Analyst / Edu Team
    participant Web as Web Dashboard (Next.js 15)
    participant API as API Gateway (Fastify TS)
    participant Engine as Core Analytics Engine
    participant DB as PostgreSQL Database
    participant Worker as Background Ingestion Worker
    participant External as Financial Web API (Data Provider)

    %% Background Ingestion Loop (Reference)
    Note over Worker, External: Background Cron Ingestion Phase
    Worker->>External: GET /economic-calendar & /xauusd-candles
    External-->>Worker: Raw JSON Data
    Worker->>Worker: Validate Data (Zod Schema)
    Worker->>DB: Upsert economic_releases & price_candles
    Worker->>Engine: Run calculateReactionWindows(releaseId)
    Engine->>DB: Query 5m/15m/60m Price Windows
    DB-->>Engine: Candle Records
    Engine->>Engine: Calculate Surprise Z-Score & Delta Pips
    Engine->>DB: INSERT INTO event_reactions
    Worker->>DB: INSERT INTO collection_logs (Status: SUCCESS)

    %% User Request Flow
    Note over Analyst, DB: User Interactive Query Phase
    Analyst->>Web: Akses Menu "Event Study Explorer" (Select Event: NFP)
    Web->>API: GET /api/v1/analytics/event-study/NFP?window=15m
    API->>DB: Query event_reactions JOIN economic_releases
    DB-->>API: Array of Reactions (Surprise, DeltaPips, MaxSpike)
    
    API->>Engine: aggregateDistributionStats(reactions)
    Engine-->>API: Stats Object (Mean, Median, DirectionalConsistency, BoxPlotIQR)
    
    API-->>Web: JSON Response (Historical Reactions + Aggregated Metrics)
    Web->>Web: Render Scatter Plot (Surprise vs Delta Pips)
    Web->>Web: Render Boxplot & Compliance Disclaimer (FR-10)
    Web-->>Analyst: Tampilan visual interaktif siap dianalisis
```

---

## 4. Deployment Diagram

Diagram penyebaran sistem menggambarkan topologi infrastruktur fisik/container di lingkungan produksi:

```mermaid
graph TB
    subgraph Client_Tier [Client Device & Browser]
        Browser["Web Browser (Desktop / Mobile)\n- Next.js Client Components\n- Recharts Visualization"]
    end

    subgraph Cloud_Infrastructure [Production Cloud Platform / VPS Linux]
        subgraph Ingress_Layer [Ingress & Reverse Proxy]
            Nginx["Nginx Reverse Proxy / Cloudflare Edge\n- SSL Termination (HTTPS)\n- DDoS & WAF Protection"]
        end

        subgraph Container_Cluster [Docker Container Services]
            Web_App["Container: apps/web\n- Next.js 15 Node Server\n- Port 3000\n- Server Actions & SSR"]
            API_App["Container: apps/api\n- Fastify TypeScript API\n- Port 4000\n- High Throughput REST"]
            Worker_App["Container: apps/worker\n- Node.js Cron Worker\n- BullMQ Job Processor"]
        end

        subgraph Data_Storage [Persistent Storage Tier]
            Postgres[("PostgreSQL 16 Database\n- Relational Data & Indexes\n- Port 5432\n- Docker Volume Mounted")]
            Redis[("Redis 7 In-Memory Cache\n- BullMQ Job Queue\n- API Response Cache\n- Port 6379")]
        end
    end

    subgraph External_Providers [External Financial Web APIs]
        AlphaVantage["Alpha Vantage / Twelve Data API\n(XAUUSD Realtime & Historical Price)"]
        ForexCal["ForexFactory / Finnhub API\n(Economic Calendar Feed)"]
        CFTC["CFTC Public Data\n(Weekly COT Reports)"]
    end

    %% Network Connections
    Browser -->|HTTPS :443| Nginx
    Nginx -->|Proxy Pass :3000| Web_App
    Nginx -->|Proxy Pass :4000| API_App
    
    Web_App -->|Internal HTTP REST| API_App
    API_App -->|Query / Pool| Postgres
    API_App -->|Read / Write Cache| Redis
    
    Worker_App -->|BullMQ Queue Management| Redis
    Worker_App -->|Batch Write Data & Logs| Postgres
    Worker_App -->|HTTPS Outbound API Calls| AlphaVantage
    Worker_App -->|HTTPS Outbound API Calls| ForexCal
    Worker_App -->|HTTPS Outbound API Calls| CFTC
```

---

## 5. Ringkasan Hubungan Antar Modul

1. **`packages/types`** menjadi jangkar kontrak data tunggal yang diimpor oleh `packages/database`, `packages/core-analytics`, `apps/api`, dan `apps/web`.
2. **`packages/financial-clients`** mengisolasi integrasi API eksternal sehingga pergantian provider data harga (misal dari Twelve Data ke Alpha Vantage) tidak mempengaruhi modul analitik atau database.
3. **`apps/worker`** bertanggung jawab menjaga ketersediaan data secara otonom tanpa membebani server web interaktif.
4. **`apps/web`** berfokus pada pengalaman pengguna yang cepat melalui *React Server Components* (RSC) dan rendering visualisasi data pasar emas yang bersih.
