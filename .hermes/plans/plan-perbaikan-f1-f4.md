# Plan Perbaikan F1-F4 — Integritas Data & Klaim Statistik

Status: DRAFT — menunggu persetujuan. Belum ada file kode yang diubah.
Repo: /home/kazu/Projects/magang/sistem-informasi-market-xauusd
Basis: temuan find-bugs + data-pipeline-integrity-audit (F1-F4 = Critical/High).

---

## 0. Ringkasan

Masalah inti: sistem ini menampilkan angka karangan sebagai hasil pengukuran pasar.

- F1 (Critical): fitur model (actual/forecast/z_score makro, sentimen berita) disintesis
  dengan RNG dan 15 template. Model dilatih di atasnya.
- F2 (Critical): API & UI menampilkan surprise, historical log, COT, digest harian, dan
  fallback makro yang di-hardcode.
- F3 (High): chart 5m/15m adalah subdivisi sintetis dari H1, tapi UI menulis
  "Loading real XAUUSD candles".
- F4 (High): rank IC 0.0569 (p=0.44) dan hit ratio 55.06% dipajang sebagai "Strong Alpha";
  `sentiment_adds_value` di-hardcode `True`; confidence dipaksa minimal 51%.

Tujuan perbaikan: setiap angka yang dipajang bisa ditelusuri ke sumber nyata. Kalau sumber
tidak tersedia, sistem mengatakan `unavailable` — bukan mengarang pengganti.

Keputusan sumber data (sesuai konfirmasi user): KEYLESS.
Intraday via yfinance, berita via RSS, actuals makro via BLS API publik. BLS tanpa key
membatasi 25 query/hari — cukup untuk refresh harian, tapi harus di-cache.

---

## 1. Fakta terkini (terverifikasi)

- `bun run test` 5 pass, `bun run lint` bersih, `bun run build` 2 task sukses,
  `pytest` 18 pass. Baseline hijau, tapi cakupan test sempit.
- `services/sentiment-analysis/data/raw/calendar/economic_calendar_enriched.csv`
  (748 baris) berisi actual/forecast/previous/z_score hasil `rng.normal` (seed 42)
  dari `src/acquire/calendar.py:78-98`.
- `data/raw/news/news_sentiment_feed.json` (1506 artikel) dari 15 template
  `src/acquire/news.py:20-108`, URL `https://example.com/finance/news/<id>`.
- `data/processed/bucketed_features.parquet`: 926 baris, 111 kolom,
  time_bucket max 2026-10-28 08:00; price CSV sampai 2026-11-06 21:00
  (prediksi basi 9 hari — F5, akan ikut terselesaikan karena artefak di-regenerasi).
- `reports/full_metrics_evaluation.json`: Random Forest rank IC 0.0569, p=0.44041,
  hit_ratio_sig 55.06% (N=186).
- Dependensi Python tersedia: pandas, numpy, scipy, sklearn, yfinance, bs4, requests, pyyaml.
  BELUM ada: `nltk`, `feedparser`, `statsmodels` (tidak wajib — binomial test pakai
  `scipy.stats.binomtest`).
- `.venv` sudah ada di `services/sentiment-analysis/.venv` (Python 3.12).

---

## 2. Keputusan sumber data (keyless)

| Kebutuhan | Sumber | Endpoint / series | Kalau gagal |
|---|---|---|---|
| Actual CPI m/m | BLS API v2 (key opsional) | `CUSR0000SA0` (indeks SA) -> hitung % m/m | label `simulated` |
| Core CPI m/m | BLS API v2 | `CUSR0000SA0L1E` | label `simulated` |
| NFP (K) | BLS API v2 | `CES0000000001` (ribu) -> /1000 | label `simulated` |
| Core PCE m/m | FRED CSV publik | `PCEPILFE` via `fred.stlouisfed.org/graph/fredgraph.csv?id=PCEPILFE` (verifikasi tanpa key) | label `simulated` |
| FOMC rate | FRED CSV publik | `DFEDTARU`/`DFEDTARL` -> deteksi perubahan target range | label `simulated` |
| Forecast konsensus | TIDAK ADA sumber keyless yang andal | — | `forecast = null`; surprise pakai `actual - previous` |
| Berita | RSS (feedparser) | feed keuangan (Bloomberg/CNBC/MarketWatch/FT/dsb.) + feed khusus logam mulia | `unavailable` |
| Sentimen berita | VADER (nltk) | `nltk.sentiment.vader.SentimentIntensityAnalyzer` | `unavailable` |
| Intraday 5m/15m | yfinance | `GC=F`, `interval="5m"/"15m"` (maks ~60 hari) | label `estimated_from_h1` |
| COT | CSV mingguan CFTC (keyless) | `cftc.gov/dea/newcot/...` (verifikasi URL & series gold) | `unavailable` |

