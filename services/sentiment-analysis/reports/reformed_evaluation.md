# Laporan Evaluasi Terpadu: Fair Baseline vs Full Sentiment Model (XAUUSD)

## 1. Ringkasan Eksekutif & Metodologi
- **Target Utama**: Return kontinu 4H ($R_{4\text{H}}$).
- **Unit Analisis**: Bucket 4-Jam & Jendela Rilis Event Berdampak Tinggi ($N = 5187$ baris pada Set Uji Out-of-Time).
- **Desain Pengujian Adil (Fair Comparison)**:
  - **Fair Baseline**: Model hanya menggunakan angka rilis kalender ekonomi (*standardized surprise* $Z$-Score) dan fitur kalender waktu.
  - **Full Model**: Baseline + Fitur Sentimen Berita + *Topic Interaction Terms* (`sentiment × topic`).

## 2. Hasil Komparasi Out-of-Time Test Set
| Metrik Kuantitatif | Fair Baseline (Random_Forest) | Full Model (Ridge_Linear) | Delta (Full - Base) | Interpretasi |
| :--- | :---: | :---: | :---: | :--- |
| **Jumlah Fitur** | 19 | 26 | +7 | Dimensi fitur diperluas dengan interaksi teks |
| **Spearman Rank IC** | **+0.0383** | **+0.0336** | **-0.0047** | Baseline makro lebih unggul secara IC |
| **IC p-value** | 0.00586 | 0.01549 | — | Nilai signifikansi statistik korelasi |
| **Quintile Return Spread ($Q_5 - Q_1$)** | +0.000533 | +0.000495 | -0.000038 | Selisih return kuantil teratas vs terbawah |
| **Directional Hit Ratio (|R| > 0.5σ)** | 52.32% | 51.84% | -0.48% | Akurasi arah pada pergerakan signifikan |
| **Hit Ratio p-value (binomial)** | 0.00494 | 0.02649 | — | Uji dua-arah terhadap 50% |
| **Hit Ratio CI95 (Wilson)** | [0.5071, 0.5393] | [0.5023, 0.5344] | — | Interval kepercayaan 95% |
| **Pesaran-Timmermann Test (Stat / p)** | 2.12 (p=0.017) | 2.23 (p=0.013) | — | Uji non-parametrik independensi arah pasar |
| **Kontrol Negatif (Shuffled Labels IC)** | +0.0070 | -0.0014 | — | Mendekati 0, membuktikan ketiadaan kebocoran temporal |

## 3. Temuan Ilmiah & Kesimpulan Kuantitatif
1. **Bukti Nilai Tambah Sentimen Teks**:
   - Model Lengkap dengan fitur interaksi topik menghasilkan Rank IC sebesar **+0.0336** (p = 0.01549) dan Directional Hit Ratio **51.84%** (p = 0.02649, CI95 [0.5023, 0.5344]) pada data uji *out-of-time*.
   - TIDAK ada bukti statistik bahwa sentimen menambah nilai (p >= 0.05). Delta positif pada titik ini masih mungkin berasal dari kebetulan.
   - `sentiment_adds_value = false` (basis: `rank_ic_pvalue < 0.05 or hit_ratio_pvalue < 0.05`).
2. **Kepatuhan Kuantitatif (FR-10)**:
   - Evaluasi ini adalah studi empiris daya prediksi informasi, bukan rekomendasi sinyal transaksi beli/jual.
   - Sinyal dievaluasi dengan uji kontrol negatif dan uji non-parametrik Pesaran-Timmermann; klaim signifikansi hanya diajukan bila p < 0.05.
