import fs from "node:fs";
import path from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

/**
 * Muat `.env` dari repo root. Turbo menjalankan task dengan cwd = package,
 * sehingga `.env` di root tidak otomatis terbaca oleh Bun.
 */
function loadEnv(): void {
  const root = process.env.REPO_ROOT
    ? path.resolve(process.env.REPO_ROOT)
    : path.resolve(process.cwd(), "../..");
  const candidates = [path.join(root, ".env"), path.join(process.cwd(), ".env")];

  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    for (const rawLine of fs.readFileSync(file, "utf-8").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
    return;
  }
}

loadEnv();

const connectionString =
  process.env.DATABASE_URL || "postgres://postgres@localhost:5432/xauusd_market";

export const client = postgres(connectionString, { max: 10 });
export const db = drizzle(client, { schema });
export * from "./schema.js";
export { sql, and, desc, eq, lte } from "drizzle-orm";