Aturan fallback: jangan pernah membuat angka pengganti yang tampak real. Gunakan
`null` + `status:"unavailable"` + `reason`. Kalau memang ingin simulasi, tandai
`is_simulated: true` di data dan di UI.

---

## 3. Kontrak bersama (harus dipatuhi semua agent)

### 3.1 Provenance
Setiap artifact yang digenerasi ulang menyertakan metadata:
- `data/raw/calendar/economic_calendar_enriched.csv`: tambah kolom `source`, `forecast_source`,
  `surprise_method` (`consensus` | `actual_minus_previous`), `is_simulated`.
- `data/raw/news/news_sentiment_feed.json`: setiap item tambah `source_feed`, `source_url`
  (URL asli artikel), `sentiment_method` (`vader` | `unavailable`).
- `data/raw/price/xauusd_m5.csv`, `xauusd_m15.csv`: kolom `is_real` (1) / `is_estimated` (0).
- `data/processed/bucketed_features.parquet`: tambah kolom `data_source`, `generated_at`.
- File ringkasan `data/processed/provenance.json`: {artifact, source, generated_at, as_of, is_simulated}.

### 3.2 API contract
- `apps/api/src/server.ts` dan route web: kalau data tidak tersedia, kembalikan
  `{ "status": "unavailable", "reason": "<penyebab>" }` dengan field analisis `null`.
  Dilarang mengembalikan konstanta karangan.
- `packages/financial-clients/src/index.ts`: `fetchLatestCOTReport()` -> `COTReport | null`;
  `fetchEconomicCalendar()` -> event nyata (tanpa actual/forecast hardcode);
  `fetchXauusdCandles()` -> tambah flag `isSimulated` pada hasil synthetic.

### 3.3 Schema lock (jangan diubah nama kolomnya)
`bucketed_features.parquet` wajib tetap punya: `time_bucket`, `ret_4h`, `ret_24h`, `vol_pre`,
`z_score`, `surprise_val`, `sentiment_score`, `topic_*`, `sentiment_x_*`, `macro_*`,
`session_*`, `split`, `p0`. Agent 4 (train/evaluate) membaca kolom ini.

### 3.4 Significance contract
Agent 4 menulis `reports/significance.json`:

```json
{
  "champion_name": "...",
  "selection_method": "cv_mean_rank_ic | cv_mean_hit_sig",
  "test_samples": 186,
  "hit_ratio_sig": 0.5506,
  "hit_ratio_ci95": [0.47, 0.63],
  "hit_ratio_pvalue": 0.15,
  "rank_ic": 0.0569,
  "rank_ic_pvalue": 0.44,
  "pesaran_timmermann_stat": 0.0,
  "pesaran_timmermann_pvalue": 0.0,
  "negative_control_ic": 0.0,
  "sentiment_adds_value": false,
  "sentiment_adds_value_basis": "rank_ic_pvalue < 0.05 or hit_ratio_pvalue < 0.05"
}
```

`sentiment_adds_value` dihitung dari signifikansi, bukan hardcode.

---

## 4. Matriks kepemilikan file

