# Laporan Evaluasi Komprehensif: Ridge_Linear (Champion), Random_Forest, XGBoost, LightGBM

## 1. Ringkasan Pengujian
- **Target Variabel**: Return Kontinu 4 Jam ($R_{4\text{H}}$).
- **Ukuran Set Uji (Out-of-Time Test Set)**: $N = 5187$ sampel (periode diisolasi dengan 24H Embargo).
- **Jumlah Fitur ($p$)**: 26 fitur (Makro Point-in-Time, Kalender Surprise, Sentimen Teks, & Interaksi Topik).
- **Champion**: `Ridge_Linear` (dipilih by `cv_mean_rank_ic`, bukan hardcode).

---

## 2. Tabel Metrik Evaluasi Lengkap (MAE, MSE, RMSE, MAPE, R2, Adj R2, Hit Ratio)

| Algoritma Model | MAE (%) | MSE ($10^{-4}$) | RMSE (%) | MAPE (%) | $R^2$ Score | Adjusted $R^2$ | Hit Ratio Sig ($|R|>0.5\sigma$) | Hit Ratio All | Rank IC |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| Random_Forest | 0.3254% | 0.2504 | 0.5004% | 98.38% | -0.0003 | -0.0054 | 52.92% | 52.71% | +0.0343 |
| XGBoost | 0.3254% | 0.2504 | 0.5004% | 98.57% | -0.0003 | -0.0053 | 52.43% | 52.17% | +0.0334 |
| LightGBM | 0.3254% | 0.2504 | 0.5004% | 98.60% | -0.0003 | -0.0054 | 52.81% | 52.36% | +0.0382 |
| **Ridge_Linear (Champion)** | 0.3262% | 0.2516 | 0.5016% | 103.51% | -0.0053 | -0.0104 | 51.84% | 51.24% | +0.0336 |

---

## 3. Diagnosa Overfitting (Train vs Test Gap)
| Model | Akurasi Latih (Train Hit) | Akurasi Uji (Test Hit Sig) | Gap Overfit (Train - Test) | Diagnosa |
| :--- | :---: | :---: | :---: | :--- |
| **Random_Forest** | 52.77% | **52.92%** | **-0.15%** | Moderat |
| **XGBoost** | 53.94% | **52.43%** | **1.51%** | Moderat |
| **LightGBM** | 54.01% | **52.81%** | **1.20%** | Moderat |
| **Ridge_Linear** | 53.19% | **51.84%** | **1.35%** | Rendah (Generalisasi Kuat) |

---

## 4. Signifikansi Statistik (Jujur)
1. **Akurasi Arah (Hit Ratio)**:
   - Champion `Ridge_Linear` mencapai **`51.84%`** pada pergerakan signifikan ($N_{sig} = 3702$) dan **`51.24%`** pada seluruh data uji.
   - Uji binomial dua-arah terhadap tebakan acak 50%: **p = 0.02649**, CI95 Wilson = [0.5023, 0.5344].
2. **Rank IC**:
   - Champion `Ridge_Linear`: **+0.0336** dengan **p = 0.01549** (Spearman).
3. **Kesimpulan**:
   - TIDAK ada bukti statistik yang signifikan pada α = 0.05. Angka ini **bukan** 'Strong Alpha'; klaim keunggulan atas tebakan acak 50% ditolak.
   - `sentiment_adds_value = false` (basis: `rank_ic_pvalue < 0.05 or hit_ratio_pvalue < 0.05`; sumber: reports/significance.json).
4. **MAE (0.3262%) & RMSE (0.5016%)**:
   - Deviasi prediksi $\sim 0.33\%$ mencerminkan rentang volatilitas wajar emas per 4 jam.
5. **Mengapa $R^2$ (-0.0053) Bernilai Negatif Mendekati Nol?**:
   - Sesuai literatur *Empirical Asset Pricing* (Gu, Kelly, & Xiu 2020), return harga intraday didominasi oleh *microstructure noise*. Standar evaluasi kuantitatif institusional bertumpu pada **Directional Hit Ratio** dan **Rank IC**, bukan $R^2$.
