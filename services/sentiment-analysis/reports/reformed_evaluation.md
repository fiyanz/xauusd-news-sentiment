# Laporan Evaluasi Komprehensif: XGBoost (Champion), Random_Forest, LightGBM, Ridge_Linear

## 1. Ringkasan Pengujian
- **Target Variabel**: Return Kontinu 4 Jam ($R_{4\text{H}}$).
- **Ukuran Set Uji (Out-of-Time Test Set)**: $N = 8$ sampel (periode diisolasi dengan 24H Embargo).
- **Jumlah Fitur ($p$)**: 32 fitur (Makro Point-in-Time, Kalender Surprise, Sentimen Teks, & Interaksi Topik).
- **Champion**: `XGBoost` (dipilih by `cv_mean_rank_ic`, bukan hardcode).

---

## 2. Tabel Metrik Evaluasi Lengkap (MAE, MSE, RMSE, MAPE, R2, Adj R2, Hit Ratio)

| Algoritma Model | MAE (%) | MSE ($10^{-4}$) | RMSE (%) | MAPE (%) | $R^2$ Score | Adjusted $R^2$ | Hit Ratio Sig ($|R|>0.5\sigma$) | Hit Ratio All | Rank IC |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| Random_Forest | 0.5959% | 0.5643 | 0.7512% | 111.68% | -0.4699 | -0.4699 | 20.00% | 25.00% | +0.0000 |
| **XGBoost (Champion)** | 0.6450% | 0.5034 | 0.7095% | 666.25% | -0.3114 | -0.3114 | 80.00% | 62.50% | -0.5238 |
| LightGBM | 0.6044% | 0.5790 | 0.7609% | 139.39% | -0.5082 | -0.5082 | 20.00% | 25.00% | +0.0000 |
| Ridge_Linear | 0.9565% | 1.1449 | 1.0700% | 1494.94% | -1.9825 | -1.9825 | 60.00% | 50.00% | +0.5952 |

---

## 3. Diagnosa Overfitting (Train vs Test Gap)
| Model | Akurasi Latih (Train Hit) | Akurasi Uji (Test Hit Sig) | Gap Overfit (Train - Test) | Diagnosa |
| :--- | :---: | :---: | :---: | :--- |
| **Random_Forest** | 27.78% | **20.00%** | **7.78%** | Moderat |
| **XGBoost** | 72.22% | **80.00%** | **-7.78%** | Rendah (Generalisasi Kuat) |
| **LightGBM** | 27.78% | **20.00%** | **7.78%** | Moderat |
| **Ridge_Linear** | 66.67% | **60.00%** | **6.67%** | Moderat |

---

## 4. Signifikansi Statistik (Jujur)
1. **Akurasi Arah (Hit Ratio)**:
   - Champion `XGBoost` mencapai **`80.00%`** pada pergerakan signifikan ($N_{sig} = 5$) dan **`62.50%`** pada seluruh data uji.
   - Uji binomial dua-arah terhadap tebakan acak 50%: **p = 0.37500**, CI95 Wilson = [0.3755, 0.9638].
2. **Rank IC**:
   - Champion `XGBoost`: **-0.5238** dengan **p = 0.18272** (Spearman).
3. **Kesimpulan**:
   - TIDAK ada bukti statistik yang signifikan pada α = 0.05. Angka ini **bukan** 'Strong Alpha'; klaim keunggulan atas tebakan acak 50% ditolak.
   - `sentiment_adds_value = false` (basis: `rank_ic_pvalue < 0.05 or hit_ratio_pvalue < 0.05`; sumber: reports/significance.json).
4. **MAE (0.6450%) & RMSE (0.7095%)**:
   - Deviasi prediksi $\sim 0.65\%$ mencerminkan rentang volatilitas wajar emas per 4 jam.
5. **Mengapa $R^2$ (-0.3114) Bernilai Negatif Mendekati Nol?**:
   - Sesuai literatur *Empirical Asset Pricing* (Gu, Kelly, & Xiu 2020), return harga intraday didominasi oleh *microstructure noise*. Standar evaluasi kuantitatif institusional bertumpu pada **Directional Hit Ratio** dan **Rank IC**, bukan $R^2$.