| Agent | File yang boleh diubah | File yang DILARANG diubah |
|---|---|---|
| Lead (Fase 0) | `.hermes/plans/*`, `pyproject.toml`, `tests/*` (test baru), `config.yaml` (hanya Fase 0) | — |
| Agent 1 (F1) | `services/sentiment-analysis/src/acquire/*.py`, `src/process/*.py`, `src/features/*.py`, `src/pipeline/*.py`, `config.yaml`, `data/**` | `src/models/*`, `src/evaluate/*`, `apps/**`, `packages/**` |
| Agent 2 (F2) | `apps/api/src/server.ts`, `packages/financial-clients/src/index.ts`, `apps/web/src/app/api/market/*`, `apps/web/src/app/page.tsx` | `expert-data.ts`, `src/**`, `candle-cache.ts`, `market-chart.tsx` |
| Agent 3 (F3) | `packages/financial-clients/src/expert-data.ts`, `apps/web/src/lib/candle-cache.ts`, `apps/web/src/components/market-chart.tsx` | `index.ts`, `apps/api/**`, `src/**`, `page.tsx` |
| Agent 4 (F4) | `services/sentiment-analysis/src/models/*.py`, `src/evaluate/*.py`, `reports/*`, `data/processed/latest_prediction.json` | `src/acquire/*`, `src/process/*`, `apps/**`, `packages/**` |

Catatan: Agent 2 dan Agent 3 sama-sama menyentuh `packages/financial-clients` tapi file
berbeda (`index.ts` vs `expert-data.ts`). Agent 1 dan Agent 4 sama-sama menyentuh
`services/sentiment-analysis` tapi subdirektori berbeda.

---

## 5. Fase 0 — Lead (kontrak & test, sebelum agent)

Tujuan: mencegah regresi dan memberi alat verifikasi. Tidak mengubah logic produksi.

1. Tulis test provenance di `services/sentiment-analysis/tests/test_provenance.py`:
   - `economic_calendar_enriched.csv` punya kolom `source`, `is_simulated`; tidak ada
     actual/forecast yang `is_simulated=false` tapi `source` kosong.
   - `news_sentiment_feed.json` tidak ada URL `example.com`; `sentiment_method` terisi.
   - `bucketed_features.parquet` punya kolom `data_source`, `generated_at`.
2. Tambah test look-ahead kalender di `tests/test_harmonize.py`:
   - untuk setiap artikel, event kalender yang dipakai harus `timestamp_utc <= time_published_utc`
     (direction backward), bukan nearest.
3. Tambah test signifikansi di `tests/test_significance.py`:
   - `reports/significance.json` ada, `sentiment_adds_value` konsisten dengan p-value,
     `champion_name` cocok dengan `cv_summary` terbaik.
4. Tambah dependensi: `nltk`, `feedparser` ke `pyproject.toml`; jalankan `uv sync`;
   `python -m nltk.downloader vader_lexicon` (kalau offline, catat sebagai known issue
   dan pakai fallback `unavailable`).
5. Baseline hijau ulang: `bun run test`, `bun run lint`, `bun run build`, `pytest`.

Definition of done Fase 0: semua test baru pass, dependency terpasang, baseline hijau.

---

## 6. Fase 1 — Agent 1 (F1: provenance data)

Goal: ganti semua input sintetis di pipeline Python dengan data nyata (keyless) dan
tandai eksplisit apa yang tidak bisa diperoleh. Hasil akhir: artifact di-regenerasi
dengan provenance yang bisa diaudit.

Owned: `src/acquire/*.py`, `src/process/*.py`, `src/features/*.py`, `src/pipeline/*.py`,
`config.yaml`, `data/**`.

Tasks:

T1.1 `src/acquire/calendar.py` — buang `rng.normal` untuk actual/forecast/previous.
- Klasifikasikan event berdasarkan `name` -> seri BLS/FRED (CPI, Core CPI, NFP, Core PCE, FOMC).
- Ambil actual dari BLS API v2 (`requests.post` ke `https://api.bls.gov/publicAPI/v2/timeseries/data/`,
  tanpa key = 25 query/hari; cache response ke `data/cache/bls_<series>.json`).
- Forecast: `null` (tidak ada sumber keyless). `surprise_val = actual - previous`,
  `surprise_method = "actual_minus_previous"`.
