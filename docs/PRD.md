# Product Requirements Document (PRD)
# Sistem Informasi Pasar Emas Otomatis & Analisis Dampak Rilis Berita Ekonomi (XAUUSD)

**Versi:** 1.0.0 (Production Blueprint)  
**Status:** Approved  
**Penulis:** Bagus Alfiyan Yusuf, Data Analyst Magang (PT Valbury Asia Futures)  
**Fondasi Arsitektur:** TypeScript Monorepo (Turborepo + pnpm)  
**Standar Kepatuhan:** Edukasi & Analisis Informasi (Bukan Sinyal Transaksi / Non-Advisory)

---

## 1. Ringkasan Eksekutif & Problem Statement

### 1.1 Latar Belakang Masalah
Di industri futures broker, materi edukasi, market outlook, dan ulasan harian nasabah mengenai pasar emas (XAUUSD) seringkali disusun secara manual dan subjektif. Narasi klasik seperti *"Emas biasanya turun drastis jika NFP kuat"* atau *"CPI tinggi selalu menekan harga emas"* kerap tidak didukung oleh angka historis empiris yang tervalidasi. 

Dampaknya:
1. **Inefisiensi Waktu**: Analis menghabiskan 1–2 jam per hari mengumpulkan data mentah secara berulang.
2. **Ketiadaan Bukti Kuantitatif**: Klaim edukasi rentan bias dan tidak memiliki metrik reliabilitas (*win rate*, *average reaction pips*, *retrace probability*).
3. **Data Silo**: Data rilis ekonomi dan candle historis tidak tersimpan dalam format terstruktur yang dapat diolah kembali.

### 1.2 Solusi Produk
Sebuah sistem informasi otomatis berbasis **TypeScript Monorepo** yang:
- Mengambil data harga XAUUSD (multi-timeframe) dan jadwal kalender ekonomi secara otomatis via Web API.
- Menghitung **Event Study Quant Engine** untuk mengukur reaksi harga emas pada jendela waktu $5$, $15$, dan $60$ menit pasca-rilis berita ekonomi berdampak tinggi (NFP, CPI, FOMC, PPI).
- Menyediakan dashboard interaktif (Next.js 15) untuk eksplorasi data, grafik reaksi harga, dan pembuat ringkasan harian (*Daily Market Digest*) otomatis dalam format Markdown/JSON/PDF.

---

## 2. Tujuan & Batasan (Scope & Non-Goals)

### 2.1 Tujuan Utama (Goals)
1. **Automated Pipeline**: Otomasi pengumpulan data harga XAUUSD dan kalender ekonomi harian dengan tingkat keberhasilan job $\ge 98\%$.
2. **Empirical Event Study**: Menyediakan kalkulasi kuantitatif dampak kejutan data makro (Surprise Index) terhadap pergerakan pips emas.
3. **Daily Digest Ready-to-Use**: Mengurangi waktu pembuatan ringkasan pasar dari 60+ menit menjadi $< 3$ menit dengan template otomatis.
4. **Clean TypeScript Architecture**: Menyediakan codebase monorepo yang modular, *type-safe* ujung-ke-ujung, dan mudah dirawat pengembang penerus.

### 2.2 Batasan Sistem (Non-Goals)
- **Bukan Robot Trading (EA)**: Sistem tidak memiliki koneksi eksekusi order ke broker.
- **Bukan Sinyal Investasi**: Sistem tidak mengeluarkan rekomendasi "BUY" atau "SELL". Semua keluaran wajib menyertakan legal disclaimer (FR-10).
- **Fokus Tunggal XAUUSD**: Tidak memproses pasangan mata uang forex lain atau instrumen kripto.
- **Tanpa PII Nasabah**: Sistem tidak menyimpan, meminta, atau memproses data pribadi nasabah maupun riwayat akun trading.

---

## 3. Persona Pengguna

| Persona | Peran | Kebutuhan Utama | Nilai Tambah Sistem |
| :--- | :--- | :--- | :--- |
| **Market Analyst** | Riset & Outlook | Analisis dampak rilis ekonomi dengan filter deviasi data. | Akses cepat ke statistik historis event sejenis dalam hitungan detik. |
| **Education Specialist** | Konten Edukasi | Ringkasan harian dan data pendukung infografis. | Template ringkasan pasar harian siap salin/ekspor. |
| **Head of Research / Pembimbing** | Evaluasi & Pengawasan | Memantau reliabilitas data dan pipeline kesehatan sistem. | Audit log pengumpulan data dan monitoring uptime ingestion. |
| **Software Engineer (Penerus)** | Pemeliharaan Sistem | Dokumentasi arsitektur, skema DB, dan tes kode. | TypeScript Monorepo yang modular dengan pipeline CI teruji. |

