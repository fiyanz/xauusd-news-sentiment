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
