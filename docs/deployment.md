# Deployment Runbook — XAUUSD News Sentiment

Panduan deploy produksi ke VPS dengan Docker Compose + image GHCR.
Semua perintah di server memakai **`-f compose.yaml`** supaya
`compose.override.yaml` (dev-only: bind mount source, tsx watch, port debug)
**tidak ikut terpakai**.

## 1. Arsitektur

```
internet :80
   └── nginx (nginx:1.27-alpine)
         ├── /       → web:3000   (Next.js 15 standalone)
         └── /api/   → api:4000   (Fastify, SSE-aware)
api ── HTTP ──→ sentiment:8000    (FastAPI + torch CPU, /health /sync /sync/status /prediction)
worker ─ HTTP ─→ sentiment:8000   (cron ingest + sync, image "app" sama dengan api)
api/worker/migrate ──→ db:5432    (postgres:16.6-alpine)
```

| Image | Isi | Ukuran actual (build lokal) |
|---|---|---|
| `ghcr.io/fiyanz/xauusd-news-sentiment/web` | Next standalone, node:22-slim | ~300 MB (estimasi; belum di-build pass ini) |
| `ghcr.io/fiyanz/xauusd-news-sentiment/app` (target `runtime`) | api + worker (Node murni), node:22-slim | **1,03 GB** |
| `ghcr.io/fiyanz/xauusd-news-sentiment/app` (target `migrate`) | + devDeps (drizzle-kit) | **1,33 GB** |
| `ghcr.io/fiyanz/xauusd-news-sentiment/sentiment` | python:3.12-slim + torch CPU + models dibake | **3,4 GB** |
| `postgres:16.6-alpine` | database | ~250 MB |
| `nginx:1.27-alpine` | reverse proxy | ~50 MB |

Catatan ukuran (jangan kaget, ini wajar untuk dependency yang di-lock):

- **app 1,03 GB** (bukan ~280 MB estimasi awal): `bun install --production`
  memasang production deps SEMUA workspace termasuk `apps/web`
  (next/react/sharp ikut terpasang meski tidak dipakai api/worker).
  Optimisasi opsional ke depan: install ter-filter hanya workspace api/worker.
- **sentiment 3,4 GB**: torch `2.15.0+cpu` terpasang ~805 MB
  (`libtorch_cpu.so` 440 MB, tanpa CUDA), `nvidia-nccl-cu13` ~242 MB
  (tarikan xgboost — sah, bukan CUDA runtime), pyarrow 169 MB,
  transformers 118 MB, scipy 108 MB, sisanya pandas/sklearn/dll,
  + models 120 MB dibake + bytecode `.pyc` (start lebih cepat).
  Verifikasi image: `torch.cuda.is_available() == False`, tidak ada
  `nvidia-cuda*` di site-packages, `data/` kosong (mount point volume).

- api & worker memakai **satu image `app`**, beda command:
  `node apps/api/dist/server.js` vs `node apps/worker/dist/index.js`.
- Repo di-copy ke `/app` (`REPO_ROOT=/app`), struktur path sama dengan repo.
- Volume named: `pgdata` (Postgres) dan `sentiment-data`
  (`/app/services/sentiment-analysis/data`): RW di sentiment,
  **read-only di api** (calendar CSV) **dan worker** (ingest
  `news_corpus.jsonl` — worker membaca file lokal, bukan HTTP).
  Tulis artifact pipeline hanya terjadi di container sentiment.
- `data/` (591 MB) tidak masuk image (`.dockerignore`). **Volume
  `sentiment-data` WAJIB di-seed dari `data/` repo sebelum deploy pertama**
  (lihat §5) — pipeline butuh sejarah harga penuh sejak 2010 yang tidak
  bisa di-backfill yfinance.

## 2. Spek minimum VPS

- **2 vCPU / 4 GB RAM / 25 GB disk** (torch CPU + Postgres + total image
  ~5 GB + volume data ~600 MB + ruang build/rollback). Disarankan RAM 4 GB+
  karena load model sentiment; tambah swap 2 GB bila RAM pas 4 GB.
  Sync penuh (retrain) bisa memakan CPU beberapa menit — itu normal.
- OS: Ubuntu 22.04/24.04 LTS (atau Debian 12).
- Port 80 terbuka (security group/firewall). Port 443 bila menambahkan TLS
  (di luar scope compose ini — bisa pakai Caddy/Cloudflare di depan nginx).

## 3. Install Docker (sekali)

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # logout/login lagi setelah ini
docker compose version          # pastikan Compose v2 tersedia
```

## 4. Clone + konfigurasi

```bash
sudo mkdir -p /opt && sudo chown $USER /opt
cd /opt
git clone https://github.com/fiyanz/xauusd-news-sentiment.git
cd xauusd-news-sentiment