- Kalau seri tidak tersedia/gagal: `is_simulated = true` untuk baris itu, dan simpan
  `source = "simulated"`. Jangan biarkan campuran tanpa penanda.
- Tambah kolom `source`, `forecast_source`, `surprise_method`, `is_simulated`.
- Hapus `EVENT_PARAMS` hardcode sebagai sumber nilai (boleh dipakai sebagai pemetaan nama->seri).

T1.2 `src/acquire/news.py` — buang `HEADLINE_TEMPLATES` dan generator artikel sintetis.
- Pakai `feedparser` untuk RSS. Daftar feed di `config.yaml` (pengguna: pindahkan/duplikasi
  daftar RSS dari `.agents/skills/finance-news/config/config.json` sebagai referensi).
- Ambil `title`, `summary`, `link`, `published`. Filter topik keuangan/logam mulia.
- Sentimen: VADER (`nltk`). Simpan `overall_sentiment_score` (compound), `overall_sentiment_label`
  (Bullish/Bearish/Neutral berdasarkan ambang -0.05/0.05), `sentiment_method="vader"`.
- `url` wajib URL asli (`link`), bukan example.com.
- Kalau feed gagal: tulis `[]` + `status unavailable`, jangan artikel karangan.

T1.3 `src/acquire/price.py` — perbaiki dan perluas.
- Perbaiki `tz_convert` -> `tz_localize` bila index naive.
- Ganti `end_date` hardcode dengan hari ini (UTC).
- Tambah `refresh_intraday_data()`: yfinance `GC=F` interval 5m/15m, simpan ke
  `data/raw/price/xauusd_m5.csv` dan `xauusd_m15.csv`, kolom `time,open,high,low,close,volume,is_real`.
- Cache: jangan unduh ulang kalau file < 6 jam.

T1.4 `src/acquire/macro.py` — buang `_generate_synthetic_fallback` sebagai pengganti diam-diam.
- Kalau gagal unduh: seri `NaN`/kosong + penanda `is_simulated`, bukan random walk.
- Ganti default `end_date` "2026-11-05" -> `None` (hari ini).

T1.5 `src/process/bucket_harmonize.py:53-60` — fix look-ahead (pendukung F1).
- `direction="nearest"` -> `direction="backward"` (hanya event yang sudah lewat).
- Tambah `calendar_merge_direction` sebagai konstanta terdokumentasi.

T1.6 `src/process/harmonize.py` — guard `np.min` pada `cal_times` kosong (F17).
- Tambah penanda `is_simulated` bila input news/kalender kosong.

T1.7 `src/pipeline/sync.py` — pastikan urutan: price -> intraday -> macro -> calendar ->
news -> harmonize -> buckets. Tulis `data/processed/provenance.json` di akhir.

T1.8 Regenerasi artifact: jalankan pipeline penuh, pastikan `bucketed_features.parquet`
memenuhi schema lock (3.3) dan `time_bucket` max mendekati price CSV max (freshness).

Acceptance F1:
- Tidak ada `rng.normal`/`HEADLINE_TEMPLATES` yang menghasilkan data yang dipajang.
- `example.com` tidak ada di news JSON.
- Ada provenance di semua artifact.
- `pytest` pass; schema lock utuh; freshness gap < 1 hari.

---

## 7. Fase 2 — Agent 2, 3, 4 (paralel)

### Agent 2 (F2: hilangkan angka karangan di API & UI)

Owned: `apps/api/src/server.ts`, `packages/financial-clients/src/index.ts`,
`apps/web/src/app/api/market/*`, `apps/web/src/app/page.tsx`.

T2.1 `apps/api/src/server.ts:108-154` — event-study:
- Buang `code === "CPI" ? 0.4 : 254` dan `isWeak = i % 2 === 0`.
- Hitung surprise dari event nyata (actual/forecast/previous dari calendar enrichment).
- `historicalLogs` dari event nyata + reaksi candle nyata; kalau tidak ada data,
  `historicalLogs: []` + `status:"unavailable"`.
- `reactions` dari `calculateReactionWindows` pada candle nyata.

