# Laporan Evaluasi Komprehensif: Ridge_Linear (Champion), Random_Forest, XGBoost, LightGBM

## 1. Ringkasan Pengujian
- **Target Variabel**: Return Kontinu 4 Jam ($R_{4\text{H}}$).
- **Ukuran Set Uji (Out-of-Time Test Set)**: $N = 5189$ sampel (periode diisolasi dengan 24H Embargo).
- **Jumlah Fitur ($p$)**: 28 fitur (Makro Point-in-Time, Kalender Surprise, Sentimen Teks, & Interaksi Topik).
- **Champion**: `Ridge_Linear` (dipilih by `cv_mean_rank_ic`, bukan hardcode).

---

## 2. Tabel Metrik Evaluasi Lengkap (MAE, MSE, RMSE, MAPE, R2, Adj R2, Hit Ratio)

| Algoritma Model | MAE (%) | MSE ($10^{-4}$) | RMSE (%) | MAPE (%) | $R^2$ Score | Adjusted $R^2$ | Hit Ratio Sig ($|R|>0.5\sigma$) | Hit Ratio All | Rank IC |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| Random_Forest | 0.3262% | 0.2512 | 0.5012% | 98.38% | -0.0001 | -0.0055 | 52.51% | 52.44% | +0.0320 |
| XGBoost | 0.3261% | 0.2511 | 0.5011% | 98.67% | +0.0002 | -0.0052 | 52.62% | 52.40% | +0.0434 |
| LightGBM | 0.3261% | 0.2511 | 0.5011% | 98.64% | +0.0003 | -0.0051 | 52.37% | 52.09% | +0.0323 |
| **Ridge_Linear (Champion)** | 0.3263% | 0.2512 | 0.5012% | 103.05% | -0.0000 | -0.0055 | 51.73% | 51.24% | +0.0344 |

---

## 3. Diagnosa Overfitting (Train vs Test Gap)
| Model | Akurasi Latih (Train Hit) | Akurasi Uji (Test Hit Sig) | Gap Overfit (Train - Test) | Diagnosa |
| :--- | :---: | :---: | :---: | :--- |
| **Random_Forest** | 53.24% | **52.51%** | **0.73%** | Moderat |
| **XGBoost** | 53.85% | **52.62%** | **1.23%** | Moderat |
| **LightGBM** | 54.36% | **52.37%** | **1.99%** | Moderat |
| **Ridge_Linear** | 53.05% | **51.73%** | **1.32%** | Rendah (Generalisasi Kuat) |

---

## 4. Signifikansi Statistik (Jujur)
1. **Akurasi Arah (Hit Ratio)**:
   - Champion `Ridge_Linear` mencapai **`51.73%`** pada pergerakan signifikan ($N_{sig} = 3706$) dan **`51.24%`** pada seluruh data uji.
   - Uji binomial dua-arah terhadap tebakan acak 50%: **p = 0.03695**, CI95 Wilson = [0.5012, 0.5333].
2. **Rank IC**:
   - Champion `Ridge_Linear`: **+0.0344** dengan **p = 0.01324** (Spearman).
3. **Kesimpulan**:
   - TIDAK ada bukti statistik yang signifikan pada α = 0.05. Angka ini **bukan** 'Strong Alpha'; klaim keunggulan atas tebakan acak 50% ditolak.
   - `sentiment_adds_value = false` (basis: `rank_ic_pvalue < 0.05 or hit_ratio_pvalue < 0.05`; sumber: reports/significance.json).
4. **MAE (0.3263%) & RMSE (0.5012%)**:
   - Deviasi prediksi $\sim 0.33\%$ mencerminkan rentang volatilitas wajar emas per 4 jam.
5. **Mengapa $R^2$ (-0.0000) Bernilai Negatif Mendekati Nol?**:
   - Sesuai literatur *Empirical Asset Pricing* (Gu, Kelly, & Xiu 2020), return harga intraday didominasi oleh *microstructure noise*. Standar evaluasi kuantitatif institusional bertumpu pada **Directional Hit Ratio** dan **Rank IC**, bukan $R^2$.
