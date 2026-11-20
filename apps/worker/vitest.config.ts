/**
 * Konfigurasi vitest untuk apps/worker.
 *
 * Sengaja tanpa import `defineConfig`: vitest dijalankan via `bunx vitest@2.1.9`
 * (versi sama dengan repo; worker tidak menambah dependency baru ke bun.lock).
 * Tes menulis ke test/*.test.ts dan menguji module di INTERFACE-nya dengan
 * adapter in-memory (pola sama dengan packages/financial-clients/test).
 */
export default {
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
};