T2.2 `apps/api/src/server.ts:156-184` — COT & digest:
- `fetchLatestCOTReport()` -> `COTReport | null`; kalau null, `status:"unavailable"`.
- Digest markdown digenerate dari data nyata (price stats + kalender + COT) atau `unavailable`.

T2.3 `apps/api/src/server.ts:194-225` — macro-sentiment:
- Baca `latest_prediction.json`; kalau tidak ada -> `status:"unavailable"`, tanpa harga karangan.
- Hapus fallback `current_price: 4451.86`, `confidence_pct: 64.2`, dll.

T2.4 `packages/financial-clients/src/index.ts`:
- Buang actual/forecast/previous hardcode (`:93-96`) -> pakai data nyata dari calendar.
- `fetchLatestCOTReport` (:133-142) -> nullable + sumber nyata.
- `fetchXauusdCandles` synthetic fallback (:36-76) -> tambah `isSimulated: true`.

T2.5 `apps/web/src/app/api/market/*` — samakan contract `unavailable`; tambah timeout
`AbortSignal.timeout(2000)` pada fetch ke localhost:4000 (F9).

T2.6 `apps/web/src/app/page.tsx` — buang constant bohong:
- `:213-214` bid/ask fallback 4122.754 -> null + label.
- `:243/768/772/776` balance/equity 1,500.00 -> label "Demo (bukan dana nyata)" atau hapus.
- `:701-706` COT +268,410 -> data nyata atau unavailable.
- Tampilkan `reports/significance.json` (kontrak 3.4) di panel AI: p-value + CI, bukan
  hanya "55.06%".

Acceptance F2: tidak ada angka analisis hardcode yang tersisa; `grep` untuk
`4451.86`, `268410`, `isWeak`, `254`, `140`, `159` di `apps/` dan `packages/` bersih
(kecuali yang legitimate).

### Agent 3 (F3: intraday chart)

Owned: `packages/financial-clients/src/expert-data.ts`, `apps/web/src/lib/candle-cache.ts`,
`apps/web/src/components/market-chart.tsx`.

T3.1 `expert-data.ts`:
- `getRecentCandles` untuk 5m/15m baca `data/raw/price/xauusd_m5.csv` / `xauusd_m15.csv`
  (dari T1.3), bukan `subdivide()`.
- Kalau file intraday tidak ada: kembalikan data H1 + flag `is_estimated:true`, dan
  UI menampilkan "estimated from H1".

T3.2 `candle-cache.ts`:
- Sama: 5m/15m dari CSV intraday; `subdivideCandles` hanya dipakai sebagai fallback
  berlabel estimated.
- Tambah TTL pada cache (mis. 5 menit) + mtime check, bukan forever.
- Baca CSV dengan streaming/buffered, bukan `readFileSync` penuh di request pertama.

T3.3 `market-chart.tsx`:
- Ubah copy "Loading real XAUUSD candles..." -> "Memuat data XAUUSD..." dan tambah
  indikator sumber (real vs estimated).
- Perbaiki SSE fallback `:439-447` (F14): ekstrak `attachHandlers(es)` dan pasang ke
  koneksi awal + fallback; tambah backoff.
- Hapus `http://localhost:4000` fallback yang mati (F14) atau perbaiki.

Acceptance F3: chart 5m/15m menampilkan bar intraday nyata (atau label estimated yang
jelas); SSE fallback benar-benar menerima tick.

### Agent 4 (F4: significance & champion)

Owned: `services/sentiment-analysis/src/models/*.py`, `src/evaluate/*.py`, `reports/*`,
`data/processed/latest_prediction.json`.

T4.1 Tambah `src/evaluate/significance.py`:
- `binomtest` (scipy) untuk hit ratio vs 0.5; Wilson CI; Spearman p (sudah);
  Pesaran-Timmermann (sudah di `evaluate_fair.py`); negative control (shuffle).
- Tulis `reports/significance.json` sesuai kontrak 3.4.

T4.2 `src/models/train.py:185` — champion dipilih by CV:
- `champion_name = max(cv_summary, key=lambda k: cv_summary[k]["rank_ic"])` (atau hit_ratio_sig).
- Simpan `selection_method` di bundle.

