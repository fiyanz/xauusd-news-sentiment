import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { FinancialClient } from "@repo/financial-clients";
import { db, priceCandles, sql } from "@repo/database";
import {
  calculateSurprise,
  calculateReactionWindows,
  aggregateEventStats,
} from "@repo/core-analytics";

const client = new FinancialClient();

function getPythonServiceDir(): string {
  const direct = path.resolve(process.cwd(), "services/sentiment-analysis");
  if (fs.existsSync(direct)) return direct;
  const fromApps = path.resolve(process.cwd(), "../../services/sentiment-analysis");
  if (fs.existsSync(fromApps)) return fromApps;
  return "/home/kazu/Projects/magang/sistem-informasi-market-xauusd/services/sentiment-analysis";
}

async function runIngestionJob() {
  const start = Date.now();
  console.log("[Worker] Starting Scheduled Data Pipeline...");

  try {
    // 1. Ingest XAUUSD Candles
    console.log("[Worker] Fetching XAUUSD multi-timeframe candles...");
    const candles15m = await client.fetchXauusdCandles("15m", 30);
    console.log(`[Worker] Synced ${candles15m.length} candles for 15m timeframe.`);

    // Batch DB persistence (Warm Path)
    try {
      if (candles15m.length > 0) {
        const rows = candles15m.map((c) => ({
          id: `${c.symbol}_${c.timeframe}_${c.timestampUtc}`,
          symbol: c.symbol,
          timeframe: c.timeframe,
          timestampUtc: c.timestampUtc,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume,
        }));
        await db
          .insert(priceCandles)
          .values(rows)
          .onConflictDoUpdate({
            target: priceCandles.id,
            set: {
              high: sql`EXCLUDED.high`,
              low: sql`EXCLUDED.low`,
              close: sql`EXCLUDED.close`,
              volume: sql`EXCLUDED.volume`,
            },
          });
        console.log(`[Worker] Persisted batch of ${rows.length} candles to PostgreSQL.`);
      }
    } catch (dbErr: any) {
      console.warn(`[Worker] Database batch persist notice: ${dbErr?.message || dbErr}`);
    }

    // 2. Ingest Economic Calendar
    console.log("[Worker] Fetching economic calendar events...");
    const releases = await client.fetchEconomicCalendar();
    console.log(`[Worker] Synced ${releases.length} economic releases.`);

    // 3. Process Event Study for High Impact
    for (const rel of releases) {
      if (rel.impact === "HIGH" && rel.actual !== null) {
        const surprise = calculateSurprise(rel.actual, rel.forecast, rel.previous, 0.2);
        const reactions = calculateReactionWindows(
          `rel-${rel.eventCode}`,
          rel.dateUtc,
          candles15m,
          [5, 15, 60]
        );
        const stats = aggregateEventStats(reactions);
        console.log(
          `[Worker] Event Study [${rel.eventCode}]: Surprise Z=${surprise.zScore}, Consistency=${stats.directionalConsistency}%`
        );
      }
    }

    // 4. Ingest COT Report
    const cot = await client.fetchLatestCOTReport();
    console.log(
      cot
        ? `[Worker] Synced CFTC COT Report: Net Long Managed Money = ${cot.netPosition} contracts.`
        : "[Worker] CFTC COT Report unavailable (sumber CFTC tidak bisa diakses)."
    );

    // 5. Trigger Python Macro-Sentiment & Price Pipeline Sync
    const pythonServiceDir = getPythonServiceDir();
    if (fs.existsSync(pythonServiceDir)) {
      console.log("[Worker] Running Python Macro-Sentiment Pipeline Sync...");
      await new Promise<void>((resolve) => {
        const proc = spawn("uv", ["run", "python", "-m", "src.pipeline.sync"], {
          cwd: pythonServiceDir,
          stdio: "ignore",
        });
        proc.on("close", () => resolve());
        proc.on("error", () => resolve());
      });

      const predFile = path.join(pythonServiceDir, "data/processed/latest_prediction.json");
      if (fs.existsSync(predFile)) {
        const pred = JSON.parse(fs.readFileSync(predFile, "utf-8"));
        console.log(
          `[Worker] AI Model 4H Forecast: ${pred.signal} (${pred.sentiment_label}) | Target: $${pred.predicted_target_price} (${pred.predicted_pips_delta})`
        );
      }
    }

    const duration = Date.now() - start;
    console.log(`[Worker] Ingestion Pipeline Finished Successfully in ${duration}ms.\n`);
  } catch (err) {
    console.error("[Worker] Pipeline Failed:", err);
  }
}

let isJobRunning = false;

async function scheduleNextJob() {
  if (isJobRunning) {
    console.warn("[Worker] Ingestion job already running, skipping overlapping execution.");
    return;
  }
  isJobRunning = true;
  try {
    await runIngestionJob();
  } finally {
    isJobRunning = false;
    const intervalSec = process.env.NODE_ENV === "production" ? 15 * 60 : 5 * 60;
    setTimeout(scheduleNextJob, intervalSec * 1000);
  }
}

// Run immediately on start, then recursively schedule with safe cadence
await scheduleNextJob();
