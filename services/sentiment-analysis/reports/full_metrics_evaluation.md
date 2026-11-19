# Laporan Evaluasi Komprehensif: Ridge_Linear (Champion), Random_Forest, XGBoost, LightGBM

## 1. Ringkasan Pengujian
- **Target Variabel**: Return Kontinu 4 Jam ($R_{4\text{H}}$).
- **Ukuran Set Uji (Out-of-Time Test Set)**: $N = 5192$ sampel (periode diisolasi dengan 24H Embargo).
- **Jumlah Fitur ($p$)**: 44 fitur (Makro Point-in-Time, Kalender Surprise, Sentimen Teks, & Interaksi Topik).
- **Champion**: `Ridge_Linear` (dipilih by `cv_mean_rank_ic`, bukan hardcode).

---

## 2. Tabel Metrik Evaluasi Lengkap (MAE, MSE, RMSE, MAPE, R2, Adj R2, Hit Ratio)

| Algoritma Model | MAE (%) | MSE ($10^{-4}$) | RMSE (%) | MAPE (%) | $R^2$ Score | Adjusted $R^2$ | Hit Ratio Sig ($|R|>0.5\sigma$) | Hit Ratio All | Rank IC |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| Random_Forest | 0.3265% | 0.2514 | 0.5014% | 98.62% | -0.0006 | -0.0091 | 53.32% | 53.27% | +0.0291 |
| XGBoost | 0.3264% | 0.2513 | 0.5013% | 98.39% | -0.0001 | -0.0087 | 53.48% | 53.39% | +0.0381 |
| LightGBM | 0.3264% | 0.2513 | 0.5013% | 98.36% | -0.0004 | -0.0089 | 53.37% | 53.33% | +0.0389 |
| **Ridge_Linear (Champion)** | 0.3264% | 0.2510 | 0.5010% | 103.38% | +0.0010 | -0.0076 | 52.02% | 51.37% | +0.0396 |

---

## 3. Diagnosa Overfitting (Train vs Test Gap)
| Model | Akurasi Latih (Train Hit) | Akurasi Uji (Test Hit Sig) | Gap Overfit (Train - Test) | Diagnosa |
| :--- | :---: | :---: | :---: | :--- |
| **Random_Forest** | 51.64% | **53.32%** | **-1.68%** | Moderat |
| **XGBoost** | 51.69% | **53.48%** | **-1.79%** | Moderat |
| **LightGBM** | 52.17% | **53.37%** | **-1.20%** | Moderat |
| **Ridge_Linear** | 53.27% | **52.02%** | **1.25%** | Rendah (Generalisasi Kuat) |

---

## 4. Signifikansi Statistik (Jujur)
1. **Akurasi Arah (Hit Ratio)**:
   - Champion `Ridge_Linear` mencapai **`52.02%`** pada pergerakan signifikan ($N_{sig} = 3710$) dan **`51.37%`** pada seluruh data uji.
   - Uji binomial dua-arah terhadap tebakan acak 50%: **p = 0.01442**, CI95 Wilson = [0.5041, 0.5363].
2. **Rank IC**:
   - Champion `Ridge_Linear`: **+0.0396** dengan **p = 0.00428** (Spearman).
3. **Kesimpulan**:
   - TIDAK ada bukti statistik yang signifikan pada α = 0.05. Angka ini **bukan** 'Strong Alpha'; klaim keunggulan atas tebakan acak 50% ditolak.
   - `sentiment_adds_value = false` (basis: `full model rank IC > baseline rank IC, paired bootstrap p < 0.05`; sumber: reports/significance.json).
4. **MAE (0.3264%) & RMSE (0.5010%)**:
   - Deviasi prediksi $\sim 0.33\%$ mencerminkan rentang volatilitas wajar emas per 4 jam.
5. **Mengapa $R^2$ (+0.0010) Bernilai Negatif Mendekati Nol?**:
   - Sesuai literatur *Empirical Asset Pricing* (Gu, Kelly, & Xiu 2020), return harga intraday didominasi oleh *microstructure noise*. Standar evaluasi kuantitatif institusional bertumpu pada **Directional Hit Ratio** dan **Rank IC**, bukan $R^2$.
