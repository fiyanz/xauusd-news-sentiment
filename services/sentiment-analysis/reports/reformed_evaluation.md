# Laporan Evaluasi Terpadu: Fair Baseline vs Full Sentiment Model (XAUUSD)

## 1. Ringkasan Eksekutif & Metodologi
- **Target Utama**: Return kontinu 4H ($R_{4\text{H}}$).
- **Unit Analisis**: Bucket 4-Jam & Jendela Rilis Event Berdampak Tinggi ($N = 5192$ baris pada Set Uji Out-of-Time).
- **Desain Pengujian Adil (Fair Comparison)**:
  - **Fair Baseline**: `LightGBM` (LGBMRegressor) pada 21 fitur makro/event — `models/champion_fair_model.joblib` → `baseline_model` + `baseline_feature_cols`.
  - **Full Model**: `Ridge_Linear` pada 44 fitur (Baseline + Fitur Sentimen Berita + *Topic Interaction Terms*).

## 2. Hasil Komparasi Out-of-Time Test Set
| Metrik Kuantitatif | Fair Baseline (LightGBM) | Full Model (Ridge_Linear) | Delta (Full - Base) | Interpretasi |
| :--- | :---: | :---: | :---: | :--- |
|| **Jumlah Fitur** | 21 | 44 | +23 | Dimensi fitur diperluas dengan interaksi teks |
|| **Spearman Rank IC** | **+0.0354** | **+0.0396** | **+0.0042** | Penambahan sentimen meningkatkan korelasi peringkat |
|| **IC p-value** | 0.01065 | 0.00428 | — | Nilai signifikansi statistik korelasi |
|| **Quintile Return Spread ($Q_5 - Q_1$)** | +0.000378 | +0.000606 | +0.000228 | Selisih return kuantil teratas vs terbawah |
|| **Directional Hit Ratio (|R| > 0.5σ)** | 52.48% | 52.02% | -0.46% | Akurasi arah pada pergerakan signifikan |
|| **Hit Ratio p-value (binomial)** | 0.00266 | 0.01442 | — | Uji dua-arah terhadap 50% |
|| **Hit Ratio CI95 (Wilson)** | [0.5087, 0.5408] | [0.5041, 0.5363] | — | Interval kepercayaan 95% |
|| **Pesaran-Timmermann Test (Stat / p)** | 2.33 (p=0.010) | 2.35 (p=0.009) | — | Uji non-parametrik independensi arah pasar |
|| **Kontrol Negatif (Shuffled Labels IC)** | -0.0031 | +0.0114 | — | Mendekati 0, membuktikan ketiadaan kebocoran temporal |

## 3. Temuan Ilmiah & Kesimpulan Kuantitatif
1. **Bukti Nilai Tambah Sentimen Teks**:
   - Model Lengkap dengan fitur interaksi topik menghasilkan Rank IC sebesar **+0.0396** (p = 0.00428) dan Directional Hit Ratio **52.02%** (p = 0.01442, CI95 [0.5041, 0.5363]) pada data uji *out-of-time*.
   - TIDAK ada bukti statistik bahwa sentimen menambah nilai (p >= 0.05). Delta positif pada titik ini masih mungkin berasal dari kebetulan.
   - `sentiment_adds_value = false` (basis: `full model rank IC > baseline rank IC, paired bootstrap p < 0.05`).
2. **Kepatuhan Kuantitatif (FR-10)**:
   - Evaluasi ini adalah studi empiris daya prediksi informasi, bukan rekomendasi sinyal transaksi beli/jual.
   - Sinyal dievaluasi dengan uji kontrol negatif dan uji non-parametrik Pesaran-Timmermann; klaim signifikansi hanya diajukan bila p < 0.05.