---

## 4. Kebutuhan Fungsional (Functional Requirements)

Prioritas: **Must Have (M)**, **Should Have (S)**, **Could Have (C)**.

| ID | Modul | Deskripsi Kebutuhan | Prioritas |
| :--- | :--- | :--- | :--- |
| **FR-01** | Ingestion | Pengambilan data harga XAUUSD (OHLCV timeframe 1m, 5m, 15m, 1h, 1d) via Web API terverifikasi (Alpha Vantage / Twelve Data / Yahoo Finance). | **M** |
| **FR-02** | Ingestion | Pengambilan jadwal kalender ekonomi global (jadwal rilis, currency USD, aktual, perkiraan, rilis sebelumnya, level dampak). | **M** |
| **FR-03** | Analytics | Perhitungan nilai kejutan ekonomi (*Surprise Score*) pada setiap rilis data makro. | **M** |
| **FR-04** | Analytics | Perhitungan reaksi harga XAUUSD pada jendela $5$, $15$, dan $60$ menit pasca-rilis (Direction, Delta Pips, Max Spike, Max Drawdown, Retrace Time). | **M** |
| **FR-05** | Analytics | Agregasi statistik event study per tipe berita (Mean, Median, Win-Rate kesesuaian arah, Deviasi Standar). | **M** |
| **FR-06** | Web UI | Dashboard utama menyajikan ticker harga terbaru, hitung mundur rilis berita berdampak tinggi, dan grafik intraday. | **M** |
| **FR-07** | Web UI | Halaman Event Study Explorer dengan visualisasi scatter plot (*Surprise vs $\Delta$ Price*) dan boxplot distribusi reaksi. | **M** |
| **FR-08** | Reporting | Generator otomatis Ringkasan Pasar Harian (*Daily Market Digest*) menggabungkan pergerakan harga, rilis hari ini, dan catatan teknis. | **M** |
| **FR-09** | Operations | Pencatatan log komprehensif pada setiap proses scraping/ingestion (sumber, status, durasi, jumlah baris data, pesan error). | **M** |
| **FR-10** | Compliance | Penegakan disclaimer hukum baku di setiap antarmuka dashboard dan berkas ekspor laporan. | **M** |
| **FR-11** | Ingestion | Pengambilan dan pemrosesan laporan mingguan CFTC Commitments of Traders (COT) untuk posisi institusional XAU. | **S** |
| **FR-12** | Reporting | Fitur ekspor laporan ringkasan dan tabel event study ke format Markdown, CSV, dan PDF. | **S** |
| **FR-13** | Analytics | Ekstraksi sentimen berita headline keuangan via NLP/LLM untuk scoring korelasi sentimen rilis berita. | **C** |

---

## 5. Metodologi Analisis & Formula Matematis (Event Study Engine)

### 5.1 Perhitungan Tingkat Kejutan Ekonomi (Economic Surprise Index)
Untuk setiap rilis data ekonomi $i$ dengan nilai aktual $A_i$, estimasi konsensus $F_i$, dan nilai periode sebelumnya $P_i$:

1. **Kasus Normal (Tersedia Konsensus Analis)**:
   $$\text{Surprise}_i = A_i - F_i$$
   
   *Standardized Surprise Score (Z-Score)*:
   $$Z_i = \frac{A_i - F_i}{\sigma_{(A - F)}}$$
   *(di mana $\sigma_{(A - F)}$ adalah standar deviasi selisih historis jenis event tersebut selama 24 bulan terakhir).*

2. **Kasus Fallback (Konsensus Tidak Tersedia)**:
   $$\text{Surprise Fallback}_i = A_i - P_i$$

### 5.2 Window Reaksi Harga (Price Reaction Windows)
Didefinisikan $T_0$ sebagai timestamp resmi rilis berita (standar UTC).  
Ambil harga acuan awal $P_{\text{base}} = \text{Close}(T_0 - 1\text{m})$.

Untuk setiap jendela waktu $W \in \{5\text{m}, 15\text{m}, 60\text{m}\}$:
1. **Perubahan Harga Bersih (Net Change)**:
   $$\Delta P_W = \text{Close}(T_0 + W) - P_{\text{base}}$$
   $$\Delta \text{Pips}_W = \frac{\Delta P_W}{\text{Tick Size}} \quad (\text{untuk XAUUSD: 1 pip} = \$0.10 \text{ atau 10 cents})$$

2. **Rentang Ekstrem (Max Spike & Drawdown)**:
   $$\text{Max Up}_W = \max_{t \in [T_0, T_0 + W]} \text{High}(t) - P_{\text{base}}$$
   $$\text{Max Down}_W = P_{\text{base}} - \min_{t \in [T_0, T_0 + W]} \text{Low}(t)$$

