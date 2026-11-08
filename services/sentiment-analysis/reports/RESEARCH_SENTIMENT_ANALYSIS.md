# Laporan Riset Ilmiah: Analisis Sentimen Berita Pasar Keuangan, Transmisi Makroekonomi, dan Prediktabilitas Harga Emas (XAUUSD)

**Disusun untuk:** Pengembangan Modul Riset Kuantitatif & Sistem Analisis Sentimen Terintegrasi (`services/sentiment-analysis`)  
**Fokus Instrumen:** XAUUSD (Gold Spot / US Dollar), Makroekonomi Global, & Algoritma Alpha Kuantitatif  
**Status Dokumen:** Laporan Akademis & Standar Industri Kuantitatif (Production Reference)  
**Klasifikasi:** Kuantitatif, Ekonometrika Finansial, Natural Language Processing (NLP)  

---

## Daftar Isi
1. [Ringkasan Eksekutif & Landasan Teoretis](#1-ringkasan-eksekutif--landasan-teoretis)
2. [Taksonomi & Komparasi Metode Ekstraksi Sentimen Teks Finansial](#2-taksonomi--komparasi-metode-ekstraksi-sentimen-teks-finansial)
   - 2.1 Loughran-McDonald (LM) Financial Dictionary
   - 2.2 FinBERT & Domain-Adapted Transformers
   - 2.3 Large Language Models (LLM): Zero-Shot, Few-Shot, & Chain-of-Thought (CoT)
   - 2.4 Matriks Evaluasi Komparatif Antar-Metode
3. [Dinamika Makroekonomi & Mekanisme Transmisi Pasar Emas (XAUUSD)](#3-dinamika-makroekonomi--mekanisme-transmisi-pasar-emas-xauusd)
   - 3.1 The Asset Inversion Effect (Paradoks Sentimen Berita Emas)
   - 3.2 Saluran Transmisi Yield Riil (TIPS) & Indeks Dolar AS (DXY)
   - 3.3 Pemodelan Interaksi Fitur (Topic-Conditional Sentiment Interaction)
   - 3.4 Spesifikasi Model Regresi Multivariat dengan Kontrol Makro
4. [Resolusi Temporal, Horison Investasi, & Struktur Mikro Pasar](#4-resolusi-temporal-horison-investasi--struktur-mikro-pasar)
   - 4.1 Horison Waktu Prediksi: Intraday 1H, 4H, vs 24H (Daily)
   - 4.2 Mikrostruktur Noise vs Fundamental Drift & Exponential Information Decay
   - 4.3 Dinamika Aliran Likuiditas Sesi Perdagangan Global
5. [Metodologi Ekonometrika & Analisis Kausalitas Prediktif](#5-metodologi-ekonometrika--analisis-kausalitas-prediktif)
   - 5.1 Rank Information Coefficient (Spearman Rank IC) & Temporal ICIR
   - 5.2 Event Study Methodology (Abnormal Returns, CAR, & CAAR)
   - 5.3 Vector Autoregression (VAR) & Pengujian Kausalitas Granger
   - 5.4 Impulse Response Function (IRF) & Variance Decomposition (FEVD)
6. [Integritas Data, Point-in-Time Timestamping, & Mitigasi Bias Kuantitatif](#6-integritas-data-point-in-time-timestamping--mitigasi-bias-kuantitatif)
   - 6.1 Anatomi Look-Ahead Bias pada NLP Finansial
   - 6.2 Protokol Point-in-Time (PIT) & Dual-Timestamp Architecture
   - 6.3 Pengelolaan Revisi Berita & Snapshot Immutability
   - 6.4 Embargo Period (24H Isolation Window) & Purged Walk-Forward Split
   - 6.5 Temporal Contamination pada Pretrained Foundation Models
7. [Metrik Evaluasi Standar Quantitative Finance](#7-metrik-evaluasi-standar-quantitative-finance)
   - 7.1 Formulasi & Kriteria Evaluasi Rank IC / ICIR
   - 7.2 Top-Bottom Quantile Spread ($Q_5 - Q_1$) & Uji Monotonisitas
   - 7.3 Hit Ratio & Uji Statistik Non-Parametrik Pesaran-Timmermann
   - 7.4 Metrik Risiko Portofolio: Sharpe Ratio, Drawdown, & Transaction Drag
8. [Rekomendasi Arsitektural untuk Sistem Informasi Market XAUUSD](#8-rekomendasi-arsitektural-untuk-sistem-informasi-market-xauusd)
   - 8.1 Evaluasi & Gap Analysis Pipeline Eksisting
   - 8.2 Desain Arsitektur Hybrid Ingestion & Feature Engineering
   - 8.3 Desain Target Label Multi-Horizon & Continuous Scoring
   - 8.4 Blueprint Implementasi Tahap Lanjutan
9. [Bibliografi & Referensi Ilmiah Terindeks](#9-bibliografi--referensi-ilmiah-terindeks)

---

## 1. Ringkasan Eksekutif & Landasan Teoretis

Dalam disiplin keuangan kuantitatif (*quantitative finance*), integrasi data teks tidak terstruktur (*unstructured textual data*) ke dalam model penetapan harga aset telah bertransformasi dari sekadar eksperimen heuristik menjadi salah satu sumber *alpha* informasi utama. Sebagaimana dirumuskan dalam *Efficient Market Hypothesis* (Fama, 1970) dan dikembangkan dalam *Behavioral Finance* (Barberis et al., 1998; Daniel et al., 1998), harga pasar tidak selalu seketika mencerminkan seluruh nilai intrinsik informasi akibat adanya friksi kognitif, keterbatasan kapasitas pemrosesan informasi pelaku pasar (*bounded rationality*), dan *limits to arbitrage* (Shleifer & Vishny, 1997).

Pada pasar komoditas moneter global, khususnya **emas spot terhadap Dolar AS (XAUUSD)**, analisis sentimen teks menghadapi kompleksitas struktural ganda:
1. **Sifat Aset Multifaset:** Emas bukan saham korporasi dengan arus kas terdiskon (*discounted cash flows*), melainkan aset moneter tanpa imbal hasil kupon (*zero-yield monetary asset*), lindung nilai inflasi (*inflation hedge*), serta instrumen perlindungan risiko krisis (*safe-haven asset*).
2. **Efek Pembalikan Valuasi (*The Asset Inversion Effect*):** Berita makroekonomi positif mengenai perekonomian Amerika Serikat (misalnya lonjakan *Non-Farm Payrolls* atau pertumbuhan PDB yang solid) merupakan sinyal *bullish* bagi ekonomi riil dan indeks Dolar AS (DXY), tetapi secara sistematis bersifat **bearish kuat bagi harga emas**, karena memicu ekspektasi kenaikan suku bunga acuan Federal Reserve dan mendongkrak *real yields* obligasi pemerintah AS.

Laporan riset ini menyajikan telaah mendalam berbasis literatur akademis peer-reviewed (dari jurnal *Journal of Finance*, *Journal of Banking & Finance*, *Journal of Financial Economics*, serta publikasi mutakhir arXiv/SSRN) dan praktik industri quant trading kelas institusional. Laporan ini mengevaluasi metodologi ekstraksi sentimen teks, formulasi ekonometrika prediktif, resolusi waktu intraday, mekanisme transmisi variabel makroekonomi, protokol integritas *point-in-time* bebas *look-ahead bias*, serta metrik evaluasi kuantitatif standar industri.

---

## 2. Taksonomi & Komparasi Metode Ekstraksi Sentimen Teks Finansial

Ekstraksi sentimen teks dalam domain keuangan telah berevolusi melalui tiga paradigma utama: pendekatan leksikon berbasis aturan (*rule-based domain lexicons*), representasi representasional berbasis Transformer domain-spesifik (*encoder-based models*), dan model bahasa skala besar (*decoder-based generative LLMs*).

```
[Evolusi NLP Finansial]
Harvard General Inquirer (1966) -> Gagal tangkap konteks bisnis (~74% false negative)
            │
            ▼
Loughran-McDonald (2011)        -> Diksionari finansial akuntansi berbasis BoW / TF-IDF
            │
            ▼
FinBERT (Araci 2019, Yang 2020) -> Contextual dense embeddings (Self-Attention, 110M params)
            │
            ▼
Generative LLMs (2023 - 2026)   -> Few-shot, In-context Reasoning, Macro Causal Understanding
```

### 2.1 Loughran-McDonald (LM) Financial Dictionary

Studi seminal Loughran & McDonald (2011) dalam *Journal of Finance* membuktikan bahwa leksikon umum seperti *Harvard IV-4 Dictionary* menghasilkan misklasifikasi sistematis pada teks keuangan korporasi. Sekitar 73.8% kata yang dikategorikan "negatif" oleh Harvard Dictionary pada dokumen laporan tahunan (Form 10-K) merupakan kosakata standar akuntansi yang netral, seperti *"liability"*, *"cost"*, *"tax"*, *"board"*, *"depreciation"*, *"capital"*, dan *"crude"*.

Loughran & McDonald menyusun leksikon khusus keuangan yang terdiri atas 6 kategori sentimen utama:
- **Negative (2,355 kata):** Mengindikasikan kerugian, kegagalan, restrukturisasi, litigasi.
- **Positive (354 kata):** Mengindikasikan efisiensi, keuntungan, pertumbuhan, keunggulan kompetitif.
- **Uncertainty (297 kata):** Mengindikasikan ambiguitas, risiko, fluktuasi, probabilitas.
- **Litigious (905 kata):** Mengindikasikan gugatan hukum, arbitrase perdata/pidana.
- **Constraining (184 kata):** Mengindikasikan pembatasan kredit, perjanjian restriktif (*covenants*).
- **Interesting (189 kata):** Mengindikasikan perhatian khusus manajemen.

#### Formulasi Pembobotan Term Weighting (LM TF-IDF)
Loughran dan McDonald merumuskan varian TF-IDF terkalibrasi untuk mencegah dominasi frekuensi kata dokumen panjang:

$$w_{i,j} = \begin{cases} \frac{1 + \log(\text{tf}_{i,j})}{1 + \log(a_j)} \times \log\left(\frac{N}{\text{df}_i}\right) & \text{jika } \text{tf}_{i,j} > 0 \\ 0 & \text{lainnya} \end{cases}$$

Di mana:
- $\text{tf}_{i,j}$ adalah frekuensi kemunculan kata $i$ dalam dokumen $j$.
- $a_j$ adalah jumlah total kata dalam dokumen $j$.
- $N$ adalah jumlah seluruh dokumen dalam korpus.
- $\text{df}_i$ adalah jumlah dokumen yang memuat sekurang-kurangnya satu kemunculan kata $i$.

Skor sentimen polaritas bersih (*net polarity score*) dihitung sebagai rasio ternormalisasi:

$$\text{Score}_{\text{LM}, j} = \frac{\sum_{i \in \text{Pos}} w_{i,j} - \sum_{i \in \text{Neg}} w_{i,j}}{\sum_{i \in \text{Pos}} w_{i,j} + \sum_{i \in \text{Neg}} w_{i,j} + \epsilon}$$

Di mana $\epsilon = 10^{-6}$ ditambahkan guna mencegah pembagian dengan nol pada teks tanpa kata berpolaritas.

#### Kekuatan & Limitasi
- **Kekuatan:** Deterministik 100%, kompleksitas komputasi linear $\mathcal{O}(L)$ terhadap panjang token $L$, latensi inferensi mikrosekon, nol risiko halusinasi, dan tidak memerlukan perangkat keras akselerator (GPU).
- **Limitasi:** Pendekatan *Bag-of-Words* (BoW) mengabaikan struktur sintaksis kalimat, negasi ganda (*"not unprofitable"* dianggap berbobot negatif ganda), dependensi jarak jauh (*long-range dependencies*), dan sama sekali buta terhadap konteks tematik ekonomi (misalnya lonjakan inflasi yang berkonotasi berbeda bagi obligasi vs emas).

---

### 2.2 FinBERT & Domain-Adapted Transformers

FinBERT (Araci, 2019; Yang, Christopher Siy Uy, & Huang, 2020) mengadaptasi arsitektur *Bidirectional Encoder Representations from Transformers* (BERT, Devlin et al., 2019) ke dalam domain finansial melalui *continual pretraining* pada korpus raksasa komunikasi korporasi (10-K, 10-Q, transkrip *earnings calls*, serta feed berita Reuters/Bloomberg) diikuti *supervised fine-tuning* pada dataset teranotasi ahli (*Financial PhraseBank*, Malo et al., 2014; TRC2-financial).

#### Mekanisme Ekstraksi & Arsitektur
Arsitektur FinBERT berbasis BERT-Base (12 layer encoder, 768 dimensi tersembunyi, 12 attention heads, 110 juta parameter). Representasi kontekstual token diperoleh melalui operasi *Scaled Dot-Product Attention*:

$$\text{Attention}(\mathbf{Q}, \mathbf{K}, \mathbf{V}) = \text{softmax}\left(\frac{\mathbf{Q}\mathbf{K}^T}{\sqrt{d_k}}\right)\mathbf{V}$$

Vektor representasi dokumen agregat diekstraksi dari token khusus baris pertama $[\text{CLS}]$ pada layer ke-12 ($\mathbf{h}_{[\text{CLS}]} \in \mathbb{R}^{768}$). Lapisan klasifikasi linier memetakan representasi tersebut ke dalam distribusi probabilitas logit tiga dimensi:

$$\mathbf{p} = \text{softmax}(\mathbf{W}_c \mathbf{h}_{[\text{CLS}]} + \mathbf{b}_c) = \begin{bmatrix} p_{\text{negative}} \\ p_{\text{neutral}} \\ p_{\text{positive}} \end{bmatrix}$$

Skor sentimen kontinu terkalibrasi (*continuous polarity index*) didefinisikan sebagai:

$$S_{\text{FinBERT}} = p_{\text{positive}} - p_{\text{negative}} \in [-1.0, +1.0]$$

Atau menggunakan rasio log-odds kepercayaan:

$$\Lambda_{\text{FinBERT}} = \log\left(\frac{p_{\text{positive}} + \epsilon}{p_{\text{negative}} + \epsilon}\right)$$

#### Kekuatan & Limitasi
- **Kekuatan:** Menangkap nuansa linguistik kontekstual, negasi kompleks (*"sales were not bad"* diklasifikasikan positif), dan idiom finansial. Akurasi F1-macro pada korpus finansial mencapai $0.86 - 0.92$, jauh melampaui kamus leksikal LM ($0.60 - 0.68$). Kecepatan inferensi GPU modern (~10–30 ms per batch) sangat memadai untuk trading kuantitatif intraday.
- **Limitasi:** Keterbatasan panjang sekuens maksimum 512 token subword (*WordPiece*). Kurang mampu melakukan penalaran kausal makroekonomi tingkat tinggi (*macroeconomic causal deduction*) tanpa rekayasa fitur tambahan.

---

### 2.3 Large Language Models (LLM): Zero-Shot, Few-Shot, & Chain-of-Thought (CoT)

Studi empiris Lopez-Lira & Tang (2023, diperbarui 2025) berjudul *"Can ChatGPT Forecast Stock Price Movements? Return Predictability and Large Language Models"* mendemonstrasikan bahwa model bahasa generatif tingkat lanjut (GPT-3.5, GPT-4, LLaMA-3, Mistral) menunjukkan kemampuan *emergent* dalam memprediksi return harga aset masa depan dari analisis judul berita (*news headlines*).

Studi Lopez-Lira & Tang menunjukkan bahwa korelasi antara skor sentimen ChatGPT dan return saham harian berikutnya bernilai positif signifikan secara statistik ($t\text{-stat} > 3.5$), menghasilkan *long-short hedge portfolio Sharpe ratio* yang jauh melampaui metode sentimen tradisional leksikon maupun BERT dasar.

#### Mekanisme Prompting Zero-Shot & Few-Shot
Dalam konteks instrumen komoditas makro seperti XAUUSD, prompt rekayasa instruksi harus mengintegrasikan peran hierarki transmisi fundamental:

```json
{
  "system_prompt": "Anda adalah model quant macro analyst spesialis XAUUSD. Tugas Anda adalah mengevaluasi dampak rilis berita atau indikator ekonomi terhadap harga emas (XAUUSD) pada horizon 1-4 jam ke depan.",
  "few_shot_examples": [
    {
      "headline": "US Non-Farm Payrolls increased by 275K in February, beating estimates of 200K; Unemployment Rate ticks up to 3.9%.",
      "reasoning": "Data ketenagakerjaan AS melampaui konsensus, menandakan ekonomi riil kuat. Meskipun tingkat pengangguran naik tipis, imbal hasil obligasi 10Y AS dan DXY cenderung menguat dalam jangka pendek, menekan harga emas ke bawah.",
      "directional_impact_xauusd": -0.65,
      "confidence": 0.85,
      "primary_driver": "real_yield_and_usd_strength"
    },
    {
      "headline": "Geopolitical tensions escalate in the Middle East following missile strikes on commercial shipping corridors.",
      "reasoning": "Peningkatan eskalasi konflik militer memicu pelarian likuiditas menuju aset safe-haven secara instan, mendongkrak premi risiko global dan memicu lonjakan beli pada emas fisik dan kontrak berjangka COMEX.",
      "directional_impact_xauusd": 0.80,
      "confidence": 0.90,
      "primary_driver": "safe_haven_flight"
    }
  ]
}
```

#### Formulasi Chain-of-Thought (CoT) Formal
Penalaran terstruktur model bahasa dimodelkan sebagai dekomposisi probabilitas bersama dari langkah-langkah inferensi kausal laten $\mathbf{z} = (z_1, z_2, \dots, z_m)$ sebelum menghasilkan prediksi akhir $y \in [-1, 1]$:

$$P(y \mid \mathbf{x}) = \sum_{\mathbf{z}} P(y \mid \mathbf{z}, \mathbf{x}) \prod_{k=1}^m P(z_k \mid z_{<k}, \mathbf{x})$$

Di mana $z_1$ mengidentifikasi variabel makro (misal: suku bunga), $z_2$ mengevaluasi arah kejutan terhadap ekspektasi konsensus ($\Delta = \text{Actual} - \text{Forecast}$), $z_3$ mengkalkulasi transmisi ke DXY dan Yield 10Y, dan $y$ adalah estimasi dampak ekuilibrium terhadap XAUUSD.

---

### 2.4 Matriks Evaluasi Komparatif Antar-Metode

Tabel berikut menyajikan perbandingan komprehensif antara ketiga paradigma metode berdasarkan kriteria rekayasa kuantitatif:

| Parameter Evaluasi | Loughran-McDonald (LM) | FinBERT (Encoder) | LLM Zero/Few-Shot (Decoder) |
| :--- | :--- | :--- | :--- |
| **Arsitektur Dasar** | Bag-of-Words & TF-IDF Leksikon | 12-Layer Bidirectional Transformer | Autoregressive Transformer (Dense/MoE) |
| **Jumlah Parameter** | $0$ (Rule-based Dictionary) | $1.1 \times 10^8$ (110M) | $8 \times 10^9 - 7 \times 10^{11}$ (8B - 700B) |
| **Akurasi Domain (F1-Macro)** | $0.58 - 0.65$ | $0.84 - 0.91$ | **$0.88 - 0.95$** |
| **Latensi Inferensi (per teks)** | **$< 0.5 \text{ ms}$ (CPU)** | $15 - 40 \text{ ms}$ (GPU) | $500 - 2500 \text{ ms}$ (GPU / API) |
| **Biaya Komputasi / 1M Token** | Mendekati $\$0.00$ | $\$0.02 - \$0.05$ (Self-hosted GPU) | $\$1.00 - \$15.00$ (API Cloud) |
| **Kapasitas Konteks Maksimal** | Tak terbatas (BoW agregat) | 512 subword tokens | 8,192 – 128,000 tokens |
| **Resolusi Negasi & Sintaks** | Sangat Buruk (Gagal) | Sangat Baik (Attention Matrix) | Superior (Multi-step Reasoning) |
| **Macro Causal Reasoning** | Tidak Ada (Nol) | Rendah (Hanya asosiasi tekstual) | **Sangat Tinggi (Causal Flow Modeling)** |
| **Risiko Temporal Contamination** | **$0\%$ (Bebas kebocoran)** | Rendah (Frozen Pretraining Cutoff) | **Tinggi (Corpus web pasca-peristiwa)** |
| **Kelayakan Produksi 1H/4H** | Sangat Mudah | Sangat Optimal (Throughput Tinggi) | Selektif (Batch headline utama) |

---

## 3. Dinamika Makroekonomi & Mekanisme Transmisi Pasar Emas (XAUUSD)

### 3.1 The Asset Inversion Effect (Paradoks Sentimen Berita Emas)

Salah satu sumber kesalahan paling fatal dalam pemodelan sentimen pasar keuangan adalah asumsi keseragaman arah sentimen (*universal polarity assumption*): mengasumsikan bahwa berita bernada positif selalu berkorelasi positif dengan seluruh aset keuangan.

Pada pasar emas (XAUUSD), berlaku fenomena struktural yang dikenal sebagai **The Asset Inversion Effect** (Elder, Miao, & Ramchander, 2012; Smales, 2014, 2015).

```
[Rilis Data Ekonomi AS: Pertumbuhan PDB Tinggi / NFP Menguat]
                         │
                         ▼
        Sentimen Berita Umum: POSITIF / BULLISH
                         │
        ┌────────────────┴────────────────┐
        ▼                                 ▼
Ekspektasi Hawkish Fed            Kenaikan Nilai Tukar
(Suku Bunga Tetap Tinggi)        Dolar AS (Indeks DXY)
        │                                 │
        ▼                                 ▼
Kenaikan US 10Y Real Yield      Emas Lebih Mahal bagi
(Opportunity Cost Naik)         Pemegang Mata Uang Asing
        │                                 │
        └────────────────┬────────────────┘
                         ▼
            DAMPAK TERHADAP XAUUSD:
            BEARISH KUAT (HARGA TURUN)
```

#### Bukti Empiris Literatur Akademis
1. **Elder, Miao, & Ramchander (2012, *Journal of Banking & Finance*):**
   Menganalisis reaksi frekuensi tinggi (*tick-by-tick*) kontrak berjangka logam terhadap kejutan berita makroekonomi AS periode 2002–2008. Temuan empiris membuktikan bahwa pengumuman yang mencerminkan perbaikan kondisi ekonomi tak terduga (*unexpected macroeconomic improvement*, seperti kenaikan surplus neraca perdagangan, kejutan positif NFP, dan penguatan PMI manufaktur) **secara konsisten menekan harga emas dan perak ke bawah**, berkebalikan dengan tembaga yang merespons positif karena fungsi industri dasarnya.
2. **Smales (2014, *Journal of Banking & Finance*):**
   Mengevaluasi sentimen berita feed Thomson Reuters News Analytics (TRNA) pada emas berjangka COMEX. Ditemukan adanya respons asimetris kuat: sentimen negatif pasar ekuitas/ekonomi memicu respons kenaikan return emas kontemporer yang hampir dua kali lipat lebih besar daripada respons terhadap berita positif (*safe haven premium effect*).
3. **Smales (2015, *International Review of Financial Analysis*):**
   Menunjukkan bahwa harga emas menyerap kejutan indikator pengangguran dan inflasi CPI dalam kurun waktu 90 detik pasca-rilis, di mana *surprise component* indikator tenaga kerja memiliki koefisien regresi negatif terbesar terhadap return emas.

---

### 3.2 Saluran Transmisi Yield Riil (TIPS) & Indeks Dolar AS (DXY)

Harga emas dunia secara fundamental ditentukan oleh interaksi dua variabel makroekonomi utama: **US Real Interest Rates** dan **US Dollar Index (DXY)**.

#### 1. Saluran Imbal Hasil Riil (Fisher Identity & Opportunity Cost)
Berdasarkan identitas Fisher, imbal hasil nominal obligasi pemerintah AS tenor 10 tahun ($y_{10}^{\text{nom}}$) terdiri atas imbal hasil riil ($r_{10}^{\text{real}}$) dan ekspektasi inflasi impas (*10-Year Breakeven Inflation Rate*, $\pi_{10}^e$):

$$y_{10}^{\text{nom}} = r_{10}^{\text{real}} + \pi_{10}^e \implies r_{10}^{\text{real}} = y_{10}^{\text{nom}} - \pi_{10}^e$$

Karena emas adalah aset fisik moneter dengan arus dividen/kupon nol ($y_{\text{gold}} = 0$), biaya peluang (*opportunity cost*) riil dari memegang emas setara dengan imbal hasil riil obligasi bebas risiko (*US Treasury Inflation-Protected Securities* / TIPS):

$$\mathcal{C}_{\text{holding gold}} \approx r_{10}^{\text{real}}$$

Ketika sentimen berita makroekonomi memicu kenaikan ekspektasi imbal hasil riil AS ($\Delta r_{10}^{\text{real}} > 0$), daya tarik relatif emas menurun drastis, memicu arus keluar modal institusional (*institutional ETF outflows*) dari instrumen emas ke instrumen pasar uang berimbal hasil riil positif. Secara historis, korelasi bergulir 52-minggu antara XAUUSD dan US 10Y Real Yield berada di rentang $-0.65$ hingga $-0.85$.

#### 2. Saluran Denominasi Valuta (DXY Channel)
Karena emas secara global diperdagangkan dalam denominasi Dolar AS (XAU/USD), apresiasi nilai tukar Dolar ($\Delta \text{DXY} > 0$) secara mekanis meningkatkan harga emas dalam mata uang non-USD (seperti EUR, JPY, GBP, CNY), sehingga menekan volume permintaan fisik perhiasan dan investasi ritel di luar AS, yang kemudian merefleksikan penurunan harga ekuilibrium dalam satuan USD.

---

### 3.3 Pemodelan Interaksi Fitur (Topic-Conditional Sentiment Interaction)

Untuk mengatasi paradoks *Asset Inversion Effect*, model kuantitatif tidak boleh menggunakan skor sentimen mentah ($S_t$) secara univariat. Diperlukan formulasi **Topic-Conditional Interaction Feature**, di mana polaritas sentimen dimodulasi oleh variabel pengidentifikasi topik makroekonomi.

Misalkan setiap artikel berita $i$ dipetakan ke dalam probabilitas distribusi topik $\mathbf{\tau}_i = [\tau_{i,1}, \tau_{i,2}, \dots, \tau_{i,K}]$ menggunakan model ekstraksi topik (seperti *Latent Dirichlet Allocation*, *BERTopic*, atau *Zero-Shot NLI Classification*). Kategori topik didefinisikan sebagai:
1. $\tau_{\text{rates}}$: Suku Bunga Fed / Kebijakan Moneter / Pernyataan FOMC.
2. $\tau_{\text{labor}}$: Tenaga Kerja AS (Non-Farm Payrolls, Jobless Claims).
3. $\tau_{\text{inflation}}$: Inflasi AS (CPI, PPI, PCE Price Index).
4. $\tau_{\text{geopol}}$: Eskalasi Krisis Geopolitik / Peperangan / Sanksi Dagang.
5. $\tau_{\text{bank\_risk}}$: Krisis Perbankan / Likuiditas Finansial Sistemik.

#### Formulasi Interaksi Multiplikatif
Fitur sentimen efektif yang terkoreksi secara fundamental ($S_{i, \text{effective}}^{\text{XAUUSD}}$) dimodelkan sebagai:

$$S_{i, \text{effective}}^{\text{XAUUSD}} = S_i \times \sum_{k=1}^K \omega_k \tau_{i,k}$$

Di mana vektor bobot transmisi $\boldsymbol{\omega} = [\omega_1, \dots, \omega_K]^T$ mengontrol polaritas transmisi ke aset emas:
- $\omega_{\text{rates}} = -1.0$ (Sentimen ekonomi AS menguat $\implies$ Hawkish $\implies$ Emas Bearish).
- $\omega_{\text{labor}} = -1.0$ (Pasar tenaga kerja ketat $\implies$ Emas Bearish).
- $\omega_{\text{inflation}} = +0.5$ (Ekspektasi inflasi naik tanpa kenaikan suku bunga nominal $\implies$ Real yield turun $\implies$ Emas Bullish).
- $\omega_{\text{geopol}} = +1.0$ (Krisis meningkat $\implies$ Safe haven flow $\implies$ Emas Bullish).
- $\omega_{\text{bank\_risk}} = +1.0$ (Risiko sistemik kredit $\implies$ Safe haven flow $\implies$ Emas Bullish).

Dalam kerangka *machine learning* (seperti LightGBM atau CatBoost), interaksi ini dapat dipelajari secara non-parametrik dengan menyertakan fitur perkalian langsung:

$$x_{\text{interact}, i, k} = S_i \times \tau_{i, k}$$

---

### 3.4 Spesifikasi Model Regresi Multivariat dengan Kontrol Makro

Untuk mengisolasi kekuatan prediktif *alpha* murni dari sinyal sentimen berita terhadap return emas ke depan ($R_{\text{XAUUSD}, t \to t+h}$), model regresi deret waktu wajib mengontrol pergerakan simultan dari variabel pasar makroekonomi:

$$R_{\text{XAUUSD}, t \to t+h} = \alpha + \beta_1 S_{t}^{\text{eff}} + \beta_2 \Delta \ln(\text{DXY}_t) + \beta_3 \Delta r_{10, t}^{\text{real}} + \beta_4 \Delta y_{10, t}^{\text{nom}} + \beta_5 R_{\text{Oil}, t} + \sum_{p=1}^P \phi_p R_{\text{XAUUSD}, t-p} + \epsilon_{t+h}$$

Di mana:
- $R_{\text{XAUUSD}, t \to t+h} = \ln(P_{t+h} / P_t)$ adalah log-return harga emas pada horizon $h$.
- $S_t^{\text{eff}}$ adalah sinyal sentimen berita agregat pada jendela waktu $t$.
- $\Delta \ln(\text{DXY}_t)$ adalah perubahan logaritmik indeks Dolar AS.
- $\Delta r_{10, t}^{\text{real}}$ adalah perubahan imbal hasil riil obligasi proteksi inflasi 10 tahun (US 10Y TIPS).
- $\Delta y_{10, t}^{\text{nom}}$ adalah perubahan imbal hasil nominal US Treasury 10-Year.
- $R_{\text{Oil}, t}$ adalah return harga minyak mentah WTI (sebagai proksi shock komoditas global).
- $\epsilon_{t+h}$ adalah residual error terdistribusi identik dan independen.

Apabila koefisien $\beta_1$ terbukti signifikan secara statistik ($p\text{-value} < 0.01$ atau $t\text{-stat} > 2.58$) setelah mengontrol seluruh kovariat makro di atas, dapat dipastikan bahwa sinyal sentimen teks membawa *orthogonal predictive alpha* yang belum tercermin dalam harga pasar saat sinyal dibentuk.

---

## 4. Resolusi Temporal, Horison Investasi, & Struktur Mikro Pasar

### 4.1 Horison Waktu Prediksi: Intraday 1H, 4H, vs 24H (Daily)

Daya tahan prediktif informasi teks bervariasi secara dramatis bergantung pada resolusi waktu yang diamati. Riset empiris menunjukkan dikotomi nyata antara reaksi instan frekuensi tinggi dan tren fundamental frekuensi rendah:

```
[Spektrum Resolusi Waktu Sentimen]
Detik s.d. Menit (1M - 15M)  --> High-Frequency Algorithmic Execution & Order Book Imbalance
             │
             ▼
Intraday Pendek (1 Jam / 1H) --> Price Discovery Peak, Volatility Spike, Initial Overshooting
             │
             ▼
Intraday Menengah (4 Jam / 4H) -> Cross-Session Liquidity Handover (Tokyo -> London -> NY)
             │
             ▼
Harian / Daily (24 Jam / 24H) -> Macro Narrative Regime Shift & Equilibrium Repricing
```

1. **Horison Intraday 1-Jam (1H):**
   - Karakteristik: Reaksi awal pasar terhadap pengumuman berita tak terencana (*breaking news*) atau data kalender ekonomi.
   - Dinamika: Sinyal sentimen mengalami lonjakan volatilitas terwujud (*realized volatility*) tajam. Pelaku pasar frekuensi tinggi (*HFT*) dan algoritma kuantitatif mengeksekusi order flow agresif, sering kali memicu fenomena *overshooting* harga sesaat sebelum likuiditas mengabsorpsi order imbalance.
2. **Horison Intraday 4-Jam (4H):**
   - Karakteristik: Jendela transisi likuiditas antar-pusat keuangan global.
   - Dinamika: Menangkap fase koreksi teknikal atas *overshooting* 1 jam pertama. Pada horison ini, *smart money* dan pengelola dana institusional mengevaluasi implikasi lanjutan dari berita terhadap struktur tren intraday. Sinyal noise mulai tereliminasi dan kekuatan arah pergerakan riil terbentuk.
3. **Horison Harian 24-Jam (24H / Daily):**
   - Karakteristik: Horison rebalancing posisi portofolio multi-aset global.
   - Dinamika: Berita individual minor mengalami *noise aggregation cancellation* (berita bising saling meniadakan), menyisakan arus berita struktural (seperti pergeseran retorika bank sentral atau krisis geopolitik berlarut). Pada horison ini, korelasi sentimen dengan makroekonomi mencapai stabilitas tertinggi.

---

### 4.2 Mikrostruktur Noise vs Fundamental Drift & Exponential Information Decay

Kecepatan peluruhan informasi (*information decay rate*) dari berita teks mengikuti proses eksponensial. Alpha prediktif dari berita yang terbit pada waktu $t_0$ meluruh secara bertahap seiring berjalannya waktu $t$:

$$S_t^{\text{decayed}} = S_{t_0} \times \exp\left( -\lambda (t - t_0) \right) = S_{t_0} \times 2^{-\frac{t - t_0}{t_{1/2}}}$$

Di mana:
- $\lambda$ adalah parameter peluruhan informasi (*decay constant*).
- $t_{1/2} = \frac{\ln(2)}{\lambda}$ adalah waktu paruh informasi (*signal half-life*).

#### Estimasi Half-Life Berdasarkan Tipologi Berita
Berdasarkan sintesis literatur empiris (Groß-Klußmann & Hautsch, 2011; Smales, 2014; Baur & Lucey, 2010):

| Kategori Berita | Estimasi Waktu Paruh ($t_{1/2}$) | Karakteristik Dinamika Pasar |
| :--- | :--- | :--- |
| **Scheduled Macro Releases (NFP, CPI, Fed)** | **$5 - 15 \text{ menit}$** | Penyerapan instan, penyesuaian harga selesai dalam < 90 detik, residual drift selesai dalam 1 jam. |
| **Breaking Geopolitical Events (Perang, Serangan)** | **$4 - 12 \text{ jam}$** | Safe-haven premium bertahan selama ketidakpastian memuncak; eskalasi berita menghasilkan momentum berantai. |
| **Corporate/Commodity Supply News (Tambang, Bank Sentral)** | **$24 - 48 \text{ jam}$** | Penyesuaian bertahap oleh analis komoditas, efek inventori fisik COMEX/LBMA. |
| **General Market Commentary & Analyst Rumors** | **$< 30 \text{ menit}$** | Bising murni (*microstructure noise*), minim persistensi fundamental, rentan *mean-reversion*. |

Untuk mengagregasi aliran berita tidak beraturan (*asynchronous news arrivals*) ke dalam deret waktu beraturan (1H atau 4H), digunakan pembobotan *exponentially weighted moving average* (EWMA):

$$S_{\text{agg}, t} = \frac{\sum_{i=1}^{M_t} S_i \cdot \exp\left(-\lambda (t - t_i)\right)}{\sum_{i=1}^{M_t} \exp\left(-\lambda (t - t_i)\right)}$$

Di mana $M_t$ adalah jumlah artikel yang terbit dalam jendela retroaktif $[t - \Delta T, t]$.

---

### 4.3 Dinamika Aliran Likuiditas Sesi Perdagangan Global

Likuiditas pasar emas dunia terkonsentrasi secara non-stasioner sepanjang 24 jam rotasi perdagangan global:
1. **Sesi Asia (Tokyo/Singapura/Hong Kong, 00:00 - 08:00 UTC):**
   - Karakteristik: Likuiditas terendah di antara tiga sesi utama. Volume didominasi oleh importir fisik emas (Tiongkok, India) dan intervensi bank sentral regional.
   - Respons Sentimen: Reaksi terhadap berita makro AS lambat; spread bid-ask relatif lebih lebar; volatilitas rendah kecuali saat pengumuman kebijakan Bank of Japan (BoJ) atau PBoC.
2. **Sesi Eropa / London (08:00 - 16:00 UTC):**
   - Karakteristik: Pusat penetapan harga fisik dunia (*LBMA Gold Price Benchmark*). Likuiditas institusional melonjak tajam.
   - Respons Sentimen: Sangat efisien dalam menyerap data inflasi zona euro, geopolitik Eropa/Timur Tengah, dan positioning awal menjelang pembukaan pasar AS.
3. **Sesi Amerika Serikat / New York (13:00 - 21:00 UTC):**
   - Karakteristik: Volume transaksi tertinggi di dunia (perdagangan berjangka COMEX dan ETF GLD). Tumpang tindih (*overlap*) London-New York (13:00 - 16:00 UTC) merupakan periode paling likuid dan volatil.
   - Respons Sentimen: Seluruh rilis data ekonomi krusial AS (pukul 08:30 dan 10:00 EST / 13:30 dan 15:00 UTC) terjadi di sesi ini. Efisiensi penyerapan sentimen berada pada tingkat maksimum; koefisien Rank IC pada sesi ini menjadi penentu utama performa strategi quant.

---

## 5. Metodologi Ekonometrika & Analisis Kausalitas Prediktif

### 5.1 Rank Information Coefficient (Spearman Rank IC) & Temporal ICIR

Dalam manajemen portofolio kuantitatif (*Active Portfolio Management*, Grinold & Kahn, 2000), metrik utama untuk mengukur kemampuan peramalan (*forecasting skill*) suatu faktor *alpha* adalah **Information Coefficient (IC)**.

Karena return aset finansial memiliki ekor tebal (*fat tails / leptokurtic distribution*) dan rentan terhadap outlier ekstrem yang mendistorsi korelasi Pearson linier, standar industri quant finance mewajibkan penggunaan **Spearman Rank Information Coefficient (Rank IC)**.

#### Formulasi Matematis
Misalkan pada setiap interval waktu $t$, kita memiliki vektor skor sentimen prediksi $\mathbf{s}_t = [s_{1,t}, \dots, s_{N,t}]$ dan vektor return realisasi masa depan $\mathbf{r}_{t+h} = [r_{1,t+h}, \dots, r_{N,t+h}]$ untuk $N$ aset atau observasi. 

Peringkat (*rank*) didefinisikan sebagai pemetaan permutasi $R(\mathbf{s}_t)$ dan $R(\mathbf{r}_{t+h})$ ke dalam himpunan bilangan bulat $\{1, 2, \dots, N\}$. Rank IC pada periode $t$ dirumuskan sebagai:

$$\text{Rank IC}_t = 1 - \frac{6 \sum_{i=1}^N \left( R(s_{i,t}) - R(r_{i,t+h}) \right)^2}{N(N^2 - 1)}$$

Untuk deret waktu univariat tunggal seperti XAUUSD lintas waktu $t = 1, \dots, T$, Rank IC dihitung menggunakan jendela bergulir (*rolling window*) atau dihitung secara global lintas periode out-of-sample:

$$\text{Mean Rank IC} = \overline{\text{IC}} = \frac{1}{T} \sum_{t=1}^T \text{Rank IC}_t$$

#### Stabilitas Temporal: Information Ratio (ICIR)
Kekuatan prediktif murni suatu faktor harus konsisten lintas rezim pasar. Konsistensi ini diukur melalui **Information Ratio dari IC (ICIR)**:

$$\text{ICIR} = \frac{\overline{\text{IC}}}{\sigma_{\text{IC}}} = \frac{\frac{1}{T} \sum_{t=1}^T \text{Rank IC}_t}{\sqrt{\frac{1}{T-1} \sum_{t=1}^T \left( \text{Rank IC}_t - \overline{\text{IC}} \right)^2}}$$

Untuk membandingkan performa pada frekuensi sampling berbeda, ICIR di-tahunkankan (*annualized*):

$$\text{Annualized ICIR} = \text{ICIR} \times \sqrt{N_{\text{periods per year}}}$$

Berdasarkan *Fundamental Law of Active Management*:

$$\text{Information Ratio (IR)} \approx \text{IC} \times \sqrt{\text{Breadth}}$$

Di mana $\text{Breadth}$ adalah jumlah keputusan independen per tahun.

#### Benchmark Kuantitatif Industri:
- $\overline{\text{Rank IC}} < 0.02$: Faktor lemah (*noise-dominated*), tidak layak produksi.
- $\overline{\text{Rank IC}} \in [0.03, 0.05]$: Faktor moderat, dapat digunakan sebagai komponen multi-faktor.
- $\overline{\text{Rank IC}} > 0.05$: Faktor sangat kuat (*statistically strong alpha*).
- $\text{ICIR} > 0.50$: Stabilitas memadai.
- $\text{ICIR} > 1.00$: Stabilitas luar biasa (*world-class factor*).

---

### 5.2 Event Study Methodology (Abnormal Returns, CAR, & CAAR)

Metodologi *Event Study* (MacKinlay, 1997; Campbell, Lo, & MacKinlay, 1997) merupakan kerangka kerja ekonometrika standar untuk mengukur dampak rilis berita atau pengumuman makroekonomi terhadap harga aset secara terisolasi.

```
       Estimation Window                   Event Window           Post-Event Window
  [-------------------------]        [-----------------------]    [---------------]
  T_0                       T_1      tau_1         0         tau_2               T_3
                                               (News Event)
```

1. **Jendela Estimasi ($[T_0, T_1]$):** Periode waktu sebelum peristiwa (misal 120 jam sebelum berita) yang digunakan untuk menaksir parameter hubungan normal aset terhadap benchmark.
2. **Jendela Peristiwa ($[\tau_1, \tau_2]$):** Periode sempit di sekitar rilis berita (misal $[-15\text{ menit}, +60\text{ menit}]$ atau $[-1\text{H}, +4\text{H}]$).

#### Formulasi Abnormal Return (AR)
Return abnormal adalah deviasi return realisasi dari return normal yang diekspektasikan tanpa kehadiran peristiwa:

$$AR_{i,t} = R_{i,t} - \mathbb{E}[R_{i,t} \mid X_t]$$

Untuk pasar XAUUSD, ekspektasi return normal dapat dimodelkan menggunakan model makro benchmark:

$$\mathbb{E}[R_{\text{XAUUSD}, t} \mid X_t] = \hat{\alpha} + \hat{\beta}_1 \Delta \ln(\text{DXY}_t) + \hat{\beta}_2 \Delta r_{10, t}^{\text{real}}$$

#### Cumulative Abnormal Return (CAR) & CAAR
Akumulasi return abnormal sepanjang jendela peristiwa $[\tau_1, \tau_2]$ dirumuskan sebagai:

$$CAR_i(\tau_1, \tau_2) = \sum_{t=\tau_1}^{\tau_2} AR_{i,t}$$

Untuk sampel $N$ peristiwa pengumuman sejenis (misalnya rilis FOMC Rate Decision):

$$CAAR(\tau_1, \tau_2) = \frac{1}{N} \sum_{i=1}^N CAR_i(\tau_1, \tau_2)$$

Variansi dari $CAAR$ dihitung sebagai:

$$\text{Var}(CAAR(\tau_1, \tau_2)) = \frac{1}{N^2} \sum_{i=1}^N \sigma_i^2(\tau_1, \tau_2)$$

Uji signifikansi statistik diuji menggunakan uji-$t$ standar atau Boehmer-Musumeci-Poulsen (BMP) test:

$$t_{CAAR} = \frac{CAAR(\tau_1, \tau_2)}{\sqrt{\text{Var}(CAAR(\tau_1, \tau_2))}} \sim \mathcal{N}(0, 1)$$

Jika $t_{CAAR}$ signifikan secara statistik pasca-event ($t > \tau_0$), terdapat bukti kuat adanya *underreaction* atau penyerapan informasi bertahap yang dapat dieksploitasi oleh strategi kuantitatif.

---

### 5.3 Vector Autoregression (VAR) & Pengujian Kausalitas Granger

Untuk menguji apakah sentimen berita secara mendahului mengarahkan harga emas (*predictive causality*) ataukah fluktuasi harga emas yang memengaruhi nada berita media finansial (*reverse feedback loop*), diterapkan pemodelan sistem **Vector Autoregression (VAR)** dan **Granger Causality Test** (Granger, 1969).

#### Spesifikasi Sistem Bivariat VAR($P$)
Misalkan $\mathbf{Y}_t = [R_t, S_t]^T$, di mana $R_t$ adalah return XAUUSD pada interval $t$, dan $S_t$ adalah skor sentimen berita agregat. Sistem VAR dengan panjang lag $P$ dirumuskan sebagai:

$$\begin{bmatrix} R_t \\ S_t \end{bmatrix} = \begin{bmatrix} c_1 \\ c_2 \end{bmatrix} + \sum_{p=1}^P \begin{bmatrix} \alpha_{11}^{(p)} & \alpha_{12}^{(p)} \\ \alpha_{21}^{(p)} & \alpha_{22}^{(p)} \end{bmatrix} \begin{bmatrix} R_{t-p} \\ S_{t-p} \end{bmatrix} + \begin{bmatrix} u_{1t} \\ u_{2t} \end{bmatrix}$$

Di mana matriks kovariansi residual $\mathbf{u}_t \sim \text{WN}(\mathbf{0}, \boldsymbol{\Sigma})$.

Panjang lag optimal $P^*$ ditentukan berdasarkan kriteria informasi:
- *Akaike Information Criterion (AIC):* $\text{AIC}(P) = \ln|\boldsymbol{\Sigma}_P| + \frac{2 K^2 P}{T}$
- *Bayesian Information Criterion (BIC):* $\text{BIC}(P) = \ln|\boldsymbol{\Sigma}_P| + \frac{\ln(T) K^2 P}{T}$

#### Uji Hipotesis Granger Causality
Sentimen berita ($S_t$) dikatakan me-Granger-cause return emas ($R_t$) jika lag historis sentimen berkontribusi signifikan secara statistik dalam memprediksi return masa depan di atas lag return itu sendiri:

$$H_0: \alpha_{12}^{(1)} = \alpha_{12}^{(2)} = \dots = \alpha_{12}^{(P)} = 0 \quad (\text{Sentimen TIDAK me-Granger cause Return})$$

$$H_1: \exists p \in \{1, \dots, P\} \text{ sedemikian hingga } \alpha_{12}^{(p)} \ne 0$$

Uji Wald atau statistik-$F$ dirumuskan sebagai:

$$F = \frac{(\text{RSS}_{\text{restricted}} - \text{RSS}_{\text{unrestricted}}) / P}{\text{RSS}_{\text{unrestricted}} / (T - 2P - 1)} \sim F(P, T - 2P - 1)$$

Jika $F > F_{\text{critical}}$ ($p\text{-value} < 0.05$), hipotesis nol ditolak, mengonfirmasi validitas kausalitas prediktif dari sinyal sentimen terhadap pergerakan pasar.

---

### 5.4 Impulse Response Function (IRF) & Variance Decomposition (FEVD)

Untuk memahami jalur dinamika waktu shock sentimen terhadap harga emas dalam sistem VAR:

#### 1. Orthogonalized Impulse Response Function (OIRF)
Melalui dekomposisi Cholesky terhadap matriks kovariansi residual $\boldsymbol{\Sigma} = \mathbf{P}\mathbf{P}^T$ (dengan $\mathbf{P}$ berupa matriks segitiga bawah), representasi *Vector Moving Average* (VMA) diperoleh:

$$\mathbf{Y}_t = \boldsymbol{\mu} + \sum_{i=0}^\infty \boldsymbol{\Theta}_i \mathbf{w}_{t-i}$$

Di mana $\boldsymbol{\Theta}_i = \boldsymbol{\Phi}_i \mathbf{P}$ dan $\mathbf{w}_t = \mathbf{P}^{-1} \mathbf{u}_t$ adalah guncangan ortogonal berbobot variansi satu ($\mathbb{E}[\mathbf{w}_t \mathbf{w}_t^T] = \mathbf{I}$).

Matriks $\boldsymbol{\Theta}_i$ mengilustrasikan respons dinamis return emas pada periode $t+i$ akibat satu standar deviasi guncangan sentimen pada waktu $t$:
- Jika respons return kumulatif $\sum_{i=0}^h \Theta_{12}^{(i)}$ stabil pada nilai positif/negatif, shock sentimen membawa penyesuaian harga permanen (*permanent price discovery*).
- Jika respons return kumulatif berbalik arah mendekati nol pasca jam ke-4, shock sentimen hanya merupakan *transitory liquidity distortion* (kebisingan yang mengalami *mean-reversion*).

#### 2. Forecast Error Variance Decomposition (FEVD)
FEVD mengukur proporsi variansi galat prediksi return XAUUSD pada horison langkah ke-$h$ yang dapat diatribusikan secara eksogen kepada shock sentimen teks:

$$\omega_{R \leftarrow S}(h) = \frac{\sum_{i=0}^{h-1} \left( \mathbf{e}_1^T \boldsymbol{\Theta}_i \mathbf{e}_2 \right)^2}{\sum_{j=1}^K \sum_{i=0}^{h-1} \left( \mathbf{e}_1^T \boldsymbol{\Theta}_i \mathbf{e}_j \right)^2}$$

Pada pasar komoditas efisien, literatur quant mendokumentasikan bahwa sentimen berita menjelaskan sekitar $8\% - 18\%$ variansi galat return intraday pada horizon 1H hingga 4H.

---

## 6. Integritas Data, Point-in-Time Timestamping, & Mitigasi Bias Kuantitatif

Salah satu ancaman paling destruktif dalam rekayasa sistem trading kuantitatif adalah **Look-Ahead Bias** (kebocoran informasi masa depan ke masa lalu) dan **Data Leakage**. Backtest yang tampak menguntungkan (*overfitted profitability*) hampir selalu runtuh saat diuji pada live production akibat pelanggaran integritas temporal.

```
[Ilustrasi Jalur Waktu Publikasi vs Ketersediaan Sinyal]
Source Publication (API Raw) ---------> t_pub  (08:30:00 UTC)
                                          │
Network Scrape & Crawler Lag ----------> │  (+15 detik)
                                          ▼
System Ingestion Timestamp -----------> t_ingest (08:30:15 UTC)
                                          │
NLP Model Tokenization & FinBERT -----> │  (+35 ms)
                                          ▼
Signal Generation Ready --------------> t_signal (08:30:16 UTC)
                                          │
Execution Fill (Order Execution) -----> t_exec (08:30:17 UTC) --> HARGA SAAT INI HANYA VALID DI SINI!
```

### 6.1 Anatomi Look-Ahead Bias pada NLP Finansial

Terdapat lima sumber utama kebocoran informasi masa depan pada pemrosesan berita teks finansial:
1. **Publication vs Ingestion Time Lag:**
   Artikel mencantumkan metadata `published_at = 08:30:00`. Namun, crawler atau API provider baru menangkap teks tersebut pada `08:31:30`. Backtest yang mencocokkan harga aset pada pukul `08:30:00` menggunakan informasi yang secara fisik baru tersedia 90 detik kemudian.
2. **Article Mutation & Post-Publication Edits:**
   Kantor berita (seperti Reuters atau Bloomberg) kerap memutakhirkan isi artikel berita (*"Story updated with official comments"*). Jika sistem menyimpan versi artikel yang diperbarui pada pukul `09:15:00` dan menggunakannya dengan timestamp awal `08:30:00`, model membaca fakta yang belum terjadi.
3. **Macroeconomic Revision Contamination:**
   Data indikator ekonomi (PDB, NFP, CPI) kerap mengalami revisi resmi pada bulan berikutnya. Penggunaan data revisi final dalam kalender ekonomi untuk mengevaluasi reaksi pasar masa lalu merupakan bentuk fatal dari *look-ahead bias*. Wajib digunakan data *first-release* (angka rilis pertama).
4. **TF-IDF Vocabulary Leakage:**
   Fitting vektorizer TF-IDF pada seluruh dataset (train + validation + test) secara serentak menyebabkan bobot kata dan kamus kosa kata dari set uji bocor ke set latih. Vektorizer **wajib di-fit strictly hanya pada set latih**.
5. **LLM Pretraining Contamination:**
   Model fondasi yang dilatih pada crawl internet hingga tahun 2024 telah "mengingat" peristiwa dan arah pasar 2023 di dalam bobot memorinya (He et al., 2025; Didisheim et al., 2026).

---

### 6.2 Protokol Point-in-Time (PIT) & Dual-Timestamp Architecture

Untuk menjamin kepatuhan *Point-in-Time* (PIT), setiap rekaman berita dalam sistem wajib memiliki skema metadata temporal ganda yang tidak dapat diubah (*immutable*):

```sql
CREATE TABLE news_sentiment_records (
    article_id VARCHAR(64) PRIMARY KEY,
    source_published_at_utc TIMESTAMP WITH TIME ZONE NOT NULL,
    system_ingested_at_utc TIMESTAMP WITH TIME ZONE NOT NULL,
    inference_completed_at_utc TIMESTAMP WITH TIME ZONE NOT NULL,
    model_version VARCHAR(32) NOT NULL,
    raw_headline_hash VARCHAR(64) NOT NULL,
    raw_content TEXT NOT NULL,
    is_revision BOOLEAN DEFAULT FALSE,
    parent_article_id VARCHAR(64) REFERENCES news_sentiment_records(article_id),
    calculated_sentiment_score FLOAT NOT NULL
);
```

#### Aturan Eksekusi Simulasi Kuantitatif
Dalam simulasi backtest dan evaluasi out-of-time:

$$t_{\text{actionable}} = \max\left( t_{\text{source\_published}}, t_{\text{system\_ingested}} \right) + \delta_{\text{latency}}$$

Di mana $\delta_{\text{latency}}$ adalah penalti latensi minimum (standar konservatif: $60 \text{ detik}$ untuk scraping berita, $500 \text{ ms}$ untuk direct wire). Harga eksekusi simulasi hanya diizinkan mengambil bar harga yang dibuka setelah $t_{\text{actionable}}$.

---

### 6.3 Pengelolaan Revisi Berita & Snapshot Immutability

Jika sebuah berita diperbarui oleh sumber aslinya:
- Sistem dilarang melakukan operasi `UPDATE` terhadap rekaman lama.
- Sistem wajib melakukan operasi `INSERT` rekaman baru sebagai versi turunan dengan `is_revision = TRUE`, mencatat `system_ingested_at_utc` baru.
- Keputusan pasar historis tetap mengacu pada snapshot teks versi awal yang terbit sebelum keputusan diambil.

---

### 6.4 Embargo Period (24H Isolation Window) & Purged Walk-Forward Split

Pemisahan data deret waktu standar (*train-val-test split*) kerap gagal mengisolasi dependensi serial autokorelasi. Sinyal sentimen pada akhir periode pelatihan masih dapat memiliki korelasi residual dengan harga di awal periode pengujian jika target return memiliki jendela ke depan ($t+h$).

```
[Struktur Split Data dengan Embargo Buffer]
|------------- TRAIN -------------|=== EMBARGO ===|------ TEST (OUT-OF-TIME) ------|
t_0                            t_train          t_test_start                     T_final
                               [ 24 Jam Isolasi ]
```

#### Mekanisme 24H Embargo
Sebagaimana telah diimplementasikan dalam modul `services/sentiment-analysis/src/features/build_features.py`:
1. Sesi latihan diakhiri pada waktu $T_{\text{train}}$.
2. Seluruh data dalam jendela $[T_{\text{train}} - 24\text{H}, T_{\text{train}}]$ dibuang (*purged/embargoed*) dari himpunan data latihan untuk mencegah kebocoran sinyal yang horizon return-nya menyentuh set validasi.
3. Seluruh data dalam jendela $[T_{\text{val}} - 24\text{H}, T_{\text{val}}]$ dibuang dari set validasi sebelum memasuki set uji (*untouched test set*).
4. Pengujian *negative control* (misalnya permutasi label acak / *shuffled labels*) wajib menunjukkan performa model runtuh ke level probabilitas acak ($F1 \approx 0.33$ untuk 3 kelas), yang membuktikan bahwa model tidak menghafal pola artifisial akibat kebocoran data.

---

### 6.5 Temporal Contamination pada Pretrained Foundation Models

Publikasi terobosan terkini (He et al., 2025; Didisheim et al., 2026; *"Chronologically Consistent Large Language Models: ChronoBERT and ChronoGPT"*, arXiv:2502.21206 & arXiv:2607.11889) menyoroti fenomena **Training Leakage** pada model LLM.

Ketika LLM yang telah dilatih pada data hingga tahun 2024 digunakan untuk menganalisis berita tahun 2022, model dapat menghasilkan prediksi akurat bukan karena keahlian ekstraksi sentimen teks, melainkan karena bobot neural-nya telah mengenali bahwa bank tertentu akhirnya kolaps atau harga emas akhirnya meroket pada tanggal tersebut.

#### Rekomendasi Penanganan LLM Leakage:
1. **Restriksi Peran LLM:** Gunakan LLM murni sebagai *Linguistic & Semantic Extractor* (menilai apakah teks mengindikasikan suku bunga naik/turun atau ketegangan perang meningkat/mereda), **bukan sebagai pemprediksi harga langsung**.
2. **Evaluasi Out-of-Corpus:** Pengujian model prediktif akhir (*LightGBM / Ridge / Quantile Regressor*) harus dievaluasi pada data out-of-time yang strictly berada di luar periode waktu apapun yang berpotensi terkontaminasi.

---

## 7. Metrik Evaluasi Standar Quantitative Finance

Evaluasi sistem sentimen kuantitatif tidak boleh hanya mengandalkan metrik machine learning umum (seperti akurasi mentah), melainkan wajib mengintegrasikan metrik evaluasi portofolio kuantitatif standar institusi.

### 7.1 Formulasi & Kriteria Evaluasi Rank IC / ICIR

Korelasi Rank Spearman antara skor sinyal sentimen $s_t$ dan return realisasi $r_{t+h}$:

$$\text{Rank IC} = \frac{\sum_{i=1}^N (R(s_i) - \overline{R(s)})(R(r_i) - \overline{R(r)})}{\sqrt{\sum_{i=1}^N (R(s_i) - \overline{R(s)})^2 \sum_{i=1}^N (R(r_i) - \overline{R(r)})^2}}$$

- **Uji Signifikansi (t-statistic):**
  
  $$t_{\text{IC}} = \text{Rank IC} \times \sqrt{\frac{N - 2}{1 - \text{Rank IC}^2}} \sim t(N - 2)$$

- **Toleransi Statistik:** Faktor dianggap memiliki sinyal nyata jika $|t_{\text{IC}}| > 1.96$ ($p < 0.05$) atau secara konservatif $|t_{\text{IC}}| > 2.58$ ($p < 0.01$).

---

### 7.2 Top-Bottom Quantile Spread ($Q_5 - Q_1$) & Uji Monotonisitas

Untuk menguji apakah sinyal sentimen dapat dikonversi menjadi strategi portofolio yang dapat dieksekusi secara nyata, seluruh observasi sinyal dibagi ke dalam 5 kuantil (*quintiles*):
- $Q_1$: $20\%$ observasi dengan sinyal paling negatif/bearish.
- $Q_2$: $20\%$ observasi negatif moderat.
- $Q_3$: $20\%$ observasi netral.
- $Q_4$: $20\%$ observasi positif moderat.
- $Q_5$: $20\%$ observasi paling positif/bullish.

```
       Ekspektasi Monotonisitas Ideal Return Faktor Kuantitatif
   Return (%)
       ▲
       │                                     ┌───┐
       │                               ┌───┐ │Q5 │
       │                         ┌───┐ │Q4 │ └───┘
       │                   ┌───┐ │Q3 │ └───┘
       │             ┌───┐ │Q2 │ └───┘
       │             │Q1 │ └───┘
       │       ──────┴───┴────────────────────────► Kuantil Sinyal
       │
```

#### 1. Long-Short Spread Return
Kinerja spread kuantil dihitung sebagai selisih return kuantil tertinggi dan kuantil terendah:

$$\Delta Q_{5-1, t+h} = R_{Q_5, t+h} - R_{Q_1, t+h}$$

Rata-rata return spread $\overline{\Delta Q_{5-1}}$ harus bernilai positif signifikan.

#### 2. Uji Monotonisitas Monotonik
Strategi kuantitatif berkualitas tinggi mensyaratkan return rata-rata kuantil bergerak naik secara strictly monotonic:

$$\overline{R}_{Q_1} < \overline{R}_{Q_2} < \overline{R}_{Q_3} < \overline{R}_{Q_4} < \overline{R}_{Q_5}$$

Skor monotonisitas dihitung menggunakan korelasi rank Spearman antar nomor kuantil $k \in \{1, 2, 3, 4, 5\}$ dan return rata-ratanya $\overline{R}_{Q_k}$:

$$\rho_{\text{monotonicity}} = \rho_s\left( k, \overline{R}_{Q_k} \right) \in [-1.0, +1.0]$$

Nilai $\rho_{\text{monotonicity}} \ge 0.90$ mengonfirmasi bahwa sinyal sentimen membedakan besaran return secara proporsional. Jika kurva berbentuk $U$ atau $V$ terbalik, sinyal hanya menangkap volatilitas (*magnitude*), bukan arah (*direction*).

---

### 7.3 Hit Ratio & Uji Statistik Non-Parametrik Pesaran-Timmermann

**Hit Ratio** (atau *Directional Accuracy*) mengukur persentase ketepatan tanda arah ramalan model:

$$\text{Hit Ratio} = \frac{1}{M} \sum_{t=1}^M \mathbb{I}\left( \text{sign}(\hat{y}_t) == \text{sign}(y_t) \right)$$

Di mana $\mathbb{I}(\cdot)$ adalah fungsi indikator biner. Pada sistem tiga kelas (turun, datar, naik), akurasi dasar acak adalah $33.33\%$, sedangkan pada sistem biner terkompresi (arah naik vs turun), acak adalah $50.0\%$.

#### Pesaran-Timmermann (PT) Directional Accuracy Test (1992)
Uji signifikansi non-parametrik Pesaran & Timmermann (1992, *Journal of Business & Economic Statistics*) menguji hipotesis nol bahwa prediksi model ($\hat{y}$) dan realisasi pasar ($y$) bersifat independen secara statistik, dengan memperhitungkan asimetri marginal probabilitas arah pasar:

$$P_* = P_y P_{\hat{y}} + (1 - P_y)(1 - P_{\hat{y}})$$

Di mana:
- $P_y = \frac{1}{M} \sum \mathbb{I}(y_t > 0)$ (probabilitas marginal pasar naik).
- $P_{\hat{y}} = \frac{1}{M} \sum \mathbb{I}(\hat{y}_t > 0)$ (probabilitas marginal prediksi model naik).
- $\hat{P}$ adalah proporsi Hit Ratio empiris.

Statistik uji Pesaran-Timmermann dirumuskan sebagai:

$$\text{PT} = \frac{\hat{P} - P_*}{\sqrt{\widehat{\text{Var}}(\hat{P}) - \widehat{\text{Var}}(P_*)}} \xrightarrow{d} \mathcal{N}(0, 1)$$

Jika $\text{PT} > 1.96$, keunggulan akurasi arah model terbukti signifikan secara statistik pada tingkat kepercayaan $95\%$.

---

### 7.4 Metrik Risiko Portofolio: Sharpe Ratio, Drawdown, & Transaction Drag

Sinyal sentimen yang menghasilkan return teoritis positif dapat menjadi tidak menguntungkan secara praktis apabila frekuensi turnover-nya terlalu tinggi sehingga tergerus oleh biaya transaksi (*spread, commission, slippage*).

1. **Annualized Sharpe Ratio:**
   
   $$\text{SR} = \frac{\overline{R}_{\text{strategy}} - R_f}{\sigma_{\text{strategy}}} \times \sqrt{N_{\text{periods per year}}}$$

2. **Maximum Drawdown (MDD):**
   
   $$\text{MDD} = \max_{\tau \in [0, T]} \left( \frac{\max_{t \in [0, \tau]} W_t - W_\tau}{\max_{t \in [0, \tau]} W_t} \right)$$

3. **Net Return Adjusted for Turnover Drag:**
   
   $$R_{\text{net}, t} = R_{\text{gross}, t} - 2 \times \text{Turnover}_t \times \left( \frac{\text{Spread}_{\text{XAUUSD}}}{2} + \text{Comm} + \text{Slippage} \right)$$

Pada pasar XAUUSD, biaya transaksi tipikal akun institusional/prime broker adalah $0.15 - 0.30 \text{ USD}$ per troy ounce (spread ~1.5 - 3.0 pips). Strategi dengan horizon 1H wajib memperhitungkan drag ini sebelum mengklaim profitabilitas sinyal.

---

## 8. Rekomendasi Arsitektural untuk Sistem Informasi Market XAUUSD

### 8.1 Evaluasi & Gap Analysis Pipeline Eksisting

Berdasarkan audit terhadap kode pada modul `services/sentiment-analysis`:

| Komponen Eksisting | Status Implementasi Saat Ini | Evaluasi Kritis & Celah Metodologis |
| :--- | :--- | :--- |
| **Feature Extraction** (`build_features.py`) | TF-IDF n-gram (150 fitur) + sentiment ordinal | Pendekatan BoW TF-IDF rentan kehilangan struktur sintaksis kalimat; belum menangkap *Asset Inversion Effect*. |
| **Pemisahan Waktu & Embargo** | Time-based split + 24H embargo | **Sangat Baik.** Sudah mematuhi protokol anti-lookahead dan isolasi temporal yang ketat. |
| **Model Champion** (`train.py`) | LightGBM multi-class (Turun, Datar, Naik) | Macro-F1: 0.3166, Balanced Acc: 0.3199, Rank IC: 0.0635 ($p=0.279$). Cukup solid melampaui baseline aturan, namun Rank IC belum mencapai signifikansi statistik $p < 0.05$. |
| **Kovariat Makroekonomi** | Belum ada integrasi DXY & Yields | Model memprediksi return emas murni dari teks berita; mengabaikan variabel penjelas terbesar (Real Yield TIPS & DXY). |
| **Resolusi Target** | Fixed 1-Hour return target (`ret_1h`) | Terlalu kaku; belum menguji multi-horizon (4H dan 24H) untuk memfilter mikrostruktur noise. |

---

### 8.2 Desain Arsitektur Hybrid Ingestion & Feature Engineering

Diusulkan rancangan arsitektur generasi berikutnya yang menggabungkan efisiensi komputasi, pemahaman semantik transformatif, dan logika transmisi makroekonomi:

```
[Arsitektur Hybrid Rekomendasi]

Raw Feed Berita & RSS/API
           │
           ▼
[Point-in-Time Dual Ingestion Filter] (Catat t_pub & t_ingest, hash immutability)
           │
           ▼
   ┌─────────────────────────────────────────────────────────┐
   │             Hybrid Semantic Extraction Layer            │
   ├────────────────────────────┬────────────────────────────┤
   │ FinBERT Domain Embedding   │ LLM Macro Topic Classifier │
   │ (Softmax Sentiment Vector) │ (Rates, Inflation, Geopol) │
   └─────────────┬──────────────┴─────────────┬──────────────┘
                 │                            │
                 ▼                            ▼
            [Topic-Conditional Inversion Matrix]
            (Membalik polaritas berita AS positif -> Bearish Emas)
                 │
                 ▼
      [Macro Harmonization Engine]
      (Sinkronisasi real-time DXY, US10Y Nominal, TIPS Real Yield)
                 │
                 ▼
   ┌─────────────────────────────────────────────────────────┐
   │             Quantitative ML Predictive Layer            │
   │  (CatBoost / LightGBM Regressor dengan Monotonic Shape) │
   └────────────────────────────┬────────────────────────────┘
                                │
                                ▼
       [Multi-Horizon Predictive Alphas: 1H, 4H, 24H]
                                │
                                ▼
       [Evaluasi: Rank IC, ICIR, Quantile Spread Q5-Q1]
```

#### Langkah-langkah Implementasi Teknis:
1. **Modul Ekstraksi Sentimen FinBERT:**
   Ganti vektorizer TF-IDF teks dengan model pretrained `ProsusAI/finbert` atau `yiyanghkust/finbert-tone`. Ekstraksi vektor logit kontinunya:
   
   $$S_{\text{raw}} = P(\text{Positive}) - P(\text{Negative})$$

2. **Ekstraksi Topik Makro Otomatis:**
   Gunakan model *Zero-Shot Cross-Encoder* ringan (misal `valhalla/distilbart-mnli-12-3`) untuk mengklasifikasikan headline ke dalam kategori: `[monetary_policy, us_economic_growth, geopolitical_risk, banking_crisis, neutral_market]`.
3. **Penerapan Aturan Pembalikan Aset (Asset Inversion Logic):**
   
   $$\text{Polarity Multiplier } \mu = \begin{cases} -1.0 & \text{jika topik } \in \{\text{monetary\_policy, us\_economic\_growth}\} \\ +1.0 & \text{jika topik } \in \{\text{geopolitical\_risk, banking\_crisis}\} \\ 0.0 & \text{jika topik netral} \end{cases}$$
   
   $$S_{\text{adjusted}}^{\text{XAUUSD}} = S_{\text{raw}} \times \mu$$

---

### 8.3 Desain Target Label Multi-Horizon & Continuous Scoring

Untuk menghindari kelemahan diskritisasi kelas sembarang (*arbitrary thresholding* pada return 1H), sistem direkomendasikan mengadopsi dua pendekatan komplementer:
1. **Continuous Target Regression:**
   Latih model untuk memprediksi langsung besaran log-return $R_{t \to t+h}$ menggunakan fungsi kerugian *Huber Loss* yang tahan terhadap outlier:
   
   $$L_\delta(y, \hat{y}) = \begin{cases} \frac{1}{2}(y - \hat{y})^2 & \text{jika } |y - \hat{y}| \le \delta \\ \delta (|y - \hat{y}| - \frac{1}{2}\delta) & \text{lainnya} \end{cases}$$

2. **Multi-Horizon Simultaneous Heads:**
   Hasilkan tiga sinyal terpisah:
   - $\alpha_{1\text{H}}$: Menangkap momentum volatilitas dan reaksi spontan.
   - $\alpha_{4\text{H}}$: Menangkap kelanjutan tren pasca-reaksi likuiditas London-New York.
   - $\alpha_{24\text{H}}$: Menangkap reposisi fundamental harian institusional.

---

### 8.4 Blueprint Implementasi Tahap Lanjutan

Berikut tahapan konkret untuk mengeksekusi integrasi riset ke dalam repositori:

1. **Fase 1 (Data Ingestion & Macro Harmonization):**
   - Tambahkan skrip pengambil data historis dan real-time untuk **DXY** dan **US 10Y Real Yields (TIPS)** ke dalam `src/acquire/macro.py`.
   - Lakukan sinkronisasi data makro pada resolusi per jam (H1) di dalam `src/process/harmonize.py`.
2. **Fase 2 (Transformer & Topic Extraction Engine):**
   - Bangun modul inferensi batch FinBERT di `src/features/finbert_extractor.py` dengan fallback CPU yang efisien.
   - Implementasikan *Macro Inversion Filter* untuk menormalisasi arah berita ekonomi AS terhadap emas.
3. **Fase 3 (Quant Evaluation Suite):**
   - Perluas modul `src/evaluate/evaluate_models.py` untuk mengkalkulasi:
     - Rolling Spearman Rank IC dan ICIR.
     - 5-Quantile Portfolio Spread ($Q_5 - Q_1$) dan uji monotonisitas.
     - Uji statistik Pesaran-Timmermann untuk akurasi arah.
4. **Fase 4 (Deployment & Monitoring Alpha Decay):**
   - Implementasikan dashboard tracking peluruhan performa Rank IC secara bergulir untuk mendeteksi rezim pasar baru di mana hubungan korelasi sentimen mengalami pergeseran.

---

## 9. Bibliografi & Referensi Ilmiah Terindeks

1. **Araci, D. (2019).** *FinBERT: Financial Sentiment Analysis with Pre-trained Language Models.* arXiv preprint arXiv:1908.10063.
2. **Barberis, N., Shleifer, A., & Vishny, R. (1998).** *A model of investor sentiment.* Journal of Financial Economics, 49(3), 307-343.
3. **Baur, D. G., & Lucey, B. M. (2010).** *Is gold a hedge or a safe haven? An analysis of stocks, bonds and gold.* The Financial Review, 45(2), 217-229.
4. **Campbell, J. Y., Lo, A. W., & MacKinlay, A. C. (1997).** *The Econometrics of Financial Markets.* Princeton University Press.
5. **Christie-David, R., Chaudhry, M., & Koch, T. W. (2000).** *Do macroeconomics news releases affect gold and silver prices?* Journal of Economics and Business, 52(5), 405-421.
6. **Devlin, J., Chang, M. W., Lee, K., & Toutanova, K. (2019).** *BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding.* Proceedings of NAACL-HLT, 4171-4186.
7. **Didisheim, A., Ke, S., Kelly, B., & Malafeev, A. (2026).** *Scaling Point-in-Time Language Models: Enabling Economic Evaluation of Embeddings.* arXiv preprint arXiv:2607.11889.
8. **Elder, J., Miao, H., & Ramchander, S. (2012).** *Impact of macroeconomic news on metal futures.* Journal of Banking & Finance, 36(1), 51-65.
9. **Erb, C. B., & Harvey, C. R. (2013).** *The Golden Dilemma.* Financial Analysts Journal, 69(4), 10-42.
10. **Fama, E. F. (1970).** *Efficient Capital Markets: A Review of Theory and Empirical Work.* The Journal of Finance, 25(2), 383-417.
11. **Granger, C. W. (1969).** *Investigating causal relations by econometric models and cross-spectral methods.* Econometrica, 37(3), 424-438.
12. **Grinold, R. C., & Kahn, R. N. (2000).** *Active Portfolio Management: A Quantitative Approach for Providing Superior Returns and Controlling Risk.* McGraw-Hill.
13. **Groß-Klußmann, A., & Hautsch, N. (2011).** *When machines read the news: Using automated text analysis to explain high-frequency order flows and liquidity.* Journal of Financial Markets, 14(2), 321-340.
14. **He, X., Ludwig, M. et al. (2025).** *Chronologically Consistent Large Language Models: ChronoBERT and ChronoGPT.* arXiv preprint arXiv:2502.21206.
15. **Lopez-Lira, A., & Tang, Y. (2023, updated 2025).** *Can ChatGPT Forecast Stock Price Movements? Return Predictability and Large Language Models.* arXiv preprint arXiv:2304.07619.
16. **Loughran, T., & McDonald, B. (2011).** *When Is a Liability Not a Liability? Textual Analysis, Dictionaries, and 10-Ks.* The Journal of Finance, 66(1), 35-65.
17. **MacKinlay, A. C. (1997).** *Event Studies in Economics and Finance.* Journal of Economic Literature, 35(1), 13-39.
18. **Malo, P., Sinha, A., Korhonen, P., Wallenius, J., & Takala, P. (2014).** *Good debt or bad debt: Detecting semantic orientations in economic texts.* Journal of the Association for Information Science and Technology, 65(4), 782-796.
19. **Pesaran, M. H., & Timmermann, A. (1992).** *A simple nonparametric test of predictive performance.* Journal of Business & Economic Statistics, 10(4), 461-465.
20. **Shleifer, A., & Vishny, R. W. (1997).** *The limits of arbitrage.* The Journal of Finance, 52(1), 35-55.
21. **Smales, L. A. (2014).** *News sentiment in the gold futures market.* Journal of Banking & Finance, 49, 275-286.
22. **Smales, L. A. (2015).** *The importance of belief dispersion in the response of gold futures to macroeconomic announcements.* International Review of Financial Analysis, 41, 292-302.
23. **Tetlock, P. C. (2007).** *Giving Content to Investor Sentiment: The Role of Media in the Stock Market.* The Journal of Finance, 62(3), 1139-1168.
24. **Yang, Y., Uy, M. C. S., & Huang, A. (2020).** *FinBERT: A Pretrained Language Model for Financial Communications.* arXiv preprint arXiv:2006.08097.
