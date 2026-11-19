---
name: bun-docker-install-pitfalls
description: Use when bun install or tsc fails inside Docker images.
---

# Bun install di Docker: tiga jebakan yang sudah terbukti (bun 1.4.x)

## 1. ENOENT "failed to link" saat bun install = masalah OWNERSHIP, bukan hardlink

Gejala: `bun install --frozen-lockfile` gagal `ENOENT: failed to link package: X (link)` untuk ratusan package, diawali `failed to symlink dependencies for package: <root> (symlink)`.

Root cause: `WORKDIR /app` dibuat root (755). `COPY --chown=bun:bun` hanya meng-chown FILE yang disalin, BUKAN direktori /app itu sendiri. Sebagai `USER bun`, bun tidak bisa mkdir node_modules di /app; semua link/symlink dilaporkan ENOENT.

Fix (di stage deps, setelah semua COPY, sebelum USER bun):
```dockerfile
RUN chown -R bun:bun /app
USER bun
RUN bun install --frozen-lockfile
```

JANGAN langsung pakai `--backend=copyfile` atau `BUN_INSTALL_CACHE_DIR` — itu tidak memperbaiki direktori yang tidak writable. Bukti diagnosa: `docker run --user bun` dengan direktori kerja buatan bun sendiri sukses install manifest yang sama; replika ownership root-owned mereproduksi kegagalan persis.

Di stage turunan (build), direktori workspace yang SUDAH ADA sejak deps tetap root-owned (COPY --chown tidak mengubah ownership direktori tujuan yang ada). tsc butuh tulis dist/ → chown direktorinya saja (murah, tanpa rekursi ke node_modules):
```dockerfile
RUN chown bun:bun /app/apps /app/apps/api /app/apps/worker /app/packages /app/packages/*
```

## 2. Default linker bun 1.4 = isolated → tsc monorepo gagal TS2580

Gejala: `Cannot find name 'process'` / `Cannot find module 'node:fs'` di package yang TIDAK mendeklarasikan `@types/node` (mis. packages/database), padahal di host lolos.

Root cause: linker isolated menaruh @types/node hanya di node_modules workspace yang mendeklarasikannya; tidak ada di root node_modules/@types. tsc resolusi ke atas tidak menemukannya. (node_modules host lama mungkin dibuat bun versi lama yang hoisted — jangan jadikan host sebagai bukti.)

Fix: `bun install --frozen-lockfile --linker=hoisted` (kompatibel dengan lockfile yang sama; probe membuktikan @types/node muncul di root dan bin drizzle-kit/tsx ikut ter-hoist). Pakai di SEMUA stage install (deps, prod-deps, web deps).

## 3. drizzle-kit 0.28 migrate: `out` relatif CWD, bukan lokasi config

Gejala: `Can't find meta/_journal.json file` padahal folder drizzle ada di image.

Fix: jalankan dari direktori package database:
```dockerfile
WORKDIR /app/packages/database
CMD ["bunx", "drizzle-kit", "migrate", "--config", "drizzle.config.ts"]
```
dan di compose: `working_dir: /app/packages/database` + command yang sama.

## Catatan lain

- `ln -s` bin antar workspace harus idempotent: `test -e target || ln -s ...` (dengan hoisted, bin sering sudah ada di root .bin).
- Legacy builder (tanpa buildx) tetap mem-build multi-stage dengan cache antar target; `docker build --target X` lalu `--target Y` memakai ulang layer deps/build.
- Verifikasi runtime node type-stripping monorepo (main package.json → src/index.ts): healthcheck HTTP dari DALAM container, bukan cuma build sukses.
- Image python pipeline: direktori output relatif cwd (mis. `reports/`) harus dibuat + di-chown ke user non-root di Dockerfile, kalau tidak step training/evaluasi gagal PermissionError dan dilewati diam-diam.