cp .env.production.example .env
nano .env   # WAJIB diisi:
```

| Variabel | Keterangan |
|---|---|
| `POSTGRES_PASSWORD` | password kuat, mis. `openssl rand -base64 24` |
| `PIPELINE_SYNC_TOKEN` | token acak panjang untuk trigger sync via API |
| `WEB_ORIGIN` | origin web publik (CORS), mis. `https://domain-anda` |
| `DERIV_APP_ID` / `DERIV_API_TOKEN` | opsional (market data publik Deriv) |
| `NEWSAPI_AI_KEY` / `NEWS_API_KEY` / `GNEWS_API_KEY` | opsional, dibaca pipeline Python |

`DATABASE_URL` (host `db`), `REPO_ROOT=/app`, `SENTIMENT_SERVICE_URL=http://sentiment:8000`,
dan `NODE_ENV=production` sudah di-set otomatis oleh `compose.yaml`.
**Jangan pernah commit `.env`** (sudah di `.gitignore`).

> Penting: `POSTGRES_PASSWORD` hanya berlaku saat **inisialisasi volume
> `pgdata` pertama kali**. Mengganti nilai di `.env` setelah volume terisi
> TIDAK mengubah password di database (harus `ALTER USER` manual atau
> reset volume). Simpan password yang dipakai saat init baik-baik.

## 5. Deploy pertama: SEEDING volume (WAJIB) + pull + jalankan

Volume `sentiment-data` fresh = kosong, sedangkan `data/` sengaja tidak
dibake ke image. Tanpa seeding, pipeline tidak punya sejarah harga penuh
(`xauusd_h1_complete.csv` 97k baris sejak 2010), corpus berita, dan cache
embedding — yfinance tidak bisa backfill sejauh itu. **Seed dulu, baru up:**

```bash
cd /opt/xauusd-news-sentiment

# 1) Buat volume sesuai nama project compose (name: xauusd-news-sentiment)
docker volume create xauusd-news-sentiment_sentiment-data

# 2) Salin data/ repo ke volume (read-only source), lalu chown ke uid
#    appuser container sentiment (10001) supaya pipeline bisa menulis.
docker run --rm \
  -v xauusd-news-sentiment_sentiment-data:/dst \
  -v "$PWD/services/sentiment-analysis/data":/src:ro \
  alpine:3.20 sh -c 'cp -a /src/. /dst/ && chown -R 10001:10001 /dst'

# 3) (Opsional, hanya bila punya backup pgdata dari server lama)
#    Restore SEBELUM up pertama supaya migrate tidak meng-init skema kosong:
docker volume create xauusd-news-sentiment_pgdata
docker run --rm \
  -v xauusd-news-sentiment_pgdata:/dst \
  -v "$PWD":/backup:ro alpine:3.20 \
  sh -c 'tar xzf /backup/pgdata-backup.tar.gz -C /dst'
#    Atau restore logis via pg_dump/psql setelah db up (lihat §8).

# 4) Pull image + jalankan
docker compose -f compose.yaml pull
docker compose -f compose.yaml up -d
```

Urutan startup otomatis (depends_on + healthcheck):

1. `db` sehat (`pg_isready`) →
2. `migrate` jalan one-shot (`bunx drizzle-kit migrate`, restart `no`,
   working_dir `packages/database`) →
3. `sentiment` sehat (`GET /health`; import torch lama, start_period 90s) →
4. `api` & `worker` start (setelah migrate `completed_successfully` +
   sentiment healthy) →
5. `web` start (setelah api healthy) →
6. `nginx` start (setelah web + api healthy), publik di port 80.

Migrasi berjalan **otomatis tiap `up -d`** dan idempotent (drizzle mencatat
migration yang sudah diterapkan di tabel `__drizzle_migrations`).

Worker langsung menjalankan cycle penuh saat start: candles Deriv →
calendar → COT → `POST /sync` ke sentiment (pipeline berat, beberapa menit,
retrain model) → ingest corpus ke `news_articles` → tulis heartbeat.
Jadi prediksi pertama tersedia beberapa menit setelah deploy pertama.

> Catatan build worker: `apps/worker/package.json` belum punya script `build`
> (start masih `tsx`). `Dockerfile.app` meng-compile worker langsung dengan
> `bunx tsc -p apps/worker/tsconfig.json` (tsconfig sudah `outDir: dist`),
> jadi `apps/worker/dist/index.js` tetap dihasilkan. Tambahkan script
> `"build": "tsc"` ke worker bila ingin `turbo run build` ikut membangunnya.

## 6. Verifikasi

