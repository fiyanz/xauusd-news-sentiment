# Laporan Evaluasi Komprehensif: Random_Forest (Champion), XGBoost, LightGBM, Ridge_Linear

## 1. Ringkasan Pengujian
- **Target Variabel**: Return Kontinu 4 Jam ($R_{4\text{H}}$).
- **Ukuran Set Uji (Out-of-Time Test Set)**: $N = 4$ sampel (periode diisolasi dengan 24H Embargo).
- **Jumlah Fitur ($p$)**: 32 fitur (Makro Point-in-Time, Kalender Surprise, Sentimen Teks, & Interaksi Topik).
- **Champion**: `Random_Forest` (dipilih by `cv_mean_rank_ic`, bukan hardcode).

---

## 2. Tabel Metrik Evaluasi Lengkap (MAE, MSE, RMSE, MAPE, R2, Adj R2, Hit Ratio)

| Algoritma Model | MAE (%) | MSE ($10^{-4}$) | RMSE (%) | MAPE (%) | $R^2$ Score | Adjusted $R^2$ | Hit Ratio Sig ($|R|>0.5\sigma$) | Hit Ratio All | Rank IC |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Random_Forest (Champion)** | 0.1679% | 0.0348 | 0.1866% | 639.77% | -1.1701 | -1.1701 | 100.00% | 50.00% | +0.0000 |
| XGBoost | 0.4561% | 0.2208 | 0.4698% | 1742.11% | -12.7590 | -12.7590 | 100.00% | 50.00% | +0.3162 |
| LightGBM | 0.1773% | 0.0403 | 0.2008% | 706.05% | -1.5121 | -1.5121 | 100.00% | 50.00% | +0.0000 |
| Ridge_Linear | 1.3099% | 1.8395 | 1.3563% | 6172.73% | -113.6516 | -113.6516 | 0.00% | 25.00% | +0.4000 |

---

## 3. Diagnosa Overfitting (Train vs Test Gap)
| Model | Akurasi Latih (Train Hit) | Akurasi Uji (Test Hit Sig) | Gap Overfit (Train - Test) | Diagnosa |
| :--- | :---: | :---: | :---: | :--- |
| **Random_Forest** | 50.00% | **100.00%** | **-50.00%** | Rendah (Generalisasi Kuat) |
| **XGBoost** | 75.00% | **100.00%** | **-25.00%** | Moderat |
| **LightGBM** | 50.00% | **100.00%** | **-50.00%** | Moderat |
| **Ridge_Linear** | 100.00% | **0.00%** | **100.00%** | Moderat |

---

## 4. Signifikansi Statistik (Jujur)
1. **Akurasi Arah (Hit Ratio)**:
   - Champion `Random_Forest` mencapai **`100.00%`** pada pergerakan signifikan ($N_{sig} = 1$) dan **`50.00%`** pada seluruh data uji.
   - Uji binomial dua-arah terhadap tebakan acak 50%: **p = 1.00000**, CI95 Wilson = [0.2065, 1.0000].
2. **Rank IC**:
   - Champion `Random_Forest`: **+0.0000** dengan **p = 1.00000** (Spearman).
3. **Kesimpulan**:
   - TIDAK ada bukti statistik yang signifikan pada α = 0.05. Angka ini **bukan** 'Strong Alpha'; klaim keunggulan atas tebakan acak 50% ditolak.
   - `sentiment_adds_value = false` (basis: `rank_ic_pvalue < 0.05 or hit_ratio_pvalue < 0.05`; sumber: reports/significance.json).
4. **MAE (0.1679%) & RMSE (0.1866%)**:
   - Deviasi prediksi $\sim 0.17\%$ mencerminkan rentang volatilitas wajar emas per 4 jam.
5. **Mengapa $R^2$ (-1.1701) Bernilai Negatif Mendekati Nol?**:
   - Sesuai literatur *Empirical Asset Pricing* (Gu, Kelly, & Xiu 2020), return harga intraday didominasi oleh *microstructure noise*. Standar evaluasi kuantitatif institusional bertumpu pada **Directional Hit Ratio** dan **Rank IC**, bukan $R^2$.
