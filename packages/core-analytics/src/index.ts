import type { OHLCV, EventReaction } from "@repo/types";

export interface SurpriseResult {
  surpriseVal: number;
  zScore: number;
  isFallback: boolean;
}

export function calculateSurprise(
  actual: number,
  forecast: number | null,
  previous: number | null,
  historicalStdDev: number
): SurpriseResult {
  const std = historicalStdDev > 0 ? historicalStdDev : 1.0;

  if (forecast !== null && !isNaN(forecast)) {
    const surpriseVal = Number((actual - forecast).toFixed(4));
    const zScore = Number((surpriseVal / std).toFixed(2));
    return { surpriseVal, zScore, isFallback: false };
  }

  const prev = previous !== null && !isNaN(previous) ? previous : actual;
  const surpriseVal = Number((actual - prev).toFixed(4));
  const zScore = Number((surpriseVal / std).toFixed(2));
  return { surpriseVal, zScore, isFallback: true };
}

export function calculateReactionWindows(
  releaseId: string,
  releaseTimeUtc: number,
  candles: OHLCV[],
  windows: number[] = [5, 15, 60]
): EventReaction[] {
  if (!candles || candles.length === 0) return [];

  const sorted = [...candles].sort((a, b) => a.timestampUtc - b.timestampUtc);

  const preCandles = sorted.filter((c) => c.timestampUtc < releaseTimeUtc);
  const baseCandle = preCandles[preCandles.length - 1];
  const basePrice = baseCandle ? baseCandle.close : sorted[0]?.open ?? 2700;

  const reactions: EventReaction[] = [];

  for (const windowMins of windows) {
    const windowEndSec = releaseTimeUtc + windowMins * 60;
    const windowCandles = sorted.filter(
      (c) => c.timestampUtc >= releaseTimeUtc && c.timestampUtc <= windowEndSec
    );

    const endCandle = windowCandles[windowCandles.length - 1] || baseCandle;
    const endPrice = endCandle ? endCandle.close : basePrice;

    const deltaPips = Number(((endPrice - basePrice) * 10).toFixed(2));

    let maxHigh = basePrice;
    let minLow = basePrice;

    for (const c of windowCandles) {
      if (c.high > maxHigh) maxHigh = c.high;
      if (c.low < minLow) minLow = c.low;
    }

    const maxSpikePips = Number(((maxHigh - basePrice) * 10).toFixed(2));
    const maxDrawdownPips = Number(((basePrice - minLow) * 10).toFixed(2));

    const postReleaseCandles = sorted.filter(
      (c) => c.timestampUtc > releaseTimeUtc && c.timestampUtc <= releaseTimeUtc + 240 * 60
    );

    let isRetraced = false;
    let retraceMinutes: number | null = null;

    for (const c of postReleaseCandles) {
      if (c.low <= basePrice && c.high >= basePrice) {
        isRetraced = true;
        retraceMinutes = Math.round((c.timestampUtc - releaseTimeUtc) / 60);
        break;
      }
    }

    reactions.push({
      id: `${releaseId}-${windowMins}m`,
      releaseId,
      windowMinutes: windowMins,
      basePrice,
      endPrice,
      deltaPips,
      maxSpikePips,
      maxDrawdownPips,
      isRetraced,
      retraceMinutes,
    });
  }

  return reactions;
}

export interface AggregatedStats {
  totalReleases: number;
  meanDeltaPips: number;
  medianDeltaPips: number;
  directionalConsistency: number; // Percentage 0 - 100
  positiveReactionsPct: number;
  negativeReactionsPct: number;
  avgRetraceMinutes: number | null;
}

