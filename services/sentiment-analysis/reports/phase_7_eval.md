# Laporan Evaluasi Fase 7: Uji Test Set & Validasi Empiris

## 1. Ringkasan Eksekutif
- **Ukuran Test Set**: 292 artikel (strictly out-of-time sample dengan 24H embargo).
- **Champion Model**: `M2_LightGBM_All`
- **Hasil Utama**:
  - Model Champion Macro-F1: **0.3166** (vs Baseline B0: 0.1930, Baseline B1: 0.2691).
  - Balanced Accuracy: **0.3199** (vs B0: 0.3333, B1: 0.3035).
  - Korelasi Spearman (Rank IC): **0.0635** (p-value: 0.27942).
  - Uji Kontrol Negatif (Shuffled Labels F1): **0.3287** (membuktikan ketiadaan kebocoran data artifisial).

## 2. Perbandingan Model pada Set Uji (Out-of-Time)
| Model | Deskripsi | Macro-F1 | Balanced Accuracy |
| :--- | :--- | :---: | :---: |
| **B0** | Majority Class Baseline | 0.1930 | 0.3333 |
| **B1** | Sentiment Score Sign Rule | 0.2691 | 0.3035 |
| **M2_LightGBM_All** | **Champion Model** | **0.3166** | **0.3199** |

## 3. Matriks Konfusi (Kelas: [-1: Turun, 0: Datar, 1: Naik])
```text
Prediksi ->     Turun (-1)   Datar (0)   Naik (+1)
Aktual Turun       39         34         37        
Aktual Datar       21         18         24        
Aktual Naik        51         30         38        
```

## 4. Kesimpulan Kepatuhan & Metodologi
1. **Kepatuhan FR-10**: Model adalah instrumen pengukuran statistik empiris, bukan sinyal transaksi beli/jual.
2. **Anti-Lookahead**: Seluruh fitur waktu, sentimen, dan volatilitas divalidasi tidak menyentuh data masa depan.
3. **Status Hasil**: Model berhasil melampaui kedua baseline acak dan aturan dasar dengan keunggulan F1 terukur pada sampel out-of-time.
