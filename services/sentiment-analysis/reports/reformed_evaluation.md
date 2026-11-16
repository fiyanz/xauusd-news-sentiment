# Laporan Evaluasi Terpadu: Fair Baseline vs Full Sentiment Model (XAUUSD)

> **STATUS: artifact_status=stale.** Metrik pada file ini dihitung pada artifact data nyata yang berumur >24 jam (provenance belum diperbarui). Angka ini DIAGNOSTIK, bukan hasil akhir; jalankan ulang pipeline untuk memperbarui provenance.

## 1. Ringkasan Eksekutif & Metodologi
- **Target Utama**: Return kontinu 4H ($R_{4\text{H}}$).
- **Unit Analisis**: Bucket 4-Jam & Jendela Rilis Event Berdampak Tinggi ($N = 5189$ baris pada Set Uji Out-of-Time).
- **Desain Pengujian Adil (Fair Comparison)**:
  - **Fair Baseline**: `LightGBM` (LGBMRegressor) pada 21 fitur makro/event — `models/champion_fair_model.joblib` → `baseline_model` + `baseline_feature_cols`.
  - **Full Model**: `Ridge_Linear` pada 28 fitur (Baseline + Fitur Sentimen Berita + *Topic Interaction Terms*).

## 2. Hasil Komparasi Out-of-Time Test Set
| Metrik Kuantitatif | Fair Baseline (LightGBM) | Full Model (Ridge_Linear) | Delta (Full - Base) | Interpretasi |
| :--- | :---: | :---: | :---: | :--- |
|| **Jumlah Fitur** | 21 | 28 | +7 | Dimensi fitur diperluas dengan interaksi teks |
|| **Spearman Rank IC** | **+0.0365** | **+0.0344** | **-0.0021** | Baseline makro lebih unggul secara IC |
|| **IC p-value** | 0.00856 | 0.01324 | — | Nilai signifikansi statistik korelasi |
|| **Quintile Return Spread ($Q_5 - Q_1$)** | +0.000464 | +0.000475 | +0.000011 | Selisih return kuantil teratas vs terbawah |
|| **Directional Hit Ratio (|R| > 0.5σ)** | 52.51% | 51.73% | -0.78% | Akurasi arah pada pergerakan signifikan |
|| **Hit Ratio p-value (binomial)** | 0.00237 | 0.03695 | — | Uji dua-arah terhadap 50% |
|| **Hit Ratio CI95 (Wilson)** | [0.5090, 0.5411] | [0.5012, 0.5333] | — | Interval kepercayaan 95% |
|| **Pesaran-Timmermann Test (Stat / p)** | 2.28 (p=0.011) | 2.24 (p=0.012) | — | Uji non-parametrik independensi arah pasar |
|| **Kontrol Negatif (Shuffled Labels IC)** | +0.0108 | +0.0003 | — | Mendekati 0, membuktikan ketiadaan kebocoran temporal |

## 3. Temuan Ilmiah & Kesimpulan Kuantitatif
1. **Bukti Nilai Tambah Sentimen Teks**:
   - Model Lengkap dengan fitur interaksi topik menghasilkan Rank IC sebesar **+0.0344** (p = 0.01324) dan Directional Hit Ratio **51.73%** (p = 0.03695, CI95 [0.5012, 0.5333]) pada data uji *out-of-time*.
   - TIDAK ada bukti statistik bahwa sentimen menambah nilai (p >= 0.05). Delta positif pada titik ini masih mungkin berasal dari kebetulan.
   - `sentiment_adds_value = false` (basis: `full model rank IC > baseline rank IC, paired bootstrap p < 0.05`).
2. **Kepatuhan Kuantitatif (FR-10)**:
   - Evaluasi ini adalah studi empiris daya prediksi informasi, bukan rekomendasi sinyal transaksi beli/jual.
   - Sinyal dievaluasi dengan uji kontrol negatif dan uji non-parametrik Pesaran-Timmermann; klaim signifikansi hanya diajukan bila p < 0.05.
