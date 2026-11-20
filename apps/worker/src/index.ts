import fs from "node:fs";
import { FinancialClient, DerivClient } from "@repo/financial-clients";
import { db, sql, eventTypes, economicReleases, eventReactions } from "@repo/database";
import {
  runEventStudy,
  type EventStudyPorts,
  type EventStudyReport,
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
    // (MAX(timestamp_utc) deriv-cfd -> now) sebelum live lanjut. Lihat candle-gap-service.
    await healAllCandleGaps(deriv, DERIV_SYMBOL);
  } finally {
    deriv.close();
  }
}

/**
 * Adapter persistensi hasil event study (worker): event_types ->
 * economic_releases -> event_reactions (urutan hormati FK). Id kanonik dari
 * modul: evt-<CODE>, rel-<CODE>-<epoch>, <releaseId>-<window>m. Upsert
 * idempotent — cycle berikutnya memperbarui nilai, bukan menduplikasi.
 * Hanya rilis LAMPAU dengan actual + surprise nyata (stdDev kalender valid)
 * yang dipersist; rilis masa depan / tanpa stdDev tidak dikarang jadi baris DB.
 */
async function persistEventStudy(
  report: EventStudyReport
): Promise<{ releases: number; reactions: number }> {
  const studied = report.releaseResults.filter((r) => !r.isFuture);
  const first = studied.find((r) => r.release.actual !== null && r.surprise !== null);
  if (!first || first.release.actual === null || first.surprise === null) {
    return { releases: 0, reactions: 0 };
  }
  const stdDev = first.release.historicalStdDev;
  if (stdDev == null || stdDev <= 0) return { releases: 0, reactions: 0 };

  const nowSec = Math.floor(Date.now() / 1000);
  const eventTypeId = `evt-${report.eventCode}`;
  await db
    .insert(eventTypes)
    .values({
      id: eventTypeId,
      code: report.eventCode,
      name: first.release.eventName,
      country: "USD",
      impact: "HIGH",
      historicalStdDev: stdDev,
      createdAt: nowSec,
    })
    .onConflictDoUpdate({
      target: eventTypes.id,
      set: { name: first.release.eventName, historicalStdDev: stdDev },
    });

  let releases = 0;
  let reactions = 0;
  for (const r of studied) {
    if (r.release.actual === null || r.surprise === null) continue;
    await db
      .insert(economicReleases)
      .values({
        id: r.releaseId,
        eventTypeId,
        releaseDateUtc: r.release.dateUtc,
        actual: r.release.actual,
        forecast: r.release.forecast,
        previous: r.release.previous,
        surpriseVal: r.surprise.surpriseVal,
        zScore: r.surprise.zScore,
      })
      .onConflictDoUpdate({
        target: economicReleases.id,
        set: {
          actual: r.release.actual,
          forecast: r.release.forecast,
          previous: r.release.previous,
          surpriseVal: r.surprise.surpriseVal,
          zScore: r.surprise.zScore,
        },
      });
    releases++;
    if (r.reactions.length > 0) {
      const rows = r.reactions.map((x) => ({
        id: x.id,
        releaseId: x.releaseId,
        windowMinutes: x.windowMinutes,
        basePrice: x.basePrice,
        endPrice: x.endPrice,
        deltaPips: x.deltaPips,
        maxSpikePips: x.maxSpikePips,
        maxDrawdownPips: x.maxDrawdownPips,
        isRetraced: x.isRetraced,
        retraceMinutes: x.retraceMinutes,
      }));
      await db
        .insert(eventReactions)
        .values(rows)
        .onConflictDoUpdate({
          target: eventReactions.id,
          set: {
            basePrice: sql`EXCLUDED.base_price`,
            endPrice: sql`EXCLUDED.end_price`,
            deltaPips: sql`EXCLUDED.delta_pips`,
            maxSpikePips: sql`EXCLUDED.max_spike_pips`,
            maxDrawdownPips: sql`EXCLUDED.max_drawdown_pips`,
            isRetraced: sql`EXCLUDED.is_retraced`,
            retraceMinutes: sql`EXCLUDED.retrace_minutes`,
          },
        });
      reactions += rows.length;
    }
  }
  return { releases, reactions };
}

async function runIngestionJob() {
  const start = Date.now();
  console.log("[Worker] Starting Scheduled Data Pipeline...");

  try {
    // 0. Candle historis Deriv (15m/30m/1h/4h) -> price_candles
    await syncDerivCandles();

    // 1. Ingest Economic Calendar
    console.log("[Worker] Fetching economic calendar events...");
    const releases = await client.fetchEconomicCalendar();
    console.log(`[Worker] Synced ${releases.length} economic releases.`);

    // 2. Event study per kode HIGH-impact di seam runEventStudy (core-analytics):
    // stdDev NYATA dari kalender (bukan 0.2 hardcoded) + window candle 15m
    // sekitar tanggal rilis (event+1j15m, 400 baris), bukan 30 candle terakhir.
    // Hasil dipersist ke event_types/economic_releases/event_reactions.
    // Catatan: tulis candle 15m CSV/sintetis (step-1 lama) DIHAPUS — 15m/30m
    // Deriv-only; jalur tulis price_candles kini satu pintu di candle-store.
    const studyCodes = [
      ...new Set(
        releases
          .filter((r) => r.impact === "HIGH" && r.actual !== null)
          .map((r) => r.eventCode)
      ),
    ];
    const studyPorts: EventStudyPorts = {
      candles: {
        fetchCandlesUpTo: (endUtc, limit) => client.fetchXauusdCandles("15m", limit, endUtc),
      },
      calendar: { fetchReleases: async () => releases },
    };
    for (const code of studyCodes) {
      try {
        const report = await runEventStudy(code, studyPorts);
        const persisted = await persistEventStudy(report);
        console.log(
          `[Worker] Event Study [${code}]: Surprise Z=${report.surprise?.zScore ?? "n/a"} (stdDev nyata kalender), ` +
            `Consistency=${report.aggregatedStats?.directionalConsistency ?? 0}% | ` +
            `persist ${persisted.releases} rilis + ${persisted.reactions} reaksi`
        );
      } catch (error) {
        console.warn(
          `[Worker] Event study ${code} gagal: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    // 3. Ingest COT Report
    const cot = await client.fetchLatestCOTReport();
    console.log(
      cot
        ? `[Worker] Synced CFTC COT Report: Net Long Managed Money = ${cot.netPosition} contracts.`
        : "[Worker] CFTC COT Report unavailable (sumber CFTC tidak bisa diakses)."
    );

    // 4. Trigger Macro-Sentiment & Price Pipeline Sync via HTTP sentiment service
    console.log("[Worker] Running Macro-Sentiment Pipeline Sync (HTTP)...");
    await syncSentimentPipeline();

    // 5. Ingest corpus berita ke news_articles (watermark + batch 1000, dedup url)
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