```bash
docker compose -f compose.yaml ps          # semua healthy (worker: lihat catatan)
curl -fsS http://localhost/api/v1/system/health        # via nginx → api
curl -fsS http://localhost/ -o /dev/null -w '%{http_code}\n'   # web 200
curl -fsS 'http://localhost/api/v1/news/latest?limit=5'        # news DB
# SSE: harus mengalir terus (tick Deriv), bukan putus/buffer:
curl -N --max-time 15 http://localhost/api/v1/market/xauusd/stream
# Prediksi macro (api fetch ke sentiment /prediction):
curl -fsS http://localhost/api/v1/analytics/macro-sentiment/latest
# Trigger sync manual (token dari .env):
curl -X POST -H "x-pipeline-token: $PIPELINE_SYNC_TOKEN" \
     http://localhost/api/v1/pipeline/sync
```

- **Health worker**: based on mtime `/tmp/worker-heartbeat` (< 20 menit).
  Cycle pertama bisa menunggu sync sentiment sampai ~20 menit, jadi
  `start_period` worker 25 menit — status `starting` di awal itu normal.
  Cek manual: `docker compose -f compose.yaml exec worker node -e "console.log(require('fs').statSync('/tmp/worker-heartbeat').mtime)"`.
- Log: `docker compose -f compose.yaml logs -f api worker sentiment`.
- Status pipeline: `docker compose -f compose.yaml exec sentiment python -c "import urllib.request;print(urllib.request.urlopen('http://localhost:8000/sync/status').read().decode())"`.
  `POST /sync` kedua saat pipeline jalan → 409 (single-flight lock).
- Pertama kali deploy, `/prediction` dan `/api/v1/news/latest` menjawab
  `unavailable` sampai sync pertama selesai (worker otomatis trigger saat
  start, atau trigger manual di atas).

## 7. Update (rilis baru)

Push ke `main` → GitHub Actions (`.github/workflows/deploy.yml`) membangun
3 image (tag `sha-<commit>` + `latest`) ke GHCR. Bila secrets SSH diisi,
job deploy otomatis: `git pull --ff-only` (ambil compose/nginx terbaru) →
`docker compose -f compose.yaml pull` → `up -d`. Manual:

```bash
cd /opt/xauusd-news-sentiment
git pull --ff-only             # ambil compose.yaml/nginx.conf terbaru
docker compose -f compose.yaml pull
docker compose -f compose.yaml up -d     # recreate yang berubah; migrate jalan lagi (idempotent)
docker compose -f compose.yaml ps
```

### Rollback ke commit tertentu

Image di-tag `sha-<commit>` (lihat tab Packages di GitHub). Rollback = pin
tag sha di `compose.yaml` (atau override sementara), mis.:

```bash
# pin sementara tanpa edit file (override shell):
TAG=sha-<commit-lama>
sed -i "s#app:latest#app:$TAG#g; s#web:latest#web:$TAG#g; s#sentiment:latest#sentiment:$TAG#g" compose.yaml
docker compose -f compose.yaml pull
docker compose -f compose.yaml up -d
# setelah inspeksi: git checkout -- compose.yaml  (kembalikan ke :latest)
```

Rollback migration TIDAK otomatis — bila skema berubah tidak-kompatibel,
pulihkan dulu (lihat §8) atau siapkan migration down manual.

## 8. Peringatan data & perintah destruktif

- **`docker compose down -v` MENGHAPUS `pgdata` DAN `sentiment-data`** —
  semua berita ter-ingest, hasil sync, dan prediksi hilang permanen.
  Jangan pernah pakai `-v` kecuali memang ingin reset total (konfirmasi dulu!).
  Restart biasa cukup: `docker compose -f compose.yaml down` (tanpa `-v`)
  atau `docker compose -f compose.yaml restart`.
- `docker volume rm` / `docker volume prune` pada volume project ini sama
  destruktifnya — hindari.
- Menghapus `sentiment-data` = mengulang seeding §5 + sync penuh (unduh
  berita + training ulang, berat). `models/` dibake ke image sentiment jadi
  tidak terpengaruh hapus volume.
- Backup sebelum operasi berisiko:

```bash
docker compose -f compose.yaml exec db pg_dump -U postgres xauusd_market > backup-$(date +%F).sql
docker run --rm -v xauusd-news-sentiment_sentiment-data:/data -v "$PWD":/backup alpine:3.20 \
  tar czf /backup/sentiment-data-$(date +%F).tar.gz -C /data .
```

Restore backup logis (setelah db up):

```bash
docker compose -f compose.yaml exec -T db psql -U postgres -d xauusd_market < backup-YYYY-MM-DD.sql
```

## 9. Secrets GitHub Actions

Settings repo → Secrets and variables → Actions:

| Secret | Wajib | Isi |
|---|---|---|
| `GITHUB_TOKEN` | otomatis | diprovide GitHub; `permissions: packages: write` sudah di workflow |
| `SSH_HOST` | opsional | host/IP VPS |
| `SSH_USER` | opsional | user SSH deploy (anggota group docker) |
| `SSH_KEY` | opsional | private key SSH (pasangan public key di `~/.ssh/authorized_keys` VPS) |
| `DEPLOY_PATH` | opsional | path repo di VPS (clone git, mis. `/opt/xauusd-news-sentiment`) |