export function aggregateEventStats(reactions: EventReaction[]): AggregatedStats {
  if (reactions.length === 0) {
    return {
      totalReleases: 0,
      meanDeltaPips: 0,
      medianDeltaPips: 0,
      directionalConsistency: 0,
      positiveReactionsPct: 0,
      negativeReactionsPct: 0,
      avgRetraceMinutes: null,
    };
  }

  const deltas = reactions.map((r) => r.deltaPips).sort((a, b) => a - b);
  const sum = deltas.reduce((acc, v) => acc + v, 0);
  const meanDeltaPips = Number((sum / deltas.length).toFixed(2));

  const mid = Math.floor(deltas.length / 2);
  const medianDeltaPips =
    deltas.length % 2 !== 0
      ? deltas[mid]!
      : Number((((deltas[mid - 1] ?? 0) + (deltas[mid] ?? 0)) / 2).toFixed(2));

  const positive = deltas.filter((d) => d > 0).length;
  const negative = deltas.filter((d) => d < 0).length;
  const positiveReactionsPct = Number(((positive / deltas.length) * 100).toFixed(1));
  const negativeReactionsPct = Number(((negative / deltas.length) * 100).toFixed(1));

  const directionalConsistency = Math.max(positiveReactionsPct, negativeReactionsPct);

  const retraced = reactions.filter((r) => r.isRetraced && r.retraceMinutes !== null);
  const avgRetraceMinutes =
    retraced.length > 0
      ? Math.round(retraced.reduce((acc, r) => acc + (r.retraceMinutes ?? 0), 0) / retraced.length)
      : null;

  return {
    totalReleases: reactions.length,
    meanDeltaPips,
    medianDeltaPips,
    directionalConsistency,
    positiveReactionsPct,
    negativeReactionsPct,
    avgRetraceMinutes,
  };
}

// ---------------------------------------------------------------------------
// runEventStudy — modul deep event study (satu seam untuk worker & API)
// ---------------------------------------------------------------------------

/** Candle untuk event study: OHLCV + label sintetis opsional (jujur). */
export type EventStudyCandle = OHLCV & { isSimulated?: boolean };

/** Rilis ekonomi dari kalender nyata (stdDev per-event, bukan konstanta). */
export interface EventStudyRelease {
  eventCode: string;
  eventName: string;
  dateUtc: number;
  actual: number | null;
  forecast: number | null;
  previous: number | null;
  historicalStdDev?: number | null;
  isSimulated?: boolean;
}

/**
 * Port candle: window 15m urut naik dengan timestampUtc <= endUtc, maksimum
 * `limit` baris. Modul yang memilih endUtc/limit (pemilihan window disembunyikan
 * di belakang interface); produksi = FinancialClient.fetchXauusdCandles.
 */
export interface EventStudyCandlePort {
  fetchCandlesUpTo(endUtc: number, limit: number): Promise<EventStudyCandle[]>;
}

/** Port kalender: seluruh rilis (urut naik); produksi = CSV enriched. */
export interface EventStudyCalendarPort {
  fetchReleases(): Promise<EventStudyRelease[]>;
}

export interface EventStudyPorts {
  candles: EventStudyCandlePort;
  calendar: EventStudyCalendarPort;
  now?: () => number; // epoch detik; injectable untuk tes
}