T4.3 `src/models/predict.py:65-66` — hapus `max(confidence, 51.0)`.
- Confidence = magnitude relatif terhadap vol, tanpa lantai buatan; tambah `threshold` ke payload.

T4.4 `src/evaluate/evaluate_models.py`:
- Buang `"sentiment_adds_value": True` hardcode (`:144`) -> hitung dari significance.
- Masukkan p-value + CI di markdown (`:243-249`).
- Guard `sig_mask` kosong (`:111`) -> `None`, hindari `NaN` di JSON.

T4.5 `src/evaluate/evaluate_fair.py` — selaraskan `delta_alpha` dengan significance.

T4.6 Latih ulang model di atas artifact baru (F1) dan tulis ulang `reports/*` +
`latest_prediction.json`. Pastikan `champion_name` di bundle cocok dengan
`reports/significance.json`.

Acceptance F4: `reports/significance.json` ada dan konsisten; `sentiment_adds_value`
dihitung; champion = argmax CV; tidak ada lantai confidence; p-value tampil di UI (via Agent 2).

---

## 8. Verifikasi (setelah semua fase)

1. `bun run test`, `bun run lint`, `bun run build` -> hijau.
2. `cd services/sentiment-analysis && .venv/bin/python -m pytest -q` -> hijau (termasuk
   test provenance/lookahead/significance baru).
3. Trace satu angka UI ke sumber: pilih "AI 4H FORECAST" dan "surprise CPI", telusuri
   sampai CSV/API. Harus ada sumber nyata atau label unavailable.
4. Cek `reports/significance.json` dan tampilannya di UI.
5. Cek freshness: `time_bucket` max di parquet vs price CSV max < 1 hari.
6. Cek `grep` sisa karangan: `4451.86`, `268410`, `HEADLINE_TEMPLATES`, `example.com`,
   `isWeak`, `adds_value": True`.

---

## 9. Risiko & open question

- BLS API tanpa key: 25 query/hari. Kalau pipeline jalan sering, cache wajib.
- FRED CSV publik mungkin memerlukan key/berubah URL -> verifikasi dini di Fase 0;
  kalau gagal, PCE/FOMC dilabeli simulasi (bukan karangan).
- yfinance intraday hanya ~60 hari terakhir; chart 5m/5m history terbatas — ini
  batasan sumber, bukan bug.
- RSS feed bisa berubah struktur; feedparser menetralkan sebagian besar.
- VADER adalah lexicon baseline, bukan model fine-tuned; harness harus mencatat
  `sentiment_method: vader` agar tidak diklaim sebagai model canggih.
- Perubahan `direction="nearest"` -> `"backward"` bisa mengurangi jumlah fitur yang
  match (surprise banyak NaN) -> metrik model berubah. Ini diharapkan (data jujur),
  tapi laporan evaluasi harus diperbarui, dan klaim "Strong Alpha" harus dicabut kalau
  signifikansi menurun.
- Artefak lama (parquet/joblib) di-regenerasi; ukuran file bisa berubah.

---

## 10. Definisi selesai

- Tidak ada data sintetis yang dipajang sebagai pengukuran.
- Semua angka analisis punya provenance atau status unavailable.
- Chart intraday memakai data nyata (atau label estimated).
- Laporan/significance jujur (p-value, CI, champion by CV).
- UI menampilkan status & signifikansi, bukan angka karangan.
- Semua test & build hijau.

---

## 11. Di luar scope plan ini

F5-F30 dari laporan find-bugs (stale prediction, NaN limit, hardcoded path, .env.example
SQLite, nested git, db:push tanpa config, SSE fallback, dll). Beberapa (F5, F7, F9, F14)
masuk sebagai sub-task pendukung di atas; sisanya dikerjakan setelah F1-F4 tuntas.

---

## 12. Cara eksekusi (nanti)

1. Fase 0: lead kerjakan kontrak + test + dependency.
2. Fase 1: Agent 1 (F1) sendirian.
3. Fase 2: Agent 2, 3, 4 paralel dengan ownership di matriks.
4. Verifikasi oleh lead.
