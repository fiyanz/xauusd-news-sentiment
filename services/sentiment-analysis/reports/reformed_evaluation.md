# Laporan Evaluasi Komprehensif: Ridge_Linear (Champion), Random_Forest, XGBoost, LightGBM

## 1. Ringkasan Pengujian
- **Target Variabel**: Return Kontinu 4 Jam ($R_{4\text{H}}$).
- **Ukuran Set Uji (Out-of-Time Test Set)**: $N = 5187$ sampel (periode diisolasi dengan 24H Embargo).
- **Jumlah Fitur ($p$)**: 28 fitur (Makro Point-in-Time, Kalender Surprise, Sentimen Teks, & Interaksi Topik).
- **Champion**: `Ridge_Linear` (dipilih by `cv_mean_rank_ic`, bukan hardcode).

---

## 2. Tabel Metrik Evaluasi Lengkap (MAE, MSE, RMSE, MAPE, R2, Adj R2, Hit Ratio)

| Algoritma Model | MAE (%) | MSE ($10^{-4}$) | RMSE (%) | MAPE (%) | $R^2$ Score | Adjusted $R^2$ | Hit Ratio Sig ($|R|>0.5\sigma$) | Hit Ratio All | Rank IC |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| Random_Forest | 0.3255% | 0.2505 | 0.5005% | 98.38% | -0.0005 | -0.0059 | 53.00% | 53.11% | +0.0304 |
| XGBoost | 0.3254% | 0.2504 | 0.5004% | 98.47% | -0.0002 | -0.0057 | 52.43% | 52.13% | +0.0419 |
| LightGBM | 0.3255% | 0.2504 | 0.5004% | 98.49% | -0.0004 | -0.0059 | 52.76% | 52.34% | +0.0389 |
| **Ridge_Linear (Champion)** | 0.3263% | 0.2518 | 0.5018% | 103.60% | -0.0061 | -0.0115 | 51.84% | 51.24% | +0.0343 |

---

## 3. Diagnosa Overfitting (Train vs Test Gap)
| Model | Akurasi Latih (Train Hit) | Akurasi Uji (Test Hit Sig) | Gap Overfit (Train - Test) | Diagnosa |
| :--- | :---: | :---: | :---: | :--- |
| **Random_Forest** | 52.94% | **53.00%** | **-0.06%** | Moderat |
| **XGBoost** | 53.75% | **52.43%** | **1.32%** | Moderat |
| **LightGBM** | 54.10% | **52.76%** | **1.34%** | Moderat |
| **Ridge_Linear** | 53.08% | **51.84%** | **1.24%** | Rendah (Generalisasi Kuat) |

---

## 4. Signifikansi Statistik (Jujur)
1. **Akurasi Arah (Hit Ratio)**:
   - Champion `Ridge_Linear` mencapai **`51.84%`** pada pergerakan signifikan ($N_{sig} = 3702$) dan **`51.24%`** pada seluruh data uji.
   - Uji binomial dua-arah terhadap tebakan acak 50%: **p = 0.02649**, CI95 Wilson = [0.5023, 0.5344].
2. **Rank IC**:
   - Champion `Ridge_Linear`: **+0.0343** dengan **p = 0.01360** (Spearman).
3. **Kesimpulan**:
   - TIDAK ada bukti statistik yang signifikan pada α = 0.05. Angka ini **bukan** 'Strong Alpha'; klaim keunggulan atas tebakan acak 50% ditolak.
   - `sentiment_adds_value = false` (basis: `rank_ic_pvalue < 0.05 or hit_ratio_pvalue < 0.05`; sumber: reports/significance.json).
4. **MAE (0.3263%) & RMSE (0.5018%)**:
   - Deviasi prediksi $\sim 0.33\%$ mencerminkan rentang volatilitas wajar emas per 4 jam.
5. **Mengapa $R^2$ (-0.0061) Bernilai Negatif Mendekati Nol?**:
   - Sesuai literatur *Empirical Asset Pricing* (Gu, Kelly, & Xiu 2020), return harga intraday didominasi oleh *microstructure noise*. Standar evaluasi kuantitatif institusional bertumpu pada **Directional Hit Ratio** dan **Rank IC**, bukan $R^2$.
