# syntax=docker/dockerfile:1
# =============================================================================
# Dockerfile.app — image "app" untuk api (Fastify) DAN worker (cron).
# Satu image, beda command di compose.yaml:
#   api    : node apps/api/dist/server.js
#   worker : node apps/worker/dist/index.js
#
# Multi-stage:
#   deps     : bun install --frozen-lockfile (devDeps ikut, untuk build)
#   build    : compile tsc api + worker + packages workspace
#   prod-deps: bun install --production (node_modules runtime saja)
#   migrate  : one-shot drizzle-kit migrate (devDeps dipertahankan)
#   runtime  : node:22-slim, prod-only, non-root (target DEFAULT/terakhir)
#
# Catatan penting (worker): apps/worker/package.json BELUM punya script
# "build" (start masih tsx). Karena itu stage build meng-compile worker
# langsung dengan `bunx tsc -p apps/worker/tsconfig.json` (tsconfig sudah
# punya outDir dist + rootDir src). Lihat docs/deployment.md.
#
# Catatan resolusi workspace: package.json packages/* menunjuk main ke
# ./src/index.ts (sumber TS, gaya bun). Node >= 22.18 mendukung type
# stripping native, jadi entry .ts bisa dimuat node; import relatif
# bergaya NodeNext ("./schema.js") dipenuhi dengan menyalin hasil compile
# dist/ ke sebelah src/ di stage runtime. NODE_OPTIONS di bawah memaksa
# transform-types supaya syntax non-erasable (enum, namespace) tetap aman.
# =============================================================================

# ---------- 1. Dependencies (full, termasuk devDeps) ----------
FROM oven/bun:1.4.2 AS deps
WORKDIR /app
# Manifest dulu supaya layer install ter-cache selama lockfile tidak berubah.
COPY --chown=bun:bun package.json bun.lock ./
COPY --chown=bun:bun apps/api/package.json apps/api/
COPY --chown=bun:bun apps/worker/package.json apps/worker/
COPY --chown=bun:bun apps/web/package.json apps/web/
COPY --chown=bun:bun packages/core-analytics/package.json packages/core-analytics/
COPY --chown=bun:bun packages/database/package.json packages/database/
COPY --chown=bun:bun packages/financial-clients/package.json packages/financial-clients/
COPY --chown=bun:bun packages/tsconfig/package.json packages/tsconfig/
COPY --chown=bun:bun packages/types/package.json packages/types/
# ROOT CAUSE fix (bun ENOENT "failed to link"): WORKDIR /app dibuat root
# (755) dan COPY --chown hanya meng-chown FILE yang disalin, bukan direktori
# /app itu sendiri. Sebagai USER bun, bun tidak bisa mkdir node_modules di
# /app -> semua link/symlink gagal ENOENT. chown direktori kerja ke bun.
RUN chown -R bun:bun /app
USER bun
# --linker=hoisted WAJIB: default bun 1.4 (isolated) menaruh @types/node
# hanya di workspace yang mendeklarasikannya; packages/database tidak,
# sehingga tsc gagal TS2580 "Cannot find name 'process'". Layout hoisted
# (gaya npm) membuat @types/* terlihat dari semua workspace via root.
RUN bun install --frozen-lockfile --linker=hoisted

# ---------- 2. Build (tsc api + worker + packages) ----------
FROM deps AS build
COPY --chown=bun:bun turbo.json ./
COPY --chown=bun:bun packages/tsconfig packages/tsconfig
COPY --chown=bun:bun packages/types packages/types
COPY --chown=bun:bun packages/core-analytics packages/core-analytics
COPY --chown=bun:bun packages/database packages/database
COPY --chown=bun:bun packages/financial-clients packages/financial-clients
COPY --chown=bun:bun apps/api apps/api
COPY --chown=bun:bun apps/worker apps/worker
# Direktori workspace yang sudah ada sejak stage deps tetap root-owned
# (COPY --chown tidak mengubah ownership direktori tujuan yang sudah ada).
# tsc perlu menulis dist/ di dalamnya -> chown direktorinya (isi sudah
# bun-owned lewat --chown; node_modules tidak disentuh supaya layer murah).
RUN chown bun:bun /app/apps /app/apps/api /app/apps/worker \
    /app/packages /app/packages/core-analytics /app/packages/database \
    /app/packages/financial-clients /app/packages/tsconfig /app/packages/types
