# Rencana Implementasi: Analisis Sentimen Berita untuk XAUUSD (Dikerjakan Agent)

Penulis: Bagus Alfiyan Yusuf  
Versi: 1.0 (Senior Quant Diagnosis & Revised Roadmap)  
Tanggal: 5 November 2026  

## 0. Cara Memakai Dokumen Ini

Dokumen ini ditulis agar dapat dikerjakan coding agent secara bertahap. Aturan kerja untuk agent:

1. Kerjakan per fase roadmap 6-langkah. Jangan lanjut ke fase berikutnya sebelum kriteria selesai fase saat ini terpenuhi dan dilaporkan.
2. Semua parameter (horizon, ambang, tanggal, instrumen makro, path) ada di `config.yaml`, tidak ditulis langsung di kode.
3. Semua waktu disimpan dalam UTC tanpa pengecualian.
4. Kunci API hanya dibaca dari variabel lingkungan atau `.env`, tidak pernah masuk repositori.
5. **Zero Lookahead Enforced**: Tidak ada informasi yang baru tersedia setelah waktu $t_0$ yang boleh masuk ke fitur. Semua data makro harian wajib di-lag 1 hari bursa (`shift(1)`).
6. Set uji (test) hanya dipakai satu kali, di fase evaluasi akhir.
7. Tiap fase menghasilkan berkas keluaran dan catatan singkat `reports/phase_N.md` berisi apa yang dikerjakan, angka kunci, dan masalah yang ditemukan.
8. Berhenti dan tanya manusia pada titik bertanda [CHECKPOINT].

---

## 1. Tujuan dan Batasan

**Pertanyaan utama:** Apakah sinyal sentimen teks berita dan rilis ekonomi memberikan nilai tambah prediktif (*incremental alpha*) terhadap pergerakan *continuous return* XAUUSD di atas faktor makro fundamental (Yields, DXY, Oil)?

**Keluaran:**
1. Pipeline data yang dapat dijalankan ulang dari nol (end-to-end reproducible).
2. Point-in-Time Macro Context Ingestion & Alignment engine.
3. Baseline Fundamental Makro dan Model Sentimen Teks Komparatif.
4. Laporan evaluasi kuantitatif yang jujur (Rank IC, Quintile Spread, Directional Hit Ratio).

**Di luar cakupan:** Sinyal atau rekomendasi transaksi eksekusi order (FR-10 compliant). Seluruh keluaran bersifat analisis informasi dan pengujian hipotesis empiris.

---

## 2. Senior Diagnosis & Prinsip Metodologi

Evaluasi kritis atas draf awal mengidentifikasi bias dan keterbatasan metodologis yang diperbaiki melalui 5 pilar kuantitatif:

1. **No Hardcoded Multipliers (`* -1`)**:
   - *Masalah*: Aturan manual seperti membalik skor sentimen (`score * -1`) berasumsi linearitas kaku antara sentimen berita umum dan emas, padahal hubungan sentimen sangat bergantung pada topik (misal: "inflasi naik" vs "suku bunga naik").
   - *Solusi*: Biarkan model (LightGBM/Ridge) mempelajari interaksi non-linear secara mandiri melalui *interaction features* (`sentiment_score * topic_weight`, `surprise_zscore * event_type`).

2. **Point-in-Time Lagged Market Context (US10Y, US2Y, DXY, Oil)**:
   - *Masalah*: Memprediksi pergerakan emas tanpa memperhitungkan variabel pendorong utama (imbal hasil obligasi AS, dolar, dan harga minyak) menimbulkan *omitted variable bias*.
   - *Solusi*: Tambahkan data harian US10Y (`^TNX`), US2Y, DXY (`DX-Y.NYB`), dan WTI Crude Oil (`CL=F`). Seluruh variabel makro wajib di-lag 1 hari (`shift(1)`) untuk menjamin kepatuhan *Point-in-Time* (pada tanggal $T$, hanya data $T-1$ yang dapat diakses; nol kebocoran masa depan).

