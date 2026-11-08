import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { FinancialClient } from "@repo/financial-clients";
import {
  calculateSurprise,
  calculateReactionWindows,
  aggregateEventStats,
} from "@repo/core-analytics";
import type { SurpriseResult } from "@repo/core-analytics";
import type { EventReaction } from "@repo/types";
import { COMPLIANCE_DISCLAIMER_FR10 } from "@repo/types";

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

const EVENT_STUDY_WINDOWS = [5, 15, 60];
const EVENT_STUDY_LOG_LIMIT = 10;
const EVENT_STUDY_CANDLE_WINDOW = 400;

interface HistoricalEventLog {
  date: string;
  name: string;
  actual: number | null;
  forecast: number | null;
  previous: number | null;
  surprise: string | null;
  pips: number | null;
  direction: "bullish" | "bearish" | "neutral" | null;
  isSimulated: boolean;
}

function formatSurprise(surprise: SurpriseResult): string {
  const sign = surprise.surpriseVal > 0 ? "+" : "";
  return `${sign}${surprise.surpriseVal.toFixed(2)} (${sign}${surprise.zScore.toFixed(2)}σ)`;
}

function formatDate(timestampUtc: number): string {
  return new Date(timestampUtc * 1000).toISOString().slice(0, 10);
}

fastify.get("/api/v1/system/health", async () => {
  return {
    status: "healthy",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    compliance: "FR-10 Validated",
    dataset: "Historical Expert CSV Active",
  };
});

fastify.get("/api/v1/market/xauusd/latest", async (_request, reply) => {
  const candles = await client.fetchXauusdCandles("15m", 5);
  if (!candles || candles.length === 0) {
    return reply.status(503).send({
      statusCode: 503,
      status: "unavailable",
      reason: "No candles available",
      disclaimer: COMPLIANCE_DISCLAIMER_FR10,
    });
  }
  const latest = candles[candles.length - 1]!;
  const isSimulated = latest.isSimulated === true;
  return {
    symbol: "XAUUSD",
    // Harga acuan = close candle terakhir. Bid/ask TIDAK dibangun karangan:
    // spread nyata tidak tersedia di sumber data.
    price: latest.close,
    bid: null,
    ask: null,
    spread: null,
    timestampUtc: latest.timestampUtc,
    isSimulated,
    status: isSimulated ? "simulated" : "ok",
    disclaimer: COMPLIANCE_DISCLAIMER_FR10,
  };
});

// Windowed Paginated Candles API (prevents browser lag)
fastify.get<{ Querystring: { tf?: string; limit?: string; to?: string } }>(
  "/api/v1/market/xauusd/candles",
  async (request) => {
    const tf = (request.query.tf as any) || "15m";
    const limit = Math.max(1, Math.min(Number(request.query.limit) || 300, 1000)); // capped at 1000 for high performance
    const to = request.query.to ? Number(request.query.to) : undefined;
    const candles = await client.fetchXauusdCandles(tf, limit, to);
    const isSimulated = candles.length > 0 && candles.every((c) => c.isSimulated === true);
    return {
      timeframe: tf,
      count: candles.length,
      data: candles,
      isSimulated,
      status: isSimulated ? "simulated" : "ok",
      disclaimer: COMPLIANCE_DISCLAIMER_FR10,
    };
  }
);

// Server-Sent Events (SSE) for low-overhead real-time price streaming.
// Tick merupakan simulasi mikro di sekitar harga nyata terakhir — ditandai
// `isSimulated: true` dan bukan dianggap sebagai harga pasar.
fastify.get("/api/v1/market/xauusd/stream", async (request, reply) => {
  // Fastify akan menutup response begitu handler selesai; hijack supaya
  // koneksi SSE tetap terbuka untuk tick berkala.
  reply.hijack();
  reply.raw.setHeader("Content-Type", "text/event-stream");
  reply.raw.setHeader("Cache-Control", "no-cache");
  reply.raw.setHeader("Connection", "keep-alive");
  reply.raw.setHeader("Access-Control-Allow-Origin", WEB_ORIGIN[0] ?? "");

  const recent = await client.fetchXauusdCandles("1h", 1);
  const lastReal = recent[recent.length - 1]?.close ?? null;

  if (lastReal === null) {
    reply.raw.write(
      `data: ${JSON.stringify({
        status: "unavailable",
        reason: "Belum ada data harga nyata.",
      })}\n\n`
    );
    return reply.raw.end();
  }

  let basePrice = lastReal;

  const interval = setInterval(() => {
    const delta = (Math.random() - 0.49) * 0.4;
    basePrice = Number((basePrice + delta).toFixed(2));
    const now = Math.floor(Date.now() / 1000);

    const payload = JSON.stringify({
      timestampUtc: now,
      price: basePrice,
      bid: basePrice,
      ask: Number((basePrice + 0.35).toFixed(2)),
      isSimulated: true,
    });

    reply.raw.write(`data: ${payload}\n\n`);
  }, 1500);

  request.raw.on("close", () => {
    clearInterval(interval);
  });
});

