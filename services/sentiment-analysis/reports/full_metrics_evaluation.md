# Laporan Evaluasi Komprehensif: Ridge_Linear (Champion), Random_Forest, XGBoost, LightGBM

> **STATUS: artifact_status=inconsistent.** Artifact sedang diregenerasi (parquet lebih baru dari provenance). Angka ini DIAGNOSTIK, bukan hasil akhir.

## 1. Ringkasan Pengujian
- **Target Variabel**: Return Kontinu 4 Jam ($R_{4\text{H}}$).
- **Ukuran Set Uji (Out-of-Time Test Set)**: $N = 5189$ sampel (periode diisolasi dengan 24H Embargo).
- **Jumlah Fitur ($p$)**: 44 fitur (Makro Point-in-Time, Kalender Surprise, Sentimen Teks, & Interaksi Topik).
- **Champion**: `Ridge_Linear` (dipilih by `cv_mean_rank_ic`, bukan hardcode).

---

## 2. Tabel Metrik Evaluasi Lengkap (MAE, MSE, RMSE, MAPE, R2, Adj R2, Hit Ratio)

| Algoritma Model | MAE (%) | MSE ($10^{-4}$) | RMSE (%) | MAPE (%) | $R^2$ Score | Adjusted $R^2$ | Hit Ratio Sig ($|R|>0.5\sigma$) | Hit Ratio All | Rank IC |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| Random_Forest | 0.3265% | 0.2514 | 0.5014% | 98.48% | -0.0006 | -0.0092 | 53.24% | 53.21% | +0.0396 |
| XGBoost | 0.3263% | 0.2514 | 0.5014% | 98.30% | -0.0004 | -0.0090 | 53.56% | 53.44% | +0.0386 |
| LightGBM | 0.3264% | 0.2513 | 0.5013% | 98.37% | -0.0001 | -0.0087 | 53.40% | 53.31% | +0.0316 |
| **Ridge_Linear (Champion)** | 0.3264% | 0.2511 | 0.5011% | 103.36% | +0.0008 | -0.0077 | 51.83% | 51.26% | +0.0385 |

---

## 3. Diagnosa Overfitting (Train vs Test Gap)
| Model | Akurasi Latih (Train Hit) | Akurasi Uji (Test Hit Sig) | Gap Overfit (Train - Test) | Diagnosa |
| :--- | :---: | :---: | :---: | :--- |
| **Random_Forest** | 51.51% | **53.24%** | **-1.73%** | Moderat |
| **XGBoost** | 51.56% | **53.56%** | **-2.00%** | Moderat |
| **LightGBM** | 51.99% | **53.40%** | **-1.41%** | Moderat |
| **Ridge_Linear** | 53.33% | **51.83%** | **1.50%** | Rendah (Generalisasi Kuat) |

---

## 4. Signifikansi Statistik (Jujur)
1. **Akurasi Arah (Hit Ratio)**:
   - Champion `Ridge_Linear` mencapai **`51.83%`** pada pergerakan signifikan ($N_{sig} = 3706$) dan **`51.26%`** pada seluruh data uji.
   - Uji binomial dua-arah terhadap tebakan acak 50%: **p = 0.02657**, CI95 Wilson = [0.5023, 0.5344].
2. **Rank IC**:
   - Champion `Ridge_Linear`: **+0.0385** dengan **p = 0.00552** (Spearman).
3. **Kesimpulan**:
   - TIDAK ada bukti statistik yang signifikan pada α = 0.05. Angka ini **bukan** 'Strong Alpha'; klaim keunggulan atas tebakan acak 50% ditolak.
   - `sentiment_adds_value = false` (basis: `full model rank IC > baseline rank IC, paired bootstrap p < 0.05`; sumber: reports/significance.json).
4. **MAE (0.3264%) & RMSE (0.5011%)**:
   - Deviasi prediksi $\sim 0.33\%$ mencerminkan rentang volatilitas wajar emas per 4 jam.
5. **Mengapa $R^2$ (+0.0008) Bernilai Negatif Mendekati Nol?**:
   - Sesuai literatur *Empirical Asset Pricing* (Gu, Kelly, & Xiu 2020), return harga intraday didominasi oleh *microstructure noise*. Standar evaluasi kuantitatif institusional bertumpu pada **Directional Hit Ratio** dan **Rank IC**, bukan $R^2$.
