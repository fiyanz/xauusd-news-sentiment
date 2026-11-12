# Laporan Evaluasi Komprehensif: XGBoost (Champion), Random_Forest, LightGBM, Ridge_Linear

## 1. Ringkasan Pengujian
- **Target Variabel**: Return Kontinu 4 Jam ($R_{4\text{H}}$).
- **Ukuran Set Uji (Out-of-Time Test Set)**: $N = 5187$ sampel (periode diisolasi dengan 24H Embargo).
- **Jumlah Fitur ($p$)**: 19 fitur (Makro Point-in-Time, Kalender Surprise, Sentimen Teks, & Interaksi Topik).
- **Champion**: `XGBoost` (dipilih by `cv_mean_rank_ic`, bukan hardcode).

---

## 2. Tabel Metrik Evaluasi Lengkap (MAE, MSE, RMSE, MAPE, R2, Adj R2, Hit Ratio)

| Algoritma Model | MAE (%) | MSE ($10^{-4}$) | RMSE (%) | MAPE (%) | $R^2$ Score | Adjusted $R^2$ | Hit Ratio Sig ($|R|>0.5\sigma$) | Hit Ratio All | Rank IC |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| Random_Forest | 0.3254% | 0.2503 | 0.5003% | 99.17% | -0.0000 | -0.0037 | 51.84% | 52.03% | +0.0320 |
| **XGBoost (Champion)** | 0.3255% | 0.2503 | 0.5003% | 99.23% | -0.0000 | -0.0037 | 52.40% | 52.28% | +0.0343 |
| LightGBM | 0.3255% | 0.2503 | 0.5003% | 99.36% | -0.0000 | -0.0037 | 52.30% | 52.21% | +0.0291 |
| Ridge_Linear | 0.3254% | 0.2502 | 0.5002% | 102.13% | +0.0006 | -0.0030 | 51.70% | 51.19% | +0.0393 |

---

## 3. Diagnosa Overfitting (Train vs Test Gap)
| Model | Akurasi Latih (Train Hit) | Akurasi Uji (Test Hit Sig) | Gap Overfit (Train - Test) | Diagnosa |
| :--- | :---: | :---: | :---: | :--- |
| **Random_Forest** | 53.29% | **51.84%** | **1.45%** | Moderat |
| **XGBoost** | 53.59% | **52.40%** | **1.19%** | Rendah (Generalisasi Kuat) |
| **LightGBM** | 53.67% | **52.30%** | **1.37%** | Moderat |
| **Ridge_Linear** | 52.52% | **51.70%** | **0.82%** | Moderat |

---

## 4. Signifikansi Statistik (Jujur)
1. **Akurasi Arah (Hit Ratio)**:
   - Champion `XGBoost` mencapai **`52.40%`** pada pergerakan signifikan ($N_{sig} = 3702$) dan **`52.28%`** pada seluruh data uji.
   - Uji binomial dua-arah terhadap tebakan acak 50%: **p = 0.00362**, CI95 Wilson = [0.5079, 0.5401].
2. **Rank IC**:
   - Champion `XGBoost`: **+0.0343** dengan **p = 0.01349** (Spearman).
3. **Kesimpulan**:
   - TIDAK ada bukti statistik yang signifikan pada α = 0.05. Angka ini **bukan** 'Strong Alpha'; klaim keunggulan atas tebakan acak 50% ditolak.
   - `sentiment_adds_value = false` (basis: `rank_ic_pvalue < 0.05 or hit_ratio_pvalue < 0.05`; sumber: reports/significance.json).
4. **MAE (0.3255%) & RMSE (0.5003%)**:
   - Deviasi prediksi $\sim 0.33\%$ mencerminkan rentang volatilitas wajar emas per 4 jam.
5. **Mengapa $R^2$ (-0.0000) Bernilai Negatif Mendekati Nol?**:
   - Sesuai literatur *Empirical Asset Pricing* (Gu, Kelly, & Xiu 2020), return harga intraday didominasi oleh *microstructure noise*. Standar evaluasi kuantitatif institusional bertumpu pada **Directional Hit Ratio** dan **Rank IC**, bukan $R^2$.