# packages di-compile juga: hasil dist/ dipakai runtime untuk memenuhi
# import relatif "./x.js" dari entry TS workspace (lihat catatan di atas).
# Worker belum punya script build -> compile langsung via tsconfig.
RUN bunx tsc -p packages/types/tsconfig.json \
 && bunx tsc -p packages/core-analytics/tsconfig.json \
 && bunx tsc -p packages/database/tsconfig.json \
 && bunx tsc -p packages/financial-clients/tsconfig.json \
 && bunx tsc -p apps/api/tsconfig.json \
 && bunx tsc -p apps/worker/tsconfig.json

# ---------- 3. Production dependencies (tanpa devDeps) ----------
FROM oven/bun:1.4.2 AS prod-deps
WORKDIR /app
COPY --chown=bun:bun package.json bun.lock ./
COPY --chown=bun:bun apps/api/package.json apps/api/
COPY --chown=bun:bun apps/worker/package.json apps/worker/
COPY --chown=bun:bun apps/web/package.json apps/web/
COPY --chown=bun:bun packages/core-analytics/package.json packages/core-analytics/
COPY --chown=bun:bun packages/database/package.json packages/database/
COPY --chown=bun:bun packages/financial-clients/package.json packages/financial-clients/
COPY --chown=bun:bun packages/tsconfig/package.json packages/tsconfig/
COPY --chown=bun:bun packages/types/package.json packages/types/
# Fix yang sama dengan stage deps: /app harus bun-owned sebelum install.
RUN chown -R bun:bun /app
USER bun
# Linker hoisted juga di sini supaya layout node_modules runtime konsisten
# dengan stage deps/build (workspace symlink + dependency di root).
RUN bun install --frozen-lockfile --production --linker=hoisted

# ---------- 4. Migrate (one-shot, devDeps + drizzle-kit dipertahankan) ----------
FROM build AS migrate
ENV NODE_ENV=production
# drizzle-kit adalah devDep packages/database (bin ada di node_modules
# workspace, bukan root). Symlink ke .bin root supaya `bunx drizzle-kit`
# dari /app menemukan versi lokal (0.28.x), bukan mengunduh dari registry.
RUN test -e /app/node_modules/.bin/drizzle-kit \
 || ln -s /app/packages/database/node_modules/.bin/drizzle-kit /app/node_modules/.bin/drizzle-kit
USER bun
# DATABASE_URL disuntik compose (host db). PENTING: drizzle-kit 0.28
# me-resolve `out: "./drizzle"` relatif terhadap CWD (bukan lokasi config),
# jadi WORKDIR harus packages/database supaya meta/_journal.json ketemu.
WORKDIR /app/packages/database
CMD ["bunx", "drizzle-kit", "migrate", "--config", "drizzle.config.ts"]

# ---------- 5. Runtime (node:22-slim, prod-only, non-root) ----------
FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    REPO_ROOT=/app \
    NODE_OPTIONS="--experimental-transform-types --disable-warning=ExperimentalWarning"
WORKDIR /app
# Manifest + node_modules production (termasuk store .bun dan symlink
# workspace relatif) dari stage prod-deps.
COPY --from=prod-deps --chown=node:node /app ./
# Hasil compile api & worker.
COPY --from=build --chown=node:node /app/apps/api/dist apps/api/dist
COPY --from=build --chown=node:node /app/apps/worker/dist apps/worker/dist
# Sumber TS workspace (entry main package.json) + hasil compile di sebelahnya
# supaya import "./x.js" gaya NodeNext resolve ke JS hasil tsc.
COPY --from=build --chown=node:node /app/packages/types/src packages/types/src
COPY --from=build --chown=node:node /app/packages/types/dist/ packages/types/src/
COPY --from=build --chown=node:node /app/packages/core-analytics/src packages/core-analytics/src
COPY --from=build --chown=node:node /app/packages/core-analytics/dist/ packages/core-analytics/src/
COPY --from=build --chown=node:node /app/packages/database/src packages/database/src
COPY --from=build --chown=node:node /app/packages/database/dist/ packages/database/src/
COPY --from=build --chown=node:node /app/packages/financial-clients/src packages/financial-clients/src
COPY --from=build --chown=node:node /app/packages/financial-clients/dist/ packages/financial-clients/src/
USER node
EXPOSE 4000
# Healthcheck default = api; service worker meng-override lewat compose
# (heartbeat /tmp/worker-heartbeat).
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://localhost:4000/api/v1/system/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/api/dist/server.js"]
