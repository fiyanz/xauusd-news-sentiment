# Literature Survey — XAUUSD News Sentiment

## Ringkasan

Lima kelompok literatur relevan:

1. **Sentimen berita emas langsung** — Entropy 2026 (CNN-QRLSTM).
2. **FinBERT + model sekuens** — arXiv 2306.02136.
3. **Sentimen berita & FX** — ACM 2025, EURUSD high-frequency 2022.
4. **Leksikon keuangan** — Loughran-McDonald (sudah dipakai).
5. **Embedding kalimat** — sentence-transformers (umum, belum spesifik keuangan).

---

## gold_eemd_cnn_qrlstm_2026

- **Judul:** Forecasting the Price of Gold with Integrated Media Sentiment — CNN-QRLSTM
- **Penulis/tahun:** Entropy 28(3):271, 2026
- **URL:** https://www.mdpi.com/1099-4300/28/3/271
- **Temuan kunci:**
  - Sentimen berita emas + dekomposisi EEMD + quantile regression LSTM.
  - MAE turun 26,505 → 13,200; RMSE 35,010 → 16,783; R² 0,989 → 0,998.
  - Memakai indikator sentimen harian agregat, bukan per-artikel.
- **Relevansi:** Paling dekat dengan topik (emas + sentimen berita).
  Memperkuat hipotesis bahwa sentimen **agregat harian** lebih berguna daripada
  sentimen per-artikel yang tersebar.
- **Keterbatasan:** Dataset tidak dibuka; metrik pada skala harga (bukan return).

## finbert_lstm_2023

- **Judul:** Financial Sentiment Analysis Using FinBERT with Application in Predicting Stock Movement
- **Penulis/tahun:** arXiv 2306.02136, 2023
- **URL:** https://arxiv.org/html/2306.02136
- **Temuan kunci:**
  - FinBERT + LSTM mengungguli BERT, LSTM saja, dan ARIMA.
  - **Mengakui judul-only sebagai keterbatasan**; menyarankan isi artikel penuh.
- **Relevansi:** Langsung mendukung H2 (isi berita > judul saja).
- **Keterbatasan:** Saham, bukan emas; metrik arah, bukan return.

## news_fx_volatility_2025

- **Judul:** The Impact of News Sentiment on Exchange Rate Volatility
- **URL:** https://dl.acm.org/doi/abs/10.1145/3729706.3729741
- **Temuan:** Sentimen berita memengaruhi **volatilitas** FX, bukan hanya arah.
- **Relevansi:** Menjelaskan kenapa `hit_ratio` bisa lebih baik daripada IC.

## novel_news_eurusd_2022

- **Judul:** High-Frequency Effects of Novel News on the EURUSD Exchange Rate
- **URL:** https://www.tandfonline.com/doi/abs/10.1080/15427560.2022.2100386
- **Temuan:** Efek berita terlihat pada frekuensi tinggi.
- **Relevansi:** Memperkuat pilihan bucket 4H (bukan harian).

## media_sentiment_nber

- **Judul:** Media Sentiment and International Asset Prices
- **URL:** https://www.nber.org/system/files/working_papers/w25353/w25353.pdf
- **Temuan:** Sentimen media memengaruhi harga aset internasional.
- **Relevansi:** Dasar teoretis kenapa berita emas global relevan ke XAUUSD.

---

## Gap yang Teridentifikasi

- Belum ada studi yang memakai **embedding kalimat kontekstual** (sentence
  transformer) untuk return XAUUSD dengan evaluasi paired bootstrap.
- Hampir semua memakai **judul saja**; isi berita jarang.
- Evaluasi jarang memisahkan **efek topik** (emas vs makro vs geopolitik).
- Gap data historis (2021–2025) jarang diungkapkan secara eksplisit.
