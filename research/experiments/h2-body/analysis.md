# Analisis H2 — Judul vs Judul+Isi

## Protokol (locked)

- **H2:** menambahkan isi artikel ke teks embedding meningkatkan delta rank IC
  pada bucket berita, dibanding judul saja.
- **Prediksi:** delta(body) > delta(title-only).
- **Metode:** dua set embedding (title-only, title+body), PCA 16, paired bootstrap.

## Hasil (test = bucket berita, n=2.701)

| Model | IC | Delta vs baseline | p-value |
|---|---|---|---|
| baseline | 0,0569 | — | — |
| title-only | 0,0952 | +0,0383 | 0,051 |
| title+body | 0,1091 | +0,0522 | 0,013 |
| body vs title (langsung) | — | +0,0141 | 0,166 |

## Interpretasi

- Arah positif: menambah isi berita menaikkan IC dari 0,0952 → 0,1091.
- Tapi **tidak signifikan** (p=0,166) karena hanya ~5,6% artikel yang punya isi
  (≈1.900 dari 35.100), sehingga sampel efektif kecil.
- Konsisten dengan literatur (FinBERT-LSTM menyatakan judul-only sebagai
  keterbatasan), tapi data ini belum cukup untuk membuktikannya.

## Status

**Inconclusive** — arah mendukung, daya statistik kurang. Perlu lebih banyak
artikel berisi (mis. scraping domain yang diizinkan, atau dataset historis
tambahan) sebelum bisa disimpulkan.

## Pelajaran

- Jangan menilai "isi berita tidak berguna" dari p=0,166 pada sampel 5,6%.
  Ini masalah daya, bukan bukti ketidakefektifan.
