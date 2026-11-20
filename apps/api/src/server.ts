/**
 * Bootstrap tipis API: loadEnv -> Fastify -> cors -> register plugin domain
 * -> listen. Seluruh logika route/feed tinggal di module domain masing-masing
 * (routes/* = adapter tipis per domain, feed/deriv-sse = module deep SSE).
 */
import fs from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { FinancialClient } from "@repo/financial-clients";

/** Muat `.env` dari repo root (turbo menjalankan task dengan cwd = package). */
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

// Plugin domain di-import SETELAH loadEnv() supaya konstanta env di module
// (DERIV_APP_ID, WEB_ORIGIN, SENTIMENT_SERVICE_URL, PIPELINE_SYNC_TOKEN)
// terbaca pada titik yang sama dengan monolith lama (urutan tidak berubah).
const { default: systemRoutes } = await import("./routes/system.js");
const { default: marketRoutes } = await import("./routes/market.js");
const { default: derivSseRoutes } = await import("./feed/deriv-sse.js");
const { default: calendarRoutes } = await import("./routes/calendar.js");
const { default: analyticsRoutes } = await import("./routes/analytics.js");
const { default: reportsRoutes } = await import("./routes/reports.js");
const { default: newsRoutes } = await import("./routes/news.js");
const { default: pipelineRoutes } = await import("./routes/pipeline.js");

const fastify = Fastify({ logger: true });
const client = new FinancialClient();

/**
 * Origin web yang diizinkan. Default localhost:3000; bisa daftar dipisah koma
 * via WEB_ORIGIN (mis. "http://localhost:3000,https://domain.com").
 */
const WEB_ORIGIN = (process.env.WEB_ORIGIN || "http://localhost:3000")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

await fastify.register(cors, {
  origin: WEB_ORIGIN,
});

await fastify.register(systemRoutes);
await fastify.register(marketRoutes, { client });
await fastify.register(derivSseRoutes);
await fastify.register(calendarRoutes, { client });
await fastify.register(analyticsRoutes, { client });
await fastify.register(reportsRoutes, { client });
await fastify.register(newsRoutes);
await fastify.register(pipelineRoutes);

const port = Number(process.env.PORT_API) || 4000;
try {
  await fastify.listen({ port, host: "0.0.0.0" });
  console.log(`API Server running at http://localhost:${port}`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}