Bila secrets SSH kosong, job deploy **dilewati dengan anggun** (build & push
image tetap jalan); deploy manual pakai §7. Buat key deploy khusus:

```bash
ssh-keygen -t ed25519 -f deploy_key -N ''
# deploy_key.pub → authorized_keys VPS; deploy_key (isi penuh) → secret SSH_KEY
```

Pastikan image GHCR bisa di-pull VPS: package visibility **public**, atau
`docker login ghcr.io` di VPS dengan PAT `read:packages` bila private.
`DEPLOY_PATH` harus clone git yang bersih (job deploy menjalankan
`git pull --ff-only`; edit lokal di VPS membuat deploy gagal aman).

## 10. Development dengan Docker (opsional)

```bash
docker compose up --build        # otomatis load compose.override.yaml (dev)
docker compose watch             # sync source + rebuild bila lockfile berubah
```

Override dev: bind mount source, `tsx watch` (api/worker), `next dev` (web),
`uvicorn --reload` (sentiment), port debug 3000/4000/8000/5432 dibuka ke host.
Jangan pakai mode ini di server.

## 11. Catatan teknis / known limitations

- **Node type stripping**: `packages/*` menunjuk `main` ke `src/index.ts`
  (gaya bun). Runtime `node:22-slim` (≥ 22.18, terverifikasi 22.23.5) memuat
  entry TS via type stripping native; `Dockerfile.app` menyalin hasil `tsc`
  ke sebelah `src/` supaya import relatif NodeNext (`./schema.js`) resolve.
  `NODE_OPTIONS=--experimental-transform-types` sudah di-set di image.
  **Terverifikasi di smoke test**: api health 200 dari dalam container.
- **bun install di Docker (penting untuk yang mengubah Dockerfile)**:
  1. `WORKDIR /app` dibuat root; `COPY --chown` hanya meng-chown file yang
     disalin, bukan direktorinya. Tanpa `RUN chown -R bun:bun /app` sebelum
     `USER bun`, `bun install` gagal `ENOENT failed to link` (477 packages).
  2. Default linker bun 1.4 = isolated: `@types/node` hanya ada di workspace
     yang mendeklarasikannya; `packages/database` tidak → tsc gagal TS2580.
     Solusi: `bun install --frozen-lockfile --linker=hoisted` (semua stage).
  3. drizzle-kit 0.28 me-resolve `out: "./drizzle"` relatif CWD, bukan lokasi
     config → service migrate harus `working_dir: /app/packages/database`.
- **Worker & corpus berita**: worker meng-ingest `news_corpus.jsonl` dari
  file lokal (`REPO_ROOT/services/sentiment-analysis/data/processed/`),
  maka compose me-mount `sentiment-data` **read-only** di worker (pola sama
  dengan api untuk calendar CSV). Tulis artifact tetap hanya di sentiment.
- **Web hardcoded `localhost:4000`**: `apps/web/src/app/page.tsx` (client
  component) masih fetch `http://localhost:4000/...` langsung dari browser —
  di produksi panggilan itu gagal dan jatuh ke fallback (semua ada
  `.catch(() => null)`). Route handler server-side sudah benar memakai
  `API_INTERNAL_URL` (di-set `http://api:4000`). Rekomendasi: ganti fetch
  browser ke path relatif `/api/v1/...` (sudah diproxy nginx) — di luar scope
  infra, perlu perubahan `apps/web/src`.
- **Anomali SCRAM host dev (bukan masalah stack)**: pada host dev
  (kernel 6.18-cachyos, Intel i5-12600H) ditemukan perilaku SCRAM postgres
  tidak konsisten: proof client psql/postgres-js menyimpang dari RFC 7677
  padahal primitif crypto teruji benar, dan beberapa server alpine menerima
  password apa pun. Klien dengan proof benar (python, terverifikasi RFC)
  berhasil auth ke db compose. Smoke test lokal memakai workaround
  `POSTGRES_HOST_AUTH_METHOD=*** + image debian (file scratch
  `compose.smoke.yaml`); **compose.yaml produksi tetap scram-sha-256**.
  Bila di VPS menemukan `28P01 password authentication failed` padahal password
  benar: cek versi kernel/image, coba image postgres varian debian, dan
  verifikasi dengan klien SCRAM independen sebelum menyalahkan konfigurasi.
- Healthcheck nginx memakai `wget` busybox (ada di image alpine).
- Semua container app berjalan **non-root** (`node`/`bun`/`appuser`),
  `init: true` untuk signal handling, log dibatasi 10 MB × 3 file.
