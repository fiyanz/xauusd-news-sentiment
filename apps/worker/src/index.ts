import fs from "node:fs";
import { FinancialClient, DerivClient } from "@repo/financial-clients";
import { db, priceCandles, sql } from "@repo/database";
import {
  calculateSurprise,
  calculateReactionWindows,
  aggregateEventStats,
} from "@repo/core-analytics";
import { ingestNewsCorpus } from "./news-db.js";
import { healAllCandleGaps } from "./candle-gap-service.js";

const client = new FinancialClient();

/**
 * Sentiment-analysis sekarang service HTTP terpisah (bukan spawn uv lokal).
 * Semua akses pipeline/prediksi lewat URL ini sesuai kontrak deploy.
 */
const SENTIMENT_SERVICE_URL = (
  process.env.SENTIMENT_SERVICE_URL || "http://localhost:8000"
).replace(/\/+$/, "");
const SYNC_POLL_INTERVAL_MS = 10_000;
const SYNC_TIMEOUT_MS = 20 * 60 * 1000;
/** Heartbeat worker: dibaca healthcheck container (mtime file). */
const HEARTBEAT_PATH = "/tmp/worker-heartbeat";

interface SyncStatus {
  running: boolean;
  last_started_at: string | null;
  last_finished_at: string | null;
  last_result: "success" | "error" | null;
  last_error: string | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Tulis timestamp epoch ms tiap akhir cycle job (kegagalan tidak menghentikan worker). */
function writeHeartbeat(): void {
  try {
    fs.writeFileSync(HEARTBEAT_PATH, String(Date.now()));
  } catch (error) {
    console.warn(
      `[Worker] Gagal menulis heartbeat: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Trigger pipeline sentiment lewat POST /sync, lalu poll GET /sync/status
 * tiap 10 detik sampai running=false (maks 20 menit). 409 berarti sync sudah
 * berjalan di service -> tetap tunggu sampai selesai. Prediksi akhir dibaca
 * dari GET /prediction (tidak lagi dari file).
 */
async function syncSentimentPipeline(): Promise<void> {
  try {
    const res = await fetch(`${SENTIMENT_SERVICE_URL}/sync`, {
      method: "POST",
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 409) {
      console.log("[Worker] Sentiment sync sudah berjalan (409) — menunggu selesai.");
    } else if (!res.ok) {
      console.warn(`[Worker] POST /sync ditolak sentiment service: HTTP ${res.status}.`);
      return;
    } else {
      console.log(`[Worker] Sentiment sync diterima service (HTTP ${res.status}).`);
    }
  } catch (error) {
    console.warn(
      `[Worker] Sentiment service tidak bisa dihubungi (${SENTIMENT_SERVICE_URL}): ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return;
  }

  const deadline = Date.now() + SYNC_TIMEOUT_MS;
  let finished = false;
  while (Date.now() < deadline) {
    await sleep(SYNC_POLL_INTERVAL_MS);
    try {
      const res = await fetch(`${SENTIMENT_SERVICE_URL}/sync/status`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) continue;
      const status = (await res.json()) as SyncStatus;
      if (!status.running) {
        finished = true;
        if (status.last_result === "error") {
          console.warn(
            `[Worker] Sentiment sync selesai dengan error: ${status.last_error ?? "tidak diketahui"}`
          );
        } else {
          console.log("[Worker] Sentiment sync selesai.");
        }
        break;
      }
    } catch {
      // Service sempat tidak merespons; coba lagi di poll berikutnya.
    }
  }
  if (!finished) {
    console.warn("[Worker] Sentiment sync melewati batas 20 menit — lanjut tanpa menunggu.");
  }

  // Log prediksi terbaru dari service (bukan baca file lagi).
  try {
    const res = await fetch(`${SENTIMENT_SERVICE_URL}/prediction`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const pred = (await res.json()) as {
        signal?: string;
        sentiment_label?: string;
        predicted_target_price?: number;
        predicted_pips_delta?: number;
      };
      console.log(
        `[Worker] AI Model 4H Forecast: ${pred.signal} (${pred.sentiment_label}) | Target: $${pred.predicted_target_price} (${pred.predicted_pips_delta})`
      );
    } else {
      console.warn(`[Worker] GET /prediction: HTTP ${res.status} (prediksi belum tersedia).`);
    }
  } catch (error) {
    console.warn(
      `[Worker] GET /prediction gagal: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

const DERIV_APP_ID = process.env.DERIV_APP_ID ?? "";
const DERIV_SYMBOL = "frxXAUUSD";

/**
 * Candle historis dari Deriv (CFD Gold/USD) -> price_candles.
 * Tick live tidak disimpan di sini; yang disimpan candle 15m/30m/1h/4h.
 * Deriv candles tidak membawa volume -> 0 (tidak diketahui), bukan angka karangan.
 * Gagal per timeframe tidak menggagalkan job lain.
 */
async function syncDerivCandles(): Promise<void> {
  if (!DERIV_APP_ID) {
    console.warn("[Worker] DERIV_APP_ID kosong — candle Deriv dilewati.");
    return;
  }

  const deriv = new DerivClient({ appId: DERIV_APP_ID, symbol: DERIV_SYMBOL });
  try {
    // Gap-healing sadar-gap: tutup bolong candle akibat server mati/reconnect
    // (MAX(timestamp_utc) -> now) sebelum live lanjut. Lihat candle-gap-service.
    await healAllCandleGaps(deriv, DERIV_SYMBOL);
  } finally {
    deriv.close();
  }
}

async function runIngestionJob() {
  const start = Date.now();
  console.log("[Worker] Starting Scheduled Data Pipeline...");

  try {
    // 0. Candle historis Deriv (15m/30m/1h/4h) -> price_candles
    await syncDerivCandles();

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
          // Jujur: baris ini dari CSV/sintetis FinancialClient, bukan Deriv.
          source: c.isSimulated ? "simulated" : "csv-historical",
        }));
        await db
          .insert(priceCandles)
          .values(rows)
          .onConflictDoUpdate({
            target: priceCandles.id,
            set: {
              open: sql`EXCLUDED.open`,
              high: sql`EXCLUDED.high`,
              low: sql`EXCLUDED.low`,
              close: sql`EXCLUDED.close`,
              volume: sql`EXCLUDED.volume`,
              // Label mengikuti nilai yang ditulis (provenance tetap jujur).
              source: sql`EXCLUDED.source`,
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

    // 5. Trigger Macro-Sentiment & Price Pipeline Sync via HTTP sentiment service
    console.log("[Worker] Running Macro-Sentiment Pipeline Sync (HTTP)...");
    await syncSentimentPipeline();

    // 6. Ingest corpus berita ke news_articles (watermark + batch 1000, dedup url)
    try {
      await ingestNewsCorpus();
    } catch (error) {
      console.warn(
        `[Worker] Ingest news corpus gagal: ${error instanceof Error ? error.message : String(error)}`
      );
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
    // Heartbeat tiap akhir cycle (sukses maupun gagal) untuk healthcheck container.
    writeHeartbeat();
    const intervalSec = process.env.NODE_ENV === "production" ? 15 * 60 : 5 * 60;
    setTimeout(scheduleNextJob, intervalSec * 1000);
  }
}

// Run immediately on start, then recursively schedule with safe cadence
await scheduleNextJob();
