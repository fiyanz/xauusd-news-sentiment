# Analisis H1 — Embedding Kalimat

## Protokol (locked)

- **H1:** menambah fitur embedding kalimat (sentence-transformers `all-MiniLM-L6-v2`,
  PCA 16 komponen, fit on train) meningkatkan rank IC test di atas baseline makro.
- **Prediksi:** delta_rank_ic > 0.
- **Metode:** Ridge, paired bootstrap 1.000 resampling, full vs baseline.
- **Anti look-ahead:** PCA + scaler difit pada train; fitur siklikal dan PCA makro
  diturunkan di dalam split.

## Hasil

| Split | n | Baseline IC | Full IC | Delta | p-value | adds_value |
|---|---|---|---|---|---|---|
| chronological | 5.189 | 0,0286 | 0,0370 | +0,0084 | 0,036 | True |
| news_only_test (bucket berita) | 2.701 | 0,0569 | 0,1091 | **+0,0522** | **0,013** | **True** |
| out_of_time (val+test) | 10.370 | 0,0231 | 0,0277 | +0,0046 | 0,124 | False |

## Pelajaran penting (kebocoran)

Versi pertama skrip evaluasi memakai `p_4h` dan `p_24h` sebagai fitur baseline.
Keduanya adalah **harga masa depan** (forward-looking), sehingga baseline mencapai
IC 0,99 dan delta jadi −0,57. Ini bukan kesalahan pipeline produksi (pipeline resmi
tidak memakai keduanya), tapi kesalahan skrip eksperimen ini.

Setelah diganti dengan `baseline_feature_cols` resmi dari
`models/champion_fair_model.joblib` (21 fitur, tanpa `p_4h`/`p_24h`), hasilnya
masuk akal.

**Aturan baru:** jangan pernah memakai kolom `p_4h`, `p_24h`, `ret_*`, `sign_*`,
`direction_*` sebagai fitur. Selalu ambil daftar fitur dari bundle model.

## Interpretasi

- Embedding **signifikan pada bucket yang punya berita** (delta +0,052, p=0,013).
- Pada split out-of-time gabungan (mayoritas bucket tanpa berita), efek tidak
  signifikan — wajar, karena embedding teks berita hanya bermakna saat ada berita.
- Konsisten dengan temuan awal: berita terbukti berpengaruh saat ia ada.

## Status

**Didukung (bersyarat)** — signifikan di bucket berita, tidak di luar berita.
Lanjut ke H2 (isi berita) untuk menguji apakah menambah isi artikel memperkuat.
