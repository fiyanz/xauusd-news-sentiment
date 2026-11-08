# Arsitektur Pipeline Data Real-Time: Streaming & Persistensi Database (XAU/USD)

Dokumen ini merinci arsitektur teknis sistem penanganan data pasar finansial berkecepatan tinggi: mengonsumsi data dari API pihak ketiga (broker feed), memancarkan (*streaming*) ke antarmuka terminal secara instan, serta menyimpan riwayat lilin (*candles*) ke PostgreSQL secara efisien tanpa membekukan database.

---

## 1. Problem Statement & Bottleneck Analysis

Dalam sistem data pasar finansial dengan tick berfrekuensi tinggi (50–100 tick/detik):

```
[Problem: Arsitektur Naif / Monolitik]
Feed Broker ──(100 tick/s)──> Backend ──(100 INSERT/s)──> Database (LOCKUP!)
                                  │
                             (Query SQL)
                                  │
                                  ▼
                               Client (Lag > 200ms)
```

1. **Write-Amplification (Database Lockup)**:
   - Jika setiap tick harga yang datang langsung dieksekusi `INSERT` ke PostgreSQL, *connection pool* akan habis dan disk I/O mengalami kejenuhan (*saturation*). Database akan lambat atau mengalami *deadlock*.
2. **Read Latency (Jeda Waktu Broadcast)**:
   - Jika client mengambil data streaming dengan cara membaca query database secara terus-menerus (*polling*), latensi pengiriman harga ke grafik akan lambat (>150–300ms), memicu *chart lag* dan pengalaman trading yang buruk.
3. **Data Loss saat Reconnect**:
   - Jika koneksi WebSocket pihak ketiga terputus sesaat, grafik client bisa bolong (*gap*) jika tidak ada mekanisme rekonsiliasi riwayat.

---

## 2. Solusi Desain: Arsitektur Dual-Path (Hot Path & Warm Path)

Untuk mengatasi bottleneck di atas, aliran data dipisahkan menjadi dua jalur independen:

```
                            ┌───────────────────────────────────┐
                            │    3rd-Party Market Feed API      │
                            │ (WebSocket / FIX Protocol / MT5)  │
                            └─────────────────┬─────────────────┘
                                              │ Ticks (50-100/s)
                                              ▼
                            ┌───────────────────────────────────┐
                            │      apps/worker (Ingest Engine)  │
                            │   - Deduplikasi sequence          │
                            │   - UTC Timestamp normalizer      │
                            └───────┬───────────────────┬───────┘
                                    │                   │
         ┌──────────────────────────┘                   └──────────────────────────┐
         │ (Hot Path: Real-Time Tick)                                              │ (Warm Path: OHLCV Rollup)
         ▼                                                                         ▼
┌───────────────────────────────────┐                             ┌───────────────────────────────────┐
│     In-Memory Ring Buffer         │                             │     Time-Bucket Aggregator        │
│   - Circular Array (1.000 tick)   │                             │   - Rollup M1, M5, H1, D1         │
│   - Zero Disk I/O, RAM only       │                             │   - Track Open, High, Low, Volume │
└─────────────────┬─────────────────┘                             └─────────────────┬─────────────────┘
                  │ Publish delta                                                   │ Bar closed / Period 5s
                  ▼                                                                 ▼
┌───────────────────────────────────┐                             ┌───────────────────────────────────┐
│    Fastify Streaming Gateway      │                             │     Async Batch DB Writer         │
│   - apps/api (:4000)              │                             │   - In-memory write queue         │
│   - Endpoint /market/stream (SSE) │                             │   - Flush tiap 5 detik            │
└─────────────────┬─────────────────┘                             └─────────────────┬─────────────────┘
                  │ SSE Tick delta                                                  │ Single Batch INSERT
                  ▼                                                                 ▼
┌───────────────────────────────────┐                             ┌───────────────────────────────────┐
│    Browser Terminal Client        │ <───── REST (?tf=1h&to=ts) ──── │      PostgreSQL Database          │
│   - apps/web (:3001)              │     Cold Path: Window Load  │   - Table: candles                │
│   - candleSeries.update(tick)     │      & Infinite Scroll      │   - Composite index time-series   │
│   - 60 FPS, No Lag (< 10ms)       │                             │   - Anti-deadlock upsert          │
└───────────────────────────────────┘                             └───────────────────────────────────┘
```

---

## 3. Rincian Komponen Pipeline

### A. Hot Path: Real-Time Broadcast (< 10ms Latency)
- **Tujuan**: Menjamin harga di layar terminal bergerak seketika begitu tick tiba dari broker.
- **Mekanisme**:
  1. `apps/worker` menerima tick mentah `{ symbol, bid, ask, last, volume, timestamp }`.
  2. Data langsung dikirim ke `In-Memory Ring Buffer` di memori RAM tanpa menyentuh disk/database.
  3. `Fastify Streaming Gateway` menyiarkan payload delta tick via Server-Sent Events (SSE) atau WebSocket ke browser client yang sedang terhubung.
  4. Grafik terminal (`Lightweight Charts`) menerima tick dan langsung mengeksekusi `candleSeries.update()`. Hanya lilin aktif di ujung kanan yang bergerak.