3. **Unit Analisis 4H Buckets & Event Windows**:
   - *Masalah*: Evaluasi per-artikel mentah menciptakan redundansi tinggi akibat sindikasi berita serupa (kluster artikel identik dalam hitungan menit) yang mendistorsi bobot sampel.
   - *Solusi*: Ubah unit analisis utama menjadi agregasi bucket 4-jam (4H) serta jendela event (*event windows* ±2 jam sekitar rilis ekonomi berdampak tinggi).

4. **Continuous Returns sebagai Target Utama**:
   - *Masalah*: Diskretisasi 3 kelas (naik/turun/datar) dengan ambang arbitrer membuang besaran informasi return (*magnitude loss*) dan membuat metrik F1 rentan terhadap ketidakseimbangan kelas buatan.
   - *Solusi*: Gunakan *continuous return* pada horizon 4H dan 24H sebagai target regresi primer. Evaluasi menggunakan metrik standar industri kuantitatif:
     - **Spearman Rank IC (Information Coefficient)**: Korelasi rank antara prediksi dan return aktual.
     - **Quintile Return Spread**: Selisih return rata-rata quintile teratas (Q5) dan terbawah (Q1).
     - **Directional Hit Ratio**: Akurasi tebakan arah tanda (+/-).

5. **Mandatory Fair Baseline Comparison (Macro vs Full)**:
   - *Masalah*: Membandingkan model teks langsung dengan random guess atau majority-class tidak membuktikan apakah teks berita berguna, atau model hanya menangkap tren makro.
   - *Solusi*: Mandatkan perbandingan bertingkat: **Macro Baseline** (Yields + DXY + Oil + Calendar Surprise) versus **Full Multi-Modal Model** (Macro Context + Text Sentiment Features) untuk mengisolasi alpha inkremental murni dari teks.

---

## 3. Deskripsi Data & Struktur Fitur

### 3.1 Berita Mentah (Alpha Vantage)
Kolom: `title`, `url`, `time_published`, `summary`, `source`, `topics`, `overall_sentiment_score` (-1 s.d. +1), `ticker_sentiment`. Waktu terbit distandardisasi ke UTC.

### 3.2 Harga XAUUSD (MetaTrader 5 / Histori H1 & M5)
Kolom: `time` (UTC), `open`, `high`, `low`, `close`, `volume`, `spread`.

### 3.3 Kalender Ekonomi (Economic Surprise)
Kolom: `timestamp_utc`, `event_name`, `actual`, `forecast`, `previous`, `surprise_val`, `z_score`.

### 3.4 Data Konteks Makro Point-in-Time (Yahoo Finance / FRED)
Data harian yang di-unduh dari 2010 hingga 2026:
- US 10-Year Treasury Yield (`^TNX`): Tingkat suku bunga acuan jangka panjang.
- US Dollar Index (`DX-Y.NYB`): Kekuatan relatif USD terhadap sekeranjang mata uang.
- WTI Crude Oil (`CL=F`): Proksi ekspektasi inflasi energi dan komoditas.
- US 2-Year Treasury Yield (`^IRX` / US2Y): Proksi ekspektasi suku bunga Fed jangka pendek.

Transformasi fitur makro:
- `delta_1d`: Perubahan 1 hari ($P_{t-1} - P_{t-2}$).
- `delta_5d`: Perubahan 5 hari bursa ($P_{t-1} - P_{t-6}$).
- **Aturan PIT**: Seluruh nilai dan perubahan di-shift 1 periode (`shift(1)`), menjamin data pada tanggal $T$ hanya menggunakan nilai penutupan $T-1$.

### 3.5 Tabel Modeling Terpadu (4H Buckets / Event Windows)
Satu baris per bucket 4-jam atau per event window:

