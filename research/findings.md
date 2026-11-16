# Research Findings — XAUUSD News Sentiment

## Research Question

Apakah fitur sentimen berita (VADER / Loughran-McDonald / embedding kalimat)
menambah nilai prediksi return XAUUSD 4 jam di atas baseline makro, dan
representasi teks mana yang paling berpengaruh?

## Current Understanding

Model champion saat ini (Ridge_Linear) **belum** terbukti menambah nilai dari
fitur berita: pada split chronological, `delta_rank_ic = -0.0047` (p=0.683) dan
`sentiment_adds_value = False`. Pada split `news_era` delta +0.0023 (p=0.326);
dengan pembobotan topik +0.0055 (p=0.163). Artinya: ada indikasi arah yang
benar, tapi belum signifikan.

Dugaan utama (belum teruji):
1. **Representasi teks terlalu lemah.** TF-IDF + PCA pada judul saja. Hanya
   ~5,6% artikel yang punya isi. Embedding kalimat (sentence-transformers)
   belum dipakai sama sekali di pipeline.
2. **Data berita tidak kontinu.** Korpus 35.100 artikel terkonsentrasi di
   2010-2020 (HF), 2022 (GDELT), 2026 (API). Periode 2021-2025 nyaris kosong,
   sehingga model tidak pernah berlatih pada periode itu.
3. **Evaluasi sudah jujur.** Paired bootstrap vs baseline makro dipakai, jadi
   klaim "sentimen berguna" tidak bisa dipaksakan.

## Key Results

Belum ada eksperimen baru pada workspace ini. Baseline yang dipakai:

| Split | Full IC | Baseline IC | Delta | p-value | adds_value |
|---|---|---|---|---|---|
| chronological | 0.0336 | 0.0383 | -0.0047 | 0.683 | False |
| news_era | 0.0199 | 0.0176 | +0.0023 | 0.326 | False |
| news_era + topic weighting | — | — | +0.0055 | 0.163 | False |

## Patterns and Insights

- Berita **komoditas/emas** punya sinyal jauh lebih kuat (p=0.0005) daripada
  topik umum `financial_markets` (tanpa sinyal). Berarti agregasi topik yang
  terlalu luas mengencerkan sinyal.
- Interaksi sentimen × surprise makro hanya berpengaruh saat surprise besar
  (|z| > 0.5); pada surprise kecil, sentimen cenderung netral.
- VADER (umum) dan Loughran-McDonald (keuangan) memberi arah yang sama pada
  berita negatif, tapi LM tidak signifikan (p=0.176) — konsisten dengan
  temuan bahwa leksikon saja kurang kontekstual.

## Lessons and Constraints

- `sentiment_adds_value` harus diuji dengan **paired bootstrap** (full vs
  baseline makro), bukan p-value model penuh. Sudah diterapkan.
- Jangan mencocokkan berita per-waktu untuk peristiwa makro; yang diukur adalah
  efek berita terhadap kondisi pasar saat itu.
- Split `news_era` (test = bucket berita, out-of-time) lebih jujur daripada
  `chronological` untuk pertanyaan "apakah berita menambah nilai".
- Model jangan dipaksa signifikan; lapor `False` bila memang tidak signifikan.

## Open Questions

- Apakah embedding kalimat mengubah delta rank IC secara signifikan?
- Apakah menambahkan isi berita (body) pada 5,6% artikel yang ada isinya
  cukup untuk mengubah kesimpulan?
- Bagaimana mengisi gap 2021-2025 tanpa sumber berita historis yang andal?

## Optimization Trajectory

Belum ada. Eksperimen pertama (H1: embedding) direncanakan.
