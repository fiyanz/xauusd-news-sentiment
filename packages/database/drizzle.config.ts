import { defineConfig } from "drizzle-kit";

/**
 * Konfigurasi Drizzle untuk PostgreSQL.
 *
 * Pakai migration, bukan `push`, supaya perubahan skema bisa di-review:
 *   bun run db:generate   # menghasilkan SQL di ./drizzle
 *   bun run db:migrate    # menerapkan migration ke DATABASE_URL
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      "postgres://postgres:postgres@localhost:5432/xauusd_market",
  },
});