| Kolom | Tipe | Keterangan |
| :--- | :--- | :--- |
| `bucket_time_utc` | Datetime | Waktu awal bucket (UTC) |
| `macro_us10y_lag1d`, `macro_us10y_delta1d`, `macro_us10y_delta5d` | Float | Fitur Yields 10Y ber-lag PIT |
| `macro_dxy_lag1d`, `macro_dxy_delta1d`, `macro_dxy_delta5d` | Float | Fitur DXY ber-lag PIT |
| `macro_oil_lag1d`, `macro_oil_delta1d`, `macro_oil_delta5d` | Float | Fitur WTI Oil ber-lag PIT |
| `cal_event_count`, `cal_max_surprise_zscore` | Float | Fitur kalender ekonomi pada window |
| `news_count` | Int | Jumlah artikel dalam bucket |
| `news_mean_sentiment`, `news_std_sentiment` | Float | Rata-rata dan dispersi sentimen berita |
| `interact_sent_monetary`, `interact_sent_macro` | Float | Interaksi `sentiment_score * topic_relevance` |
| `interact_surprise_event` | Float | Interaksi `surprise_zscore * event_type` |
| `vol_pre_4h` | Float | Realized volatility harga sebelum awal bucket |
| `target_ret_4h` | Float | Continuous return $t_0 \to t_0 + 4H$ |
| `target_ret_24h` | Float | Continuous return $t_0 \to t_0 + 24H$ |
| `split` | Category | `train`, `val`, `test` |

---

## 4. Pengolahan Data & Penanganan Anti-Lookahead

1. **Sinkronisasi Waktu Ketat**: Seluruh timestamp dikonversi ke ISO-8601 UTC.
2. **Pembersihan Celah & Forward-Fill Terkendali**: Data makro yang libur diisi dengan *forward-fill* harian historis sebelum dilakukan lag `shift(1)`.
3. **Pemisahan Data Berurutan (Out-of-Time Split)**:
   - Train: 60% awal.
   - Validation: 20% berikutnya.
   - Test: 20% akhir.
   - Diterapkan *embargo buffer* sebesar 24 jam antar split untuk mencegah autokorelasi return tumpang tindih.

---

## 5. Rekayasa Fitur & Interaksi Non-Linear

Tidak menggunakan formula statis `* -1`. Seluruh interaksi direkayasa secara eksplisit:
1. **Interaksi Topik Berita**:
   $$\text{feature\_topic\_interact} = \text{overall\_sentiment\_score} \times \text{relevance\_score}_{\text{topic}}$$
2. **Interaksi Kejutan Makro**:
   $$\text{feature\_surprise\_interact} = \text{z\_score} \times \mathbb{I}_{\text{event\_type}}$$
3. **Cross-Asset Interaction**:
   $$\text{feature\_macro\_sentiment\_interact} = \text{news\_mean\_sentiment} \times \text{macro\_dxy\_delta1d}$$

---

## 6. Hierarki Model & Protokol Evaluasi Komparatif

### 6.1 Daftar Model Eksperimen
1. **B0 (Mean Target Baseline)**: Prediksi konstan rata-rata return historis.
2. **B_Macro (Pure Macro Baseline)**: Model regresi (Ridge / LightGBM) hanya menggunakan fitur PIT Macro (US10Y, DXY, Oil, Calendar Surprise) tanpa fitur teks berita.
3. **M_TextOnly**: Model hanya menggunakan skor sentimen berita, topik, dan volatilitas historis.
4. **M_Full (Multi-Modal Champion Candidate)**: Model menggabungkan fitur Makro PIT + Calendar Surprise + Teks Sentimen + Fitur Interaksi.

### 6.2 Metrik Kuantitatif Primer
1. **Spearman Rank IC**:
   $$\text{Rank IC} = \text{corr}_{\text{Spearman}}(\hat{y}, y)$$
   Target: Rank IC $> 0.05$ dengan p-value $< 0.05$ pada out-of-time test set.
2. **Quintile Return Spread ($Q_5 - Q_1$)**:
   Selisih return aktual antara 20% prediksi tertinggi ($Q_5$) dan 20% prediksi terendah ($Q_1$). Spread positif yang konsisten membuktikan daya pisah sinyal prediktif.
3. **Directional Hit Ratio**:
   $$\text{Hit Ratio} = \frac{1}{N} \sum_{i=1}^N \mathbb{I}(\text{sign}(\hat{y}_i) == \text{sign}(y_i))$$
   Harus secara statistik signifikan di atas 50%.
4. **Incremental Alpha Test**:
   $$\Delta \text{Rank IC} = \text{Rank IC}_{\text{M\_Full}} - \text{Rank IC}_{\text{B\_Macro}}$$
   Jika $\Delta \text{Rank IC} \le 0$, maka teks berita terbukti tidak memberikan alpha tambahan di luar makro.

---

## 7. Rencana Kerja 6-Langkah (Roadmap Eksekusi)

| Fase | Nama Tugas | Deskripsi Teknis | Keluaran & Kriteria Selesai |
| :---: | :--- | :--- | :--- |
| **Fase 1** | **PIT Macro Context Acquisition** | Unduh harian US10Y (`^TNX`), DXY (`DX-Y.NYB`), WTI Oil (`CL=F`) via yfinance (2010–2026). Hitung `delta_1d`, `delta_5d`, dan enforce `shift(1)` lag. | File `data/raw/macro/macro_context.csv`, unit test `tests/test_macro.py` lolos. |
| **Fase 2** | **4H Bucketing & Event Windows** | Agregasi artikel berita mentah ke dalam bucket 4-jam dan jendela event ekonomi (±2H) untuk mengeliminasi redundansi sindikasi. | Dataset `data/interim/bucketed_4h_events.parquet`, lolos uji agregasi waktu. |
| **Fase 3** | **Interaction Feature Engineering** | Bangun interaksi non-linear (`score * topic`, `surprise * event`, makro x teks) tanpa hardcoded inversion `* -1`. | Pipeline `src/features/interactions.py`, matriks fitur bersih tanpa NaN. |
| **Fase 4** | **Target Reformation** | Ekstraksi continuous returns (4H dan 24H) dari harga XAUUSD H1/M5. | Kolom target `ret_4h` dan `ret_24h` terverifikasi monotonic time alignment. |
| **Fase 5** | **Dual-Track Modeling** | Latih model baseline fundamental (`B_Macro`) vs model lengkap (`M_Full`) menggunakan TimeSeriesSplit / Purged Walk-Forward. | Model terkompilasi di `models/`, log perbandingan validasi internal. |
| **Fase 6** | **Quant Metric Evaluation** | Hitung Rank IC, Quintile Return Spread, dan Directional Hit Ratio pada out-of-time test set. Uji signifikansi ablation teks. | Laporan komprehensif `reports/phase_quant_evaluation.md`. |

---

## 8. Konfigurasi Sistem (`config.yaml`)

```yaml
project:
  name: xau-news-sentiment
  symbol: XAUUSD
  timezone: UTC
  seed: 42

macro:
  tickers:
    us10y: "^TNX"
    dxy: "DX-Y.NYB"
    oil: "CL=F"
  start_date: "2010-01-01"
  end_date: "2026-11-05"
  output_file: "data/raw/macro/macro_context.csv"
  lag_days: 1
  delta_windows: [1, 5]

data:
  price_file_raw: "/home/kazu/Projects/magang/expert-advisor-trade/data/XAUUSD_H1.csv"
  price_file_complete: "data/raw/price/xauusd_h1_complete.csv"
  calendar_file_raw: "/home/kazu/Projects/magang/expert-advisor-trade/data/news_calendar_high_impact.csv"
  calendar_file_complete: "data/raw/calendar/economic_calendar_enriched.csv"
  macro_file: "data/raw/macro/macro_context.csv"
  news_dir_raw: "data/raw/news"
  processed_dir: "data/processed"

aggregation:
  bucket_hours: 4
  event_window_hours_before: 2
  event_window_hours_after: 2

label:
  timeframe: H1
  continuous_horizons_hours: [4, 24]
  primary_horizon_hours: 4

split:
  train: 0.6
  val: 0.2
  test: 0.2
  embargo_hours: 24
  walk_forward_folds: 5

model:
  candidates: ["B0_Mean", "B_Macro", "M_TextOnly", "M_Full_LightGBM"]
  metrics: ["rank_ic", "quintile_spread", "directional_hit_ratio"]
  tuning_trials: 30
```

---

## 9. Manajemen Risiko & Kepatuhan

1. **Zero Data Snooping**: Semua estimasi volatilitas, scaling, dan imputasi wajib di-*fit* hanya pada set *train* dan diaplikasikan (*transform*) pada set *val/test*.
2. **Point-in-Time Discipline**: Penggunaan `shift(1)` pada data harian makro wajib diuji otomatis dengan unit test sebelum masuk feature store.
3. **Kepatuhan Legalitas & Edukasi**: Hasil model disajikan sebagai koefisien reliabilitas informasi statistik, bukan acuan transaksi finansial langsung.
