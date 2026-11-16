# Research Log — XAUUSD News Sentiment

## 2026-11-15 — Inisialisasi

- Membuat workspace `research/` (state, findings, literature, experiments, to_human).
- Bootstrap literatur: 5 kelompok relevan (emas+sentimen, FinBERT, FX, leksikon,
  embedding). Lihat `literature/survey.md`.
- Gap: embedding kalimat kontekstual belum diuji; isi berita minim; evaluasi
  paired bootstrap belum lazim.
- Hipotesis awal: H1 (embedding), H2 (isi berita), H3 (interaksi surprise),
  H4 (gap data).
- Baseline: chronological delta -0.0047 (p 0.683); news_era +0.0023 (p 0.326);
  news_era + topic weighting +0.0055 (p 0.163). `sentiment_adds_value=False`.
- Arah: uji H1 (embedding) lebih dulu karena representasi teks adalah akar
  masalah dan paling murah diuji.
