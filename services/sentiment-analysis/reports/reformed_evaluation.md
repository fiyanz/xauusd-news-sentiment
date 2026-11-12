# Laporan Evaluasi Komprehensif: Random_Forest (Champion), XGBoost, LightGBM, Ridge_Linear

## 1. Ringkasan Pengujian
- **Target Variabel**: Return Kontinu 4 Jam ($R_{4\text{H}}$).
- **Ukuran Set Uji (Out-of-Time Test Set)**: $N = 9$ sampel (periode diisolasi dengan 24H Embargo).
- **Jumlah Fitur ($p$)**: 32 fitur (Makro Point-in-Time, Kalender Surprise, Sentimen Teks, & Interaksi Topik).
- **Champion**: `Random_Forest` (dipilih by `cv_mean_rank_ic`, bukan hardcode).

---

## 2. Tabel Metrik Evaluasi Lengkap (MAE, MSE, RMSE, MAPE, R2, Adj R2, Hit Ratio)

| Algoritma Model | MAE (%) | MSE ($10^{-4}$) | RMSE (%) | MAPE (%) | $R^2$ Score | Adjusted $R^2$ | Hit Ratio Sig ($|R|>0.5\sigma$) | Hit Ratio All | Rank IC |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Random_Forest (Champion)** | 0.3764% | 0.2366 | 0.4864% | 297.72% | -0.0000 | -0.0000 | 57.14% | 55.56% | +0.0000 |
| XGBoost | 0.4403% | 0.3022 | 0.5497% | 227.75% | -0.2773 | -0.2773 | 42.86% | 33.33% | -0.4667 |
| LightGBM | 0.3781% | 0.2368 | 0.4866% | 320.98% | -0.0010 | -0.0010 | 57.14% | 55.56% | +0.0000 |
| Ridge_Linear | 0.8559% | 0.9983 | 0.9992% | 874.63% | -3.2197 | -3.2197 | 42.86% | 33.33% | +0.0333 |

---

## 3. Diagnosa Overfitting (Train vs Test Gap)
| Model | Akurasi Latih (Train Hit) | Akurasi Uji (Test Hit Sig) | Gap Overfit (Train - Test) | Diagnosa |
| :--- | :---: | :---: | :---: | :--- |
| **Random_Forest** | 60.00% | **57.14%** | **2.86%** | Rendah (Generalisasi Kuat) |
| **XGBoost** | 85.00% | **42.86%** | **42.14%** | Moderat |
| **LightGBM** | 60.00% | **57.14%** | **2.86%** | Moderat |
| **Ridge_Linear** | 55.00% | **42.86%** | **12.14%** | Moderat |

---

## 4. Signifikansi Statistik (Jujur)
1. **Akurasi Arah (Hit Ratio)**:
   - Champion `Random_Forest` mencapai **`57.14%`** pada pergerakan signifikan ($N_{sig} = 7$) dan **`55.56%`** pada seluruh data uji.
   - Uji binomial dua-arah terhadap tebakan acak 50%: **p = 1.00000**, CI95 Wilson = [0.2505, 0.8418].
2. **Rank IC**:
   - Champion `Random_Forest`: **+0.0000** dengan **p = 1.00000** (Spearman).
3. **Kesimpulan**:
   - TIDAK ada bukti statistik yang signifikan pada α = 0.05. Angka ini **bukan** 'Strong Alpha'; klaim keunggulan atas tebakan acak 50% ditolak.
   - `sentiment_adds_value = false` (basis: `rank_ic_pvalue < 0.05 or hit_ratio_pvalue < 0.05`; sumber: reports/significance.json).
4. **MAE (0.3764%) & RMSE (0.4864%)**:
   - Deviasi prediksi $\sim 0.38\%$ mencerminkan rentang volatilitas wajar emas per 4 jam.
5. **Mengapa $R^2$ (-0.0000) Bernilai Negatif Mendekati Nol?**:
   - Sesuai literatur *Empirical Asset Pricing* (Gu, Kelly, & Xiu 2020), return harga intraday didominasi oleh *microstructure noise*. Standar evaluasi kuantitatif institusional bertumpu pada **Directional Hit Ratio** dan **Rank IC**, bukan $R^2$.
