# PRD: Sistem Informasi Pasar Emas Otomatis dan Analisis Dampak Rilis Data Ekonomi

Penulis: Bagus Alfiyan Yusuf, Data Analyst Magang, PT Valbury Asia Futures Versi: 0.1 (draf) Status: Draf untuk ditinjau Tanggal: \[isi tanggal\] Peninjau/sponsor: \[nama pembimbing lapangan\]

## 1. Ringkasan Produk

Sistem yang secara otomatis mengumpulkan data pasar emas (harga XAUUSD, kalender ekonomi, data makro, dan laporan COT), menganalisis dampak rilis data ekonomi terhadap harga emas, lalu menyajikannya dalam dashboard dan ringkasan harian. Sistem bersifat informasi dan analisis, bukan sinyal atau rekomendasi transaksi.

## 2. Latar Belakang dan Masalah

Informasi pasar emas yang dipakai untuk konten edukasi, market outlook, dan komunikasi kepada nasabah umumnya disusun secara manual dan belum didukung bukti historis yang terdokumentasi. Akibatnya:

- Penyusunan ringkasan pasar memakan waktu dan sulit dilakukan konsisten setiap hari.
- Pernyataan seperti emas biasanya turun setelah NFP kuat belum diukur secara sistematis.
- Belum ada aset data pasar emas yang terstruktur dan dapat dipakai ulang.

## 3. Tujuan dan Non-Tujuan

**Tujuan:**

1. Mengotomatiskan pengumpulan dan penyimpanan data pasar emas.
2. Menghasilkan studi historis dampak NFP, CPI, dan FOMC terhadap XAUUSD.
3. Menyediakan dashboard dan ringkasan harian otomatis yang siap dipakai.
4. Menyediakan dokumentasi agar sistem dapat dilanjutkan pihak lain.

**Non-tujuan (di luar cakupan versi ini):**

- Memberikan sinyal beli/jual atau rekomendasi investasi.
- Memprediksi harga secara otomatis sebagai produk utama.
- Mengakses atau memproses data pribadi maupun data transaksi nasabah.
- Mengeksekusi transaksi otomatis (bukan Expert Advisor).
- Mencakup instrumen selain XAUUSD.

## 4. Pengguna dan Kebutuhan

| Pengguna | Kebutuhan utama |
| --- | --- |
| Tim edukasi / analis pasar | Ringkasan harian dan temuan historis sebagai bahan konten dan market outlook |
| Pembimbing / atasan | Bukti bahwa sistem berjalan dan memberi manfaat terukur |
| Nasabah (tidak langsung, melalui konten tim) | Informasi pasar yang jelas dan berbasis data |
| Pengembang penerus | Kode dan dokumentasi yang mudah dilanjutkan |

## 5. User Stories

1. Sebagai analis, saya ingin melihat kalender rilis data ekonomi yang akan datang beserta riwayat reaksi emas pada rilis sejenis, agar dapat menyiapkan outlook.
2. Sebagai tim edukasi, saya ingin ringkasan harian otomatis, agar tidak menyusun dari nol setiap hari.
3. Sebagai analis, saya ingin melihat statistik reaksi emas per jenis event dan arah kejutan, agar klaim dalam konten didukung data.
4. Sebagai pembimbing, saya ingin melihat status pengumpulan data dan hasil analisis, agar dapat menilai kemajuan proyek.
5. Sebagai pengembang penerus, saya ingin dokumentasi dan skrip yang jelas, agar sistem dapat dirawat setelah magang selesai.

## 6. Kebutuhan Fungsional

Prioritas: Must (wajib), Should (sebaiknya), Could (opsional).

| ID | Kebutuhan | Prioritas |
| --- | --- | --- |
| FR-01 | Sistem mengambil data harga XAUUSD (OHLC, beberapa timeframe) dari MetaTrader 5 secara terjadwal dan menyimpannya | Must |
| FR-02 | Sistem mengambil kalender ekonomi (jadwal, nilai aktual, perkiraan, rilis sebelumnya) dari sumber yang sah | Must |
| FR-03 | Sistem menghitung tingkat kejutan (surprise) tiap rilis; bila perkiraan tidak ada, memakai selisih terhadap rilis sebelumnya | Must |
| FR-04 | Sistem menghitung reaksi harga pada jendela 5, 15, dan 60 menit setelah rilis (perubahan, arah, rentang, waktu retrace) | Must |
| FR-05 | Sistem menghasilkan statistik per jenis event (rata-rata, median, persentase arah sama, dampak menurut arah kejutan) | Must |
| FR-06 | Dashboard menampilkan harga terbaru dan kalender rilis mendatang | Must |
| FR-07 | Halaman dampak berita menampilkan hasil event study per jenis event | Must |
| FR-08 | Sistem menyusun ringkasan harian otomatis (pergerakan harga, event hari itu, catatan posisi COT) | Must |
| FR-09 | Sistem mencatat setiap proses pengumpulan data (sumber, waktu, status, jumlah baris) | Must |
| FR-10 | Setiap keluaran memuat pernyataan bahwa isinya bersifat informasi, bukan ajakan transaksi | Must |
| FR-11 | Sistem mengambil laporan COT mingguan dari CFTC dan menampilkan ringkasan posisi | Should |
| FR-12 | Pengguna dapat mengekspor laporan atau ringkasan (CSV/teks/PDF) | Should |
| FR-13 | Sistem menghitung skor sentimen berita emas dan mengaitkannya dengan rilis tertentu | Could |

## 7. Kebutuhan Non-Fungsional