export interface HistoricalEventLog {
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

export interface EventStudyReleaseResult {
  /** Id kanonik rilis: rel-<CODE>-<epoch> (sama dengan releaseId reaksi). */
  releaseId: string;
  release: EventStudyRelease;
  isFuture: boolean;
  surprise: SurpriseResult | null;
  reactions: EventReaction[];
}

export interface EventStudyReport {
  eventCode: string;
  status: "ok" | "unavailable";
  reason: string | null;
  surprise: SurpriseResult | null;
  reactions: EventReaction[];
  aggregatedStats: AggregatedStats | null;
  historicalLogs: HistoricalEventLog[];
  dataQuality: {
    candleSource: "real" | "simulated";
    eventsWithActual: number;
    totalEvents: number;
  };
  /** Hasil per rilis (untuk persistensi worker); urut rilis terbaru dulu. */
  releaseResults: EventStudyReleaseResult[];
}

const EVENT_STUDY_WINDOWS = [5, 15, 60];
const EVENT_STUDY_LOG_LIMIT = 10;
const EVENT_STUDY_CANDLE_WINDOW = 400;
/** Window candle menutup sampai 1j15m SETELAH rilis (reaksi pasca-rilis). */
const EVENT_STUDY_WINDOW_END_OFFSET = 3600 + 900;

export function formatDate(timestampUtc: number): string {
  return new Date(timestampUtc * 1000).toISOString().slice(0, 10);
}

function formatSurprise(surprise: SurpriseResult): string {
  const sign = surprise.surpriseVal > 0 ? "+" : "";
  return `${sign}${surprise.surpriseVal.toFixed(2)} (${sign}${surprise.zScore.toFixed(2)}σ)`;
}

/**
 * Interface utama: event study satu kode event (mis. "NFP") atas rilis
 * terbaru kalender. Menyembunyikan pemilihan window candle (event+1j15m,
 * 400 baris 15m), sumber stdDev (historicalStdDev nyata per rilis), dan
 * agregasi stats. Dependensi di-inject (candles, calendar, now) — modul
 * tidak membuat I/O sendiri; worker & API adalah dua adapter di seam ini.
 */
export async function runEventStudy(
  eventCode: string,
  ports: EventStudyPorts
): Promise<EventStudyReport> {
  const code = eventCode.toUpperCase();
  const nowSec = (ports.now ?? (() => Math.floor(Date.now() / 1000)))();
  const releases = await ports.calendar.fetchReleases();
  const matched = releases
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
      dataQuality: { candleSource: "real", eventsWithActual: 0, totalEvents: 0 },
      releaseResults: [],
    };
  }

  // Surprise hanya dari stdDev NYATA per rilis (> 0). Tanpa stdDev valid ->
  // null (jujur), bukan angka pengganti 0.2 atau fallback diam-diam.
  function surpriseOf(event: EventStudyRelease): SurpriseResult | null {
    if (
      event.actual === null ||
      event.historicalStdDev === null ||
      event.historicalStdDev === undefined ||
      event.historicalStdDev <= 0
    ) {
      return null;
    }
    return calculateSurprise(event.actual, event.forecast, event.previous, event.historicalStdDev);
  }

  const latestWithActual = matched.find((event) => event.actual !== null) ?? null;
  const surprise = latestWithActual ? surpriseOf(latestWithActual) : null;

  const historicalLogs: HistoricalEventLog[] = [];
  const allReactions: EventReaction[] = [];
  const releaseResults: EventStudyReleaseResult[] = [];
  let latestReactions: EventReaction[] = [];
  let simulatedCandleUsed = false;

  for (const event of matched.slice(0, EVENT_STUDY_LOG_LIMIT)) {
    const isFuture = event.dateUtc > nowSec;
    const releaseId = `rel-${code}-${event.dateUtc}`;
    let reactions: EventReaction[] = [];
    if (!isFuture) {
      // Window candle harus mencakup SETELAH rilis (reaksi harga pasca-rilis),
      // bukan hanya candle sebelum waktu rilis / candle terbaru saat ini.
      const windowEnd = event.dateUtc + EVENT_STUDY_WINDOW_END_OFFSET;
      const window = await ports.candles.fetchCandlesUpTo(windowEnd, EVENT_STUDY_CANDLE_WINDOW);
      const windowIsSimulated =
        window.length > 0 && window.every((candle) => candle.isSimulated === true);
      if (windowIsSimulated) {
        // Candle sintetis ditandai jujur — tidak dipakai menghitung reaksi.
        simulatedCandleUsed = true;
      } else if (window.length > 0) {
        reactions = calculateReactionWindows(releaseId, event.dateUtc, window, EVENT_STUDY_WINDOWS);
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
    const eventSurprise = surpriseOf(event);

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
    releaseResults.push({ releaseId, release: event, isFuture, surprise: eventSurprise, reactions });
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
    releaseResults,
  };
}
