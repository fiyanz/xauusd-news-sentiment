# Laporan Akuisisi Konteks Makro Point-in-Time (Fase 1 Roadmap)

## 1. Ringkasan Eksekutif
- **Tujuan**: Mengakuisisi variabel makro fundamental pendorong XAUUSD (Yields AS, Indeks Dolar, Minyak Bumi) dengan kepatuhan ketat *Point-in-Time* (PIT) bebas kebocoran masa depan (*zero lookahead*).
- **Periode Data**: `2010-01-01` s.d. `2026-11-04` (4.394 hari bursa / business days).
- **Berkas Keluaran**: `data/raw/macro/macro_context.csv` (4.394 baris, 22 kolom fitur dan unlagged auditing).
- **Status Pengujian**: 5/5 unit test di `tests/test_macro.py` lolos hijau (`uv run pytest tests/test_macro.py`).

---

## 2. Rincian Instrumen & Transformasi Fitur

| Kode Aset | Simbol Yahoo Finance | Peran Teoretis pada XAUUSD | Fitur Diturunkan |
| :--- | :--- | :--- | :--- |
| **US10Y** | `^TNX` | Biaya peluang memegang emas non-yielding & suku bunga acuan | `us10y_close`, `us10y_delta_1d`, `us10y_delta_5d` |
| **DXY** | `DX-Y.NYB` | Kekuatan relatif mata uang denominasi emas (USD) | `dxy_close`, `dxy_delta_1d`, `dxy_delta_5d` |
| **WTI Oil** | `CL=F` | Ekspektasi inflasi komoditas dan premi risiko geopolitik | `oil_close`, `oil_delta_1d`, `oil_delta_5d` |

### Disiplin Point-in-Time (`shift(1)`)
Untuk menjamin tidak ada bias pandangan masa depan (*lookahead bias*):
1. Seluruh perubahan `delta_1d` ($P_{t} - P_{t-1}$) dan `delta_5d` ($P_{t} - P_{t-5}$) dihitung pada data harian mentah.
2. Seluruh matriks fitur digeser 1 hari bursa: $\text{Feature}_T = \text{RawValue}_{T-1}$.
3. Pada waktu $T$, hanya informasi penutupan pasar $T-1$ yang tampak pada model regresi/klasifikasi.

---

## 3. Hasil Validasi & Integritas Data

- **Cakupan Tanggal**: Mulai dari `2010-01-01 00:00:00+00:00` hingga `2026-11-04 00:00:00+00:00`.
- **Integritas Waktu**: Seluruh indeks bertipe ISO-8601 UTC terurut monoton naik (`dt_series.is_monotonic_increasing == True`), tanpa duplikasi (`duplicated().any() == False`).
- **Penanganan Celah & Libur Bursa**: Hari libur bursa diharmonisasi menggunakan kalender hari kerja (`freq='B'`) dengan *forward-fill* (`ffill()`) bersih.
- **Nilai Kosong (NaN)**: 0 nilai kosong di seluruh 4.394 baris fitur setelah pemotongan pre-buffer 30 hari.
- **Audit Lag Maksimum**: Uji numerik membuktikan $\max(|\text{Close}_{\text{lagged}}[1:] - \text{Close}_{\text{raw}}[:-1]|) < 10^{-4}$ (tervalidasi persis).

---

## 4. Langkah Selanjutnya (Fase 2 Roadmap)
- Agregasi artikel berita mentah ke dalam bucket 4-jam (4H) dan jendela event kalender ekonomi (±2H) untuk mengurangi redundansi sindikasi teks berita.