- **Keandalan:** proses pengumpulan data berjalan terjadwal dan dapat dilanjutkan otomatis setelah gagal; kegagalan tercatat di log.
- **Konsistensi waktu:** seluruh data waktu disimpan dalam satu zona waktu baku (UTC) dan dikonversi hanya saat ditampilkan, agar perhitungan reaksi harga akurat.
- **Kualitas data:** validasi duplikat, nilai kosong, dan anomali sebelum dipakai analisis.
- **Performa:** halaman dashboard termuat dalam waktu wajar (target di bawah 3 detik untuk tampilan harian).
- **Keamanan:** kunci API disimpan di berkas konfigurasi lingkungan (.env) dan tidak masuk ke repositori; sistem tidak menyimpan data pribadi nasabah.
- **Kepatuhan:** sumber data dipakai sesuai ketentuan penggunaannya; keluaran tidak berisi rekomendasi investasi.
- **Keterulangan:** analisis dapat dijalankan ulang dari data mentah dengan hasil yang sama.
- **Keterawatan:** kode terstruktur, berdokumentasi, dan dapat dijalankan oleh pihak lain dengan panduan.

## 8. Sumber Data dan Integrasi

| Data | Sumber | Catatan |
| --- | --- | --- |
| Harga XAUUSD | MetaTrader 5 (pustaka Python), Yahoo Finance, atau Alpha Vantage | Cek panjang histori intraday dari broker |
| Kalender ekonomi | Sumber yang sah dan tersedia | Diverifikasi di fase awal; data perkiraan historis adalah risiko utama |
| Data makro | FRED, BLS, Bank Indonesia | Latar fundamental |
| COT | CFTC (berkas publik mingguan) | Dirilis mingguan |
| Berita (opsional) | RSS atau API berita | Fase lanjutan |

## 9. Model Data

Rancangan database mengikuti ERD terlampir dengan delapan entitas: EVENT\_TYPES, EVENT\_RELEASES, EVENT\_REACTIONS, PRICE\_CANDLES, COT\_REPORTS, NEWS\_ARTICLES, DAILY\_SUMMARIES, dan COLLECTION\_LOGS. Relasi utama: satu jenis event memiliki banyak rilis, dan satu rilis memiliki banyak ukuran reaksi harga (per jendela waktu).

## 10. Arsitektur dan Teknologi

| Lapisan | Pilihan |
| --- | --- |
| Pengumpulan data | Python dengan penjadwal (cron atau Task Scheduler) |
| Penyimpanan | SQLite (dapat ditingkatkan ke PostgreSQL) |
| Analisis | Python (pandas, statistik dasar) |
| Penyajian | Streamlit atau Power BI |
| Konfigurasi | Berkas .env dan repositori Git |

Pilihan teknologi dibuat ringan agar dapat diselesaikan dan dirawat oleh satu orang dalam masa magang.

## 11. Metrik Keberhasilan

Target bersifat usulan dan perlu disepakati dengan pembimbing.

| Metrik | Target usulan |
| --- | --- |
| Keberhasilan pengumpulan data pada hari kerja | Minimal 95% |
| Jenis event yang tercakup dalam studi | Minimal 3 (NFP, CPI, FOMC) |
| Waktu menyusun ringkasan harian | Dari manual menjadi di bawah 5 menit |
| Konsistensi terbit ringkasan selama masa uji | Setiap hari kerja |
| Penilaian kegunaan oleh pengguna internal | Minimal 4 dari 5 |

## 12. Rencana Rilis

| Rilis | Isi | Perkiraan waktu |
| --- | --- | --- |
| R1 | Fondasi data: FR-01, FR-02, FR-09 | \[Minggu 1-2\] |
| R2 | Studi dampak berita: FR-03, FR-04, FR-05, FR-07 | \[Minggu 2-4\] |
| R3 | Dashboard dan ringkasan harian: FR-06, FR-08, FR-10 | \[Minggu 4-7\] |
| R4 | Lanjutan: FR-11, FR-12, FR-13 | \[Minggu 7-8\] |
| Penutup | Dokumentasi, presentasi, serah terima | \[Minggu terakhir\] |

## 13. Asumsi, Ketergantungan, dan Risiko

**Asumsi:**

- Akses ke MetaTrader 5 untuk data harga tersedia selama magang.
- Ada pembimbing yang bersedia meninjau dan menjadi pengguna awal.

**Ketergantungan:**

- Ketersediaan sumber kalender ekonomi yang sah.
- Persetujuan pembimbing untuk menjalankan proyek dan membagikan keluaran.

**Risiko:**

| Risiko | Dampak | Mitigasi |
| --- | --- | --- |
| Data perkiraan historis sulit diperoleh | Ukuran surprise kurang tepat | Pakai selisih terhadap rilis sebelumnya dan nyatakan keterbatasannya |
| Jumlah event terbatas | Kesimpulan statistik lemah | Gunakan statistik deskriptif dan hindari klaim berlebihan |
| Histori intraday dari broker pendek | Studi tidak mencakup periode panjang | Gunakan sumber data pelengkap |
| Keluaran dipahami sebagai rekomendasi | Risiko kepatuhan | Pernyataan informasi pada setiap keluaran (FR-10) |
| Waktu magang habis sebelum selesai | Luaran tidak lengkap | Prioritas Must lebih dulu; R4 opsional |

## 14. Pertanyaan Terbuka

1. Siapa yang menjadi sponsor dan pengguna awal sistem ini?
2. Sumber kalender ekonomi mana yang sah dan tersedia untuk dipakai?
3. Seberapa panjang histori harga intraday yang bisa diambil dari MT5 broker?
4. Apakah hasil analisis boleh dibagikan ke nasabah, atau hanya untuk internal?
5. Di mana sistem akan dijalankan agar tetap hidup setelah magang selesai?
