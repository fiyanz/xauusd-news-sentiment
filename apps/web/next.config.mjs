// @ts-check
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Konfigurasi Next.js untuk produksi (Docker).
 *
 * - output: "standalone" menghasilkan server.js mandiri + node_modules minimal
 *   di .next/standalone, dipakai oleh Dockerfile.web (image ~300MB, bukan
 *   node_modules penuh).
 * - outputFileTracingRoot menunjuk ke root monorepo supaya file workspace
 *   (packages/*) ikut ter-trace ke output standalone.
 *
 * Catatan: tidak ada process.env.NEXT_PUBLIC_* di apps/web/src saat ini,
 * jadi tidak ada build args yang perlu di-inject saat docker build.
 * URL API untuk route handler server-side dibaca dari env runtime
 * API_INTERNAL_URL (lihat compose.yaml), bukan NEXT_PUBLIC.
 */
const nextConfig = {
  output: "standalone",
  outputFileTracingRoot: path.join(__dirname, "../.."),
  poweredByHeader: false,
  reactStrictMode: true,
};

export default nextConfig;