### B. Warm Path: Agregasi Candle & Batch Persistensi Database
- **Tujuan**: Menyimpan data pasar secara terstruktur ke PostgreSQL tanpa membebani disk I/O.
- **Mekanisme**:
  1. `Time-Bucket Aggregator` mengelompokkan tick ke dalam bucket waktu (`1m`, `5m`, `15m`, `1h`, `4h`, `1D`).
  2. Lilin dihitung secara in-memory:
     - `Open`: harga tick pertama dalam periode.
     - `High`: harga tertinggi dalam periode.
     - `Low`: harga terendah dalam periode.
     - `Close`: harga tick terakhir saat ini.
     - `Volume`: akumulasi volume transaksi.
  3. Saat candle menutup (misal pergantian menit atau jam), bar dimasukkan ke antrean *Write-Behind*.
  4. `Batch DB Writer` melakukan *bulk insert* ke PostgreSQL setiap interval 5 detik atau saat antrean mencapai ukuran tertentu:
     ```sql
     INSERT INTO candles (symbol, timeframe, timestamp_utc, open, high, low, close, volume)
     VALUES (...)
     ON CONFLICT (symbol, timeframe, timestamp_utc)
     DO UPDATE SET high = EXCLUDED.high, low = EXCLUDED.low, close = EXCLUDED.close, volume = EXCLUDED.volume;
     ```
  5. Beban query ke database terpangkas dari **100 query/detik menjadi hanya 1 query per 5 detik** (efisiensi 99%).

### C. Cold Path: Windowed Pagination & Infinite Scroll
- **Tujuan**: Menghindari pengiriman 97.000 bar data historis ke browser sekaligus.
- **Mekanisme**:
  1. Saat terminal pertama dibuka, client hanya meminta 250 bar terakhir via REST endpoint:
     `GET /api/market/candles?tf=1h&limit=250`
  2. Ukuran transfer awal sangat kecil (~35 KB), waktu inisialisasi render < 50ms.
  3. Saat pengguna menggeser (*scroll*) grafik ke kiri/masa lampau, client meminta chunk 200 bar sebelumnya:
     `GET /api/market/candles?tf=1h&limit=200&to=<earliest_timestamp>`
  4. Lilin lama disambungkan di depan dataset secara mulus tanpa me-reset posisi zoom pengguna.

### D. Crash Recovery & Gap Healing
- Jika server mati atau koneksi broker terputus selama 15 menit:
  1. Saat worker menyala kembali, worker membaca `SELECT MAX(timestamp_utc) FROM candles WHERE timeframe = '1m'`.
  2. Worker memanggil API historis broker pihak ketiga untuk meminta bar yang hilang antara timestamp terakhir di database dan waktu UTC sekarang (`start = last_db_ts, end = now_utc`).
  3. Bar yang hilang dimasukkan ke database sebelum membuka kembali stream realtime. Lilin pada grafik tidak akan terputus.

---

## 4. Opsi Arsitektur (Brainstorming & Evaluasi Trade-Off)

| Kriteria | Opsi 1: In-Memory Ring Buffer (Rekomendasi) | Opsi 2: Redis Pub/Sub + Stream | Opsi 3: Apache Kafka / Redpanda |
|---|---|---|---|
| **Infrastruktur** | **Zero-Dependency** (Cukup Bun / Fastify & PostgreSQL) | Butuh instance Redis terpisah | Butuh cluster Kafka + Zookeeper/KRaft |
| **Beban RAM** | Sangat Ringan (< 30 MB) | Sedang (~100 MB) | Berat (> 1 GB) |
| **Kompleksitas** | **Rendah** (Cocok untuk skala proyek/magang saat ini) | Menengah | Sangat Tinggi (Overkill) |
| **Skalabilitas** | Single Node / Monorepo efisien | Multi-Instance worker & API | Enterprise multi-broker exchange |
| **Ketahanan Data** | Buffer di RAM, candle terkonfirmasi di PostgreSQL | Buffer di Redis AOF | Persistent log di disk cluster |
| **Rekomendasi** | **Sangat Dianjurkan (Sesuai YAGNI & Clean Code)** | Alternatif jika API dipecah multi-server | Tidak disarankan untuk fase ini |

---

## 5. Ringkasan Implementasi Teknis

1. **Paket Worker (`apps/worker`)**:
   - Menjalankan konektor WebSocket feed pihak ketiga.
   - Menghimpun tick ke agregator OHLCV lokal.
   - Mengirim batch update ke PostgreSQL via Drizzle ORM setiap 5 detik.
2. **Paket API (`apps/api`)**:
   - Endpoint `/api/v1/market/xauusd/stream`: Memancarkan tick harga realtime via Server-Sent Events (SSE).
   - Endpoint `/api/v1/market/xauusd/candles`: Melayani chunk candle historis dengan parameter `to` dan `limit`.
3. **Frontend Dashboard (`apps/web`)**:
   - Menerima tick realtime via SSE dan memperbarui lilin aktif via `candleSeries.update()`.
   - Mengambil data chunk historis saat scroll ke kiri via `subscribeVisibleLogicalRangeChange()`.
   - Menyimpan posisi zoom dan timeframe di `localStorage` agar tidak reset saat browser di-refresh.