fastify.get("/api/v1/calendar/upcoming", async () => {
  const events = await client.fetchEconomicCalendar();

  if (events.length === 0) {
    return {
      status: "unavailable",
      reason:
        "Kalender ekonomi tidak tersedia (economic_calendar_enriched.csv tidak ditemukan).",
      count: 0,
      events: [],
      disclaimer: COMPLIANCE_DISCLAIMER_FR10,
    };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const upcoming = events
    .filter((event) => event.impact === "HIGH" && event.dateUtc >= nowSec - 7 * 86400)
    .slice(-100);

  return {
    status: "ok",
    count: upcoming.length,
    events: upcoming,
    disclaimer: COMPLIANCE_DISCLAIMER_FR10,
  };
});

fastify.get<{ Params: { eventCode: string } }>(
  "/api/v1/analytics/event-study/:eventCode",
  async (request) => {
    const { eventCode } = request.params;
    const code = eventCode.toUpperCase();
    const nowSec = Math.floor(Date.now() / 1000);

    const events = await client.fetchEconomicCalendar();
    const matched = events
      .filter((event) => event.eventCode.toUpperCase() === code)
      .sort((a, b) => b.dateUtc - a.dateUtc);

    if (matched.length === 0) {
      return {
        eventCode: code,
        status: "unavailable",
        reason: `Tidak ada data kalender nyata untuk event "${code}".`,
        surprise: null,
        reactions: [],
        aggregatedStats: null,
        historicalLogs: [],
        disclaimer: COMPLIANCE_DISCLAIMER_FR10,
      };
    }

    // Surprise dihitung dari actual/forecast/previous nyata pada rilis terbaru
    // yang memiliki actual. Tidak ada angka pengganti.
    const latestWithActual = matched.find((event) => event.actual !== null) ?? null;
    let surprise: SurpriseResult | null = null;
    if (latestWithActual && latestWithActual.actual !== null) {
      const stdDev = latestWithActual.historicalStdDev;
      if (stdDev !== null && stdDev !== undefined && stdDev > 0) {
        surprise = calculateSurprise(
          latestWithActual.actual,
          latestWithActual.forecast,
          latestWithActual.previous,
          stdDev
        );
      }
    }

    const historicalLogs: HistoricalEventLog[] = [];
    const allReactions: EventReaction[] = [];
    let latestReactions: EventReaction[] = [];
    let simulatedCandleUsed = false;

    for (const event of matched.slice(0, EVENT_STUDY_LOG_LIMIT)) {
      const isFuture = event.dateUtc > nowSec;
      let reactions: EventReaction[] = [];

      if (!isFuture) {
        // Jendela candle harus mencakup SETELAH rilis (reaki harga pasca-rilis),
        // bukan hanya candle sebelum waktu rilis.
        const windowEnd = event.dateUtc + 3600 + 900;
        const window = await client.fetchXauusdCandles(
          "15m",
          EVENT_STUDY_CANDLE_WINDOW,
          windowEnd
        );
        const windowIsSimulated =
          window.length > 0 && window.every((candle) => candle.isSimulated === true);

        if (windowIsSimulated) {
          simulatedCandleUsed = true;
        } else if (window.length > 0) {
          reactions = calculateReactionWindows(
            `rel-${code}-${event.dateUtc}`,
            event.dateUtc,
            window,
            EVENT_STUDY_WINDOWS
          );
        }
      }

      if (reactions.length > 0) {
        const reaction15 = reactions.find((r) => r.windowMinutes === 15) ?? null;
        if (reaction15) allReactions.push(reaction15);
        if (latestReactions.length === 0) latestReactions = reactions;
      }

      const reaction15 = reactions.find((r) => r.windowMinutes === 15) ?? null;
      const pips = reaction15 ? reaction15.deltaPips : null;
      const direction =
        pips === null ? null : pips > 0 ? "bullish" : pips < 0 ? "bearish" : "neutral";

      const eventSurprise =
        event.actual !== null &&
        event.historicalStdDev !== null &&
        event.historicalStdDev !== undefined &&
        event.historicalStdDev > 0
          ? calculateSurprise(event.actual, event.forecast, event.previous, event.historicalStdDev)
          : null;

      historicalLogs.push({
        date: formatDate(event.dateUtc),
        name: event.eventName,
        actual: event.actual,
        forecast: event.forecast,
        previous: event.previous,
        surprise: eventSurprise ? formatSurprise(eventSurprise) : null,
        pips,
        direction,
        isSimulated: event.isSimulated === true,
      });
    }

    const hasUsableData = surprise !== null || allReactions.length > 0;

    return {
      eventCode: code,
      status: hasUsableData ? "ok" : "unavailable",
      reason: hasUsableData
        ? null
        : "Tidak ada data actual maupun candle nyata yang bisa dihitung untuk event ini.",
      surprise,
      reactions: latestReactions,
      aggregatedStats: allReactions.length > 0 ? aggregateEventStats(allReactions) : null,
      historicalLogs: hasUsableData ? historicalLogs : [],
      dataQuality: {
        candleSource: simulatedCandleUsed ? "simulated" : "real",
        eventsWithActual: matched.filter((event) => event.actual !== null).length,
        totalEvents: matched.length,
      },
      disclaimer: COMPLIANCE_DISCLAIMER_FR10,
    };
  }
);

fastify.get("/api/v1/reports/cot/latest", async () => {
  const cot = await client.fetchLatestCOTReport();

  if (!cot) {
    return {
      status: "unavailable",
      reason: "Laporan CFTC COT tidak bisa diakses (sumber: cftc.gov/dea/newcot/deafut.txt).",
      report: null,
      disclaimer: COMPLIANCE_DISCLAIMER_FR10,
    };
  }

  return {
    status: "ok",
    report: cot,
    source: "CFTC Commitments of Traders — Futures Only (deafut.txt)",
    disclaimer: COMPLIANCE_DISCLAIMER_FR10,
  };
});

fastify.get("/api/v1/reports/daily/latest", async () => {
  const now = new Date().toISOString().split("T")[0]!;
  const candles = await client.fetchXauusdCandles("1h", 24 * 7);

  if (candles.length === 0) {
    return {
      date: now,
      status: "unavailable",
      reason: "Data candle XAUUSD tidak tersedia.",
      markdownContent: null,
      complianceDisclaimer: COMPLIANCE_DISCLAIMER_FR10,
    };
  }

  const isSimulated = candles.every((candle) => candle.isSimulated === true);
  const first = candles[0]!;
  const last = candles[candles.length - 1]!;
  const high = Math.max(...candles.map((candle) => candle.high));
  const low = Math.min(...candles.map((candle) => candle.low));
  const changePct = ((last.close - first.open) / first.open) * 100;

  const cot = await client.fetchLatestCOTReport();
  const events = await client.fetchEconomicCalendar(30);
  const nowSec = Math.floor(Date.now() / 1000);
  const upcoming = events.filter((event) => event.dateUtc >= nowSec - 7 * 86400).slice(-8);

  const lines: string[] = [];
  lines.push(`# Ringkasan Harian Pasar Emas (XAUUSD) — ${now}`);
  lines.push("");
  lines.push(
    `> Sumber harga: ${
      isSimulated ? "CANDLE SINTETIS (dataset historis tidak tersedia)" : "dataset historis XAUUSD H1"
    }.`
  );
  lines.push("");
  lines.push("## 1. Pergerakan Harga (7 hari terakhir)");
  lines.push(
    `- Close terakhir: ${last.close.toFixed(2)} (${new Date(last.timestampUtc * 1000).toISOString()})`
  );
  lines.push(`- Rentang 7 hari: ${low.toFixed(2)} – ${high.toFixed(2)}`);
  lines.push(`- Perubahan: ${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%`);
  lines.push("");
  lines.push("## 2. Kalender Ekonomi (rilis terbaru / akan datang)");
  if (upcoming.length === 0) {
    lines.push("- Tidak ada data kalender yang tersedia.");
  } else {
    for (const event of upcoming) {
      const actual = event.actual === null ? "n/a" : event.actual;
      const forecast = event.forecast === null ? "n/a" : event.forecast;
      const simulated = event.isSimulated ? " (simulated)" : "";
      lines.push(
        `- ${formatDate(event.dateUtc)} — ${event.eventName}: actual ${actual}, forecast ${forecast}${simulated}`
      );
    }
  }
  lines.push("");
  lines.push("## 3. Posisi Institusional CFTC COT");
  if (cot) {
    lines.push(`- Tanggal laporan: ${cot.reportDate}`);
    lines.push(
      `- Non-commercial net: ${cot.netPosition > 0 ? "+" : ""}${cot.netPosition.toLocaleString("id-ID")} kontrak`
    );
    lines.push(
      `- Perubahan mingguan: ${cot.changeNet > 0 ? "+" : ""}${cot.changeNet.toLocaleString("id-ID")} kontrak`
    );
    lines.push(`- Sumber: cftc.gov/dea/newcot/deafut.txt`);
  } else {
    lines.push("- Data COT tidak tersedia (sumber CFTC tidak bisa diakses).");
  }
  lines.push("");
  lines.push(`_${COMPLIANCE_DISCLAIMER_FR10}_`);

  return {
    date: now,
    status: "ok",
    markdownContent: lines.join("\n"),
    sources: {
      candles: isSimulated ? "simulated" : "expert-dataset-h1",
      calendar: events.length > 0 ? "economic_calendar_enriched.csv" : "unavailable",
      cot: cot ? "cftc.gov/dea/newcot/deafut.txt" : "unavailable",
    },
    complianceDisclaimer: COMPLIANCE_DISCLAIMER_FR10,
  };
});

function repoRoot(): string {
  return process.env.REPO_ROOT
    ? path.resolve(process.env.REPO_ROOT)
    : path.resolve(process.cwd(), "../..");
}

function getPythonServiceDir(): string {
  const direct = path.resolve(process.cwd(), "services/sentiment-analysis");
  if (fs.existsSync(direct)) return direct;
  const fromApps = path.resolve(process.cwd(), "../../services/sentiment-analysis");
  if (fs.existsSync(fromApps)) return fromApps;
  return path.resolve(repoRoot(), "services/sentiment-analysis");
}

fastify.get("/api/v1/analytics/macro-sentiment/latest", async () => {
  const pythonServiceDir = getPythonServiceDir();
  const predFile = path.join(pythonServiceDir, "data/processed/latest_prediction.json");

  if (fs.existsSync(predFile)) {
    try {
      const pred = JSON.parse(fs.readFileSync(predFile, "utf-8"));
      return {
        ...pred,
        status: "ok",
        disclaimer: COMPLIANCE_DISCLAIMER_FR10,
      };
    } catch {
      // File ada tapi rusak -> unavailable (bukan angka karangan).
    }
  }

  return {
    status: "unavailable",
    reason:
      "latest_prediction.json belum tersedia atau tidak bisa dibaca — pipeline sentiment-analysis belum dijalankan.",
    model_champion: null,
    current_price: null,
    prediction_horizon: null,
    predicted_return_pct: null,
    predicted_target_price: null,
    predicted_pips_delta: null,
    signal: null,
    sentiment_label: null,
    confidence_pct: null,
    macro_drivers: null,
    disclaimer: COMPLIANCE_DISCLAIMER_FR10,
  };
});

let isSyncRunning = false;
const PIPELINE_SYNC_TOKEN = process.env.PIPELINE_SYNC_TOKEN || "";
const PIPELINE_SYNC_TIMEOUT_MS =
  Number(process.env.PIPELINE_SYNC_TIMEOUT_MS) || 15 * 60 * 1000;

fastify.post("/api/v1/pipeline/sync", async (request, reply) => {
  if (!PIPELINE_SYNC_TOKEN) {
    return reply.status(503).send({
      statusCode: 503,
      status: "disabled",
      error: "Service Unavailable",
      reason:
        "PIPELINE_SYNC_TOKEN tidak diset; endpoint sync dinonaktifkan untuk mencegah penyalahgunaan.",
      timestamp: new Date().toISOString(),
    });
  }

  const rawToken = request.headers["x-pipeline-token"];
  const providedToken = Array.isArray(rawToken) ? undefined : rawToken;
  if (providedToken !== PIPELINE_SYNC_TOKEN) {
    return reply.status(401).send({
      statusCode: 401,
      status: "unauthorized",
      error: "Unauthorized",
      reason: "Header x-pipeline-token tidak valid.",
      timestamp: new Date().toISOString(),
    });
  }

  if (isSyncRunning) {
    return reply.status(409).send({
      statusCode: 409,
      error: "Conflict",
      message: "Pipeline sync already in progress.",
      timestamp: new Date().toISOString(),
    });
  }

  const pythonServiceDir = getPythonServiceDir();
  if (fs.existsSync(pythonServiceDir)) {
    isSyncRunning = true;
    const proc = spawn("uv", ["run", "python", "-m", "src.pipeline.sync"], {
      cwd: pythonServiceDir,
      stdio: "ignore",
    });

    // Batas waktu maksimal: cegah proses menggantung memblokir endpoint selamanya.
    const killTimer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // Proses sudah keluar.
      }
    }, PIPELINE_SYNC_TIMEOUT_MS);

    const clearRun = () => {
      clearTimeout(killTimer);
      isSyncRunning = false;
    };
    proc.on("exit", clearRun);
    proc.on("error", clearRun);

    return {
      status: "sync_dispatched",
      message: "Automated macro-sentiment pipeline sync triggered in background.",
      timestamp: new Date().toISOString(),
    };
  }

  return reply.status(404).send({
    statusCode: 404,
    status: "service_not_found",
    timestamp: new Date().toISOString(),
  });
});

const port = Number(process.env.PORT_API) || 4000;
try {
  await fastify.listen({ port, host: "0.0.0.0" });
  console.log(`API Server running at http://localhost:${port}`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
