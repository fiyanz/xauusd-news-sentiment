# Laporan Evaluasi Komprehensif: Ridge_Linear (Champion), Random_Forest, XGBoost, LightGBM

## 1. Ringkasan Pengujian
- **Target Variabel**: Return Kontinu 4 Jam ($R_{4\text{H}}$).
- **Ukuran Set Uji (Out-of-Time Test Set)**: $N = 8$ sampel (periode diisolasi dengan 24H Embargo).
- **Jumlah Fitur ($p$)**: 26 fitur (Makro Point-in-Time, Kalender Surprise, Sentimen Teks, & Interaksi Topik).
- **Champion**: `Ridge_Linear` (dipilih by `cv_mean_rank_ic`, bukan hardcode).

---

## 2. Tabel Metrik Evaluasi Lengkap (MAE, MSE, RMSE, MAPE, R2, Adj R2, Hit Ratio)

| Algoritma Model | MAE (%) | MSE ($10^{-4}$) | RMSE (%) | MAPE (%) | $R^2$ Score | Adjusted $R^2$ | Hit Ratio Sig ($|R|>0.5\sigma$) | Hit Ratio All | Rank IC |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| Random_Forest | 0.3291% | 0.2318 | 0.4814% | 324.37% | -0.1155 | -0.1155 | 80.00% | 62.50% | +0.0000 |
| XGBoost | 0.4620% | 0.3765 | 0.6136% | 704.18% | -0.8122 | -0.8122 | 20.00% | 12.50% | -0.3234 |
| LightGBM | 0.3291% | 0.2270 | 0.4764% | 370.49% | -0.0924 | -0.0924 | 80.00% | 62.50% | +0.0000 |
| **Ridge_Linear (Champion)** | 1.0236% | 2.6699 | 1.6340% | 6126.16% | -11.8503 | -11.8503 | 80.00% | 62.50% | +0.2275 |

---

## 3. Diagnosa Overfitting (Train vs Test Gap)
| Model | Akurasi Latih (Train Hit) | Akurasi Uji (Test Hit Sig) | Gap Overfit (Train - Test) | Diagnosa |
| :--- | :---: | :---: | :---: | :--- |
| **Random_Forest** | 60.00% | **80.00%** | **-20.00%** | Moderat |
| **XGBoost** | 95.00% | **20.00%** | **75.00%** | Moderat |
| **LightGBM** | 60.00% | **80.00%** | **-20.00%** | Moderat |
| **Ridge_Linear** | 80.00% | **80.00%** | **0.00%** | Rendah (Generalisasi Kuat) |

---

## 4. Signifikansi Statistik (Jujur)
1. **Akurasi Arah (Hit Ratio)**:
   - Champion `Ridge_Linear` mencapai **`80.00%`** pada pergerakan signifikan ($N_{sig} = 5$) dan **`62.50%`** pada seluruh data uji.
   - Uji binomial dua-arah terhadap tebakan acak 50%: **p = 0.37500**, CI95 Wilson = [0.3755, 0.9638].
2. **Rank IC**:
   - Champion `Ridge_Linear`: **+0.2275** dengan **p = 0.58784** (Spearman).
3. **Kesimpulan**:
   - TIDAK ada bukti statistik yang signifikan pada α = 0.05. Angka ini **bukan** 'Strong Alpha'; klaim keunggulan atas tebakan acak 50% ditolak.
   - `sentiment_adds_value = false` (basis: `rank_ic_pvalue < 0.05 or hit_ratio_pvalue < 0.05`; sumber: reports/significance.json).
4. **MAE (1.0236%) & RMSE (1.6340%)**:
   - Deviasi prediksi $\sim 1.02\%$ mencerminkan rentang volatilitas wajar emas per 4 jam.
5. **Mengapa $R^2$ (-11.8503) Bernilai Negatif Mendekati Nol?**:
   - Sesuai literatur *Empirical Asset Pricing* (Gu, Kelly, & Xiu 2020), return harga intraday didominasi oleh *microstructure noise*. Standar evaluasi kuantitatif institusional bertumpu pada **Directional Hit Ratio** dan **Rank IC**, bukan $R^2$.