3. **Waktu Pembalikan Arah (Time to Retrace)**:
   $$T_{\text{retrace}} = \min \left\{ t \in [T_0, T_0 + 240\text{m}] \mid \text{Price}(t) \text{ menyentuh kembali } P_{\text{base}} \right\}$$

---

## 6. Desain Database Relasional (Drizzle ORM)

```text
+-------------------+       +-----------------------+       +------------------------+
|   event_types     |1     *|   economic_releases   |1     *|    event_reactions     |
+-------------------+-------+-----------------------+-------+------------------------+
| id (UUID, PK)     |       | id (UUID, PK)         |       | id (UUID, PK)          |
| code (VARCHAR)    |       | event_type_id (FK)    |       | release_id (FK)        |
| name (VARCHAR)    |       | release_date (TIMEST) |       | window_minutes (INT)   |
| country (VARCHAR) |       | actual (NUMERIC)      |       | base_price (NUMERIC)   |
| impact (ENUM)     |       | forecast (NUMERIC)    |       | end_price (NUMERIC)    |
| created_at        |       | previous (NUMERIC)    |       | delta_pips (NUMERIC)   |
+-------------------+       | surprise_val (NUMERIC)|       | max_spike_pips (NUM)   |
                            | z_score (NUMERIC)     |       | max_drawdown_pips(NUM) |
                            +-----------------------+       | is_retrace (BOOLEAN)   |
                                                            | retrace_minutes (INT)  |
                                                            +------------------------+

+---------------------+     +-----------------------+       +------------------------+
|    price_candles    |     |      cot_reports      |       |    daily_summaries     |
+---------------------+     +-----------------------+       +------------------------+
| id (BIGINT, PK)     |     | id (UUID, PK)         |       | id (UUID, PK)          |
| symbol (VARCHAR)    |     | report_date (DATE)    |       | report_date (DATE)     |
| timeframe (ENUM)    |     | non_comm_long (INT)   |       | open_price (NUMERIC)   |
| timestamp_utc (TIME)|     | non_comm_short (INT)  |       | high_price (NUMERIC)   |
| open (NUMERIC)      |     | net_position (INT)    |       | low_price (NUMERIC)    |
| high (NUMERIC)      |     | change_net (INT)      |       | close_price (NUMERIC)  |
| low (NUMERIC)       |     +-----------------------+       | headline_markdown(TEXT)|
| close (NUMERIC)     |                                     | disclaimer_notice(TEXT)|
| volume (NUMERIC)    |     +-----------------------+       +------------------------+
+---------------------+     |    collection_logs    |
                            +-----------------------+
                            | id (UUID, PK)         |
                            | source_name (VARCHAR) |
                            | job_type (ENUM)       |
                            | status (ENUM)         |
                            | rows_inserted (INT)   |
                            | execution_ms (INT)    |
                            | error_log (TEXT)      |
                            | executed_at (TIMEST)  |
                            +-----------------------+
```

---

## 7. Kebutuhan Non-Fungsional (NFR)

1. **Performa**:
   - Respon endpoint REST API $< 150\text{ ms}$ untuk $95\%$ query analitik.
   - Initial load dashboard Next.js $< 1.8\text{ detik}$ (First Contentful Paint) dengan Server Components (RSC).
2. **Keandalan & Ketahanan (Reliability)**:
   - Worker job dilengkapi retry exponential backoff (3x percobaan) saat external rate limit tercapai.
   - Transaksi database atomik (ACID) saat ingest batch candle harga dan perhitungan reaksi.
3. **Integritas Waktu (Time Synchronization)**:
   - Semua pencatatan data wajib disimpan dalam zona waktu **UTC (ISO-8601)**. Konversi ke WIB (UTC+7) hanya dilakukan pada layer tampilan presentation.
4. **Keamanan (Security)**:
   - Seluruh API Key (Alpha Vantage, Twelve Data, DB connection) dikelola melalui environment variables (`.env`).
   - Rate limiting pada publik API endpoint untuk mencegah scraping liar.

---

## 8. Kepatuhan & Disclaimer Baku (FR-10)

Setiap halaman web dan berkas laporan yang diunduh wajib mencantumkan klausul disclaimer berikut:

> *"Pemberitahuan Kepatuhan: Seluruh data, grafik, dan analisis historis yang disajikan dalam sistem ini bertujuan murni sebagai materi edukasi dan informasi riset internal pasar. Sistem ini tidak memberikan sinyal perdagangan, rekomendasi investasi, maupun ajakan untuk bertransaksi derivatif keuangan. PT Valbury Asia Futures tidak bertanggung jawab atas keputusan finansial independen yang diambil pengguna."*
