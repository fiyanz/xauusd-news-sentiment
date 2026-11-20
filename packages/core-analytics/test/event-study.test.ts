/**
 * Tes runEventStudy di INTERFACE (bukan internal): fake calendar + fake
 * candle port = adapter kedua di seam yang sama dengan produksi (worker &
 * api memakai FinancialClient). Memastikan stdDev nyata dari kalender
 * (bukan 0.2 hardcoded) dan window candle di sekitar tanggal rilis
 * (bukan 30 candle 15m terakhir).
 */
import { describe, it, expect } from "vitest";
import {
  runEventStudy,
  type EventStudyRelease,
  type EventStudyCandle,
  type EventStudyCalendarPort,
  type EventStudyCandlePort,
} from "../src/index.js";

/** Fake kalender: kembalikan rilis apa adanya (urut naik seperti produksi). */
function fakeCalendar(releases: EventStudyRelease[]): EventStudyCalendarPort {
  return { async fetchReleases() { return [...releases]; } };
}

/** Fake candle: window ts <= endUtc, urut naik, maksimum limit; rekam panggilan. */
function fakeCandles(series: EventStudyCandle[]) {
  const asc = [...series].sort((a, b) => a.timestampUtc - b.timestampUtc);
  const calls: { endUtc: number; limit: number }[] = [];
  const port: EventStudyCandlePort & { calls: { endUtc: number; limit: number }[] } = {
    calls,
    async fetchCandlesUpTo(endUtc, limit) {
      calls.push({ endUtc, limit });
      return asc.filter((c) => c.timestampUtc <= endUtc).slice(-limit);
    },
  };
  return port;
}

function release(overrides: Partial<EventStudyRelease> = {}): EventStudyRelease {
  return {
    eventCode: "NFP",
    eventName: "Non-Farm Employment Change",
    dateUtc: T,
    actual: 0.4,
    forecast: 0.3,
    previous: 0.3,
    historicalStdDev: 0.1,
    isSimulated: false,
    ...overrides,
  };
}

/** Grid candle 15m di sekitar rilis T (base = close T-900 = 2730). */
const T = 1_700_000_000;
function candle(ts: number, close: number, high = close + 1, low = close - 1): EventStudyCandle {
  return {
    symbol: "XAUUSD",
    timeframe: "15m",
    timestampUtc: ts,
    open: close,
    high,
    low,
    close,
    volume: 0,
  };
}
const SERIES: EventStudyCandle[] = [
  candle(T - 1800, 2728),
  candle(T - 900, 2730),
  candle(T, 2725),
  candle(T + 900, 2721),
  candle(T + 1800, 2724),
  candle(T + 2700, 2728),
  candle(T + 3600, 2733),
  candle(T + 4500, 2735),
  candle(T + 5400, 2736), // di luar window event+1j15m
];

describe("runEventStudy: agregasi multi-rilis + hasil per rilis", () => {
  it("stats diagregasi dari reaksi 15m tiap rilis (maks 10 log), releaseResults utuh", async () => {
    const releases12 = Array.from({ length: 12 }, (_, i) =>
      release({ dateUtc: T - i * 86400 })
    );
    const series12 = releases12.flatMap((r) => [
      candle(r.dateUtc - 900, 2730),
      candle(r.dateUtc, 2725),
      candle(r.dateUtc + 900, 2721),
    ]);
    const report = await runEventStudy("NFP", {
      candles: fakeCandles(series12),
      calendar: fakeCalendar(releases12),
      now: () => T + 86400,
    });
    // Hanya 10 rilis terbaru yang dipelajari (batas log).
    expect(report.historicalLogs).toHaveLength(10);
    // Semua rilis: delta 15m = (2721-2730)*10 = -90 pips.
    expect(report.aggregatedStats).toMatchObject({
      totalReleases: 10,
      meanDeltaPips: -90,
      medianDeltaPips: -90,
      directionalConsistency: 100,
      negativeReactionsPct: 100,
      avgRetraceMinutes: null,
    });
    // Reaksi tampilan = rilis terbaru yang punya reaksi.
    expect(report.reactions[0]?.releaseId).toBe(`rel-NFP-${T}`);
    // Hasil per rilis untuk persistensi worker (id kanonik + surprise nyata).
    expect(report.releaseResults).toHaveLength(10);
    expect(report.releaseResults[0]?.releaseId).toBe(`rel-NFP-${T}`);
    expect(report.releaseResults[0]?.isFuture).toBe(false);
    expect(report.releaseResults[0]?.surprise?.zScore).toBe(1.0);
    expect(report.releaseResults[0]?.reactions).toHaveLength(3);
  });
});

describe("runEventStudy: candle sintetis ditandai, bukan dipakai diam-diam", () => {
  it("window seluruhnya sintetis -> candleSource simulated, reaksi kosong (tanpa angka karangan)", async () => {
    const simSeries = SERIES.map((c) => ({ ...c, isSimulated: true }));
    const report = await runEventStudy("NFP", {
      candles: fakeCandles(simSeries),
      calendar: fakeCalendar([release()]),
      now: () => T + 86400,
    });
    expect(report.dataQuality.candleSource).toBe("simulated");
    expect(report.reactions).toEqual([]);
    expect(report.aggregatedStats).toBeNull();
    expect(report.historicalLogs[0]?.pips).toBeNull();
    expect(report.releaseResults[0]?.reactions).toEqual([]);
    // Surprise dari kalender nyata tetap ada.
    expect(report.status).toBe("ok");
    expect(report.surprise?.zScore).toBe(1.0);
  });
});

describe("runEventStudy: edge cases jujur (tanpa angka pengganti)", () => {
  it("stdDev null/0 -> surprise null, bukan fallback konstanta", async () => {
    for (const stdDev of [null, 0]) {
      const report = await runEventStudy("NFP", {
        candles: fakeCandles(SERIES),
        calendar: fakeCalendar([release({ historicalStdDev: stdDev })]),
        now: () => T + 86400,
      });
      expect(report.surprise).toBeNull();
      expect(report.historicalLogs[0]?.surprise).toBeNull();
      // Reaksi candle tetap dihitung (data harga nyata tersedia).
      expect(report.status).toBe("ok");
      expect(report.reactions.length).toBe(3);
    }
  });

  it("kode tanpa rilis kalender -> unavailable, candle tidak di-fetch", async () => {
    const candles = fakeCandles(SERIES);
    const report = await runEventStudy("XYZ", {
      candles,
      calendar: fakeCalendar([release()]),
      now: () => T + 86400,
    });
    expect(report.status).toBe("unavailable");
    expect(report.reason).toBe('Tidak ada data kalender nyata untuk event "XYZ".');
    expect(report.surprise).toBeNull();
    expect(report.reactions).toEqual([]);
    expect(report.aggregatedStats).toBeNull();
    expect(report.historicalLogs).toEqual([]);
    expect(report.dataQuality.totalEvents).toBe(0);
    expect(candles.calls).toHaveLength(0);
  });

  it("rilis masa depan: tidak ada fetch candle, pips/direction null", async () => {
    const candles = fakeCandles(SERIES);
    const report = await runEventStudy("NFP", {
      candles,
      calendar: fakeCalendar([release({ dateUtc: T + 172800 })]),
      now: () => T + 86400,
    });
    expect(candles.calls).toHaveLength(0);
    expect(report.reactions).toEqual([]);
    expect(report.historicalLogs[0]?.pips).toBeNull();
    expect(report.historicalLogs[0]?.direction).toBeNull();
    // Surprise tetap dihitung dari actual/forecast (stdDev nyata).
    expect(report.surprise?.zScore).toBe(1.0);
  });

  it("window candle kosong -> reaksi kosong tanpa crash", async () => {
    const report = await runEventStudy("NFP", {
      candles: fakeCandles([]),
      calendar: fakeCalendar([release()]),
      now: () => T + 86400,
    });
    expect(report.reactions).toEqual([]);
    expect(report.historicalLogs[0]?.pips).toBeNull();
    expect(report.status).toBe("ok"); // surprise nyata masih ada
  });
});

describe("runEventStudy: stdDev nyata dari kalender", () => {
  it("zScore memakai historicalStdDev rilis (0.1), bukan 0.2 hardcoded", async () => {
    const candles = fakeCandles(SERIES);
    const report = await runEventStudy("NFP", {
      candles,
      calendar: fakeCalendar([release()]),
      now: () => T + 86400,
    });
    // surprise 0.1 / stdDev 0.1 = 1.0 (dengan 0.2 hardcoded hasilnya 0.5).
    expect(report.surprise).toEqual({ surpriseVal: 0.1, zScore: 1.0, isFallback: false });
    expect(report.historicalLogs[0]?.surprise).toBe("+0.10 (+1.00σ)");
    expect(report.status).toBe("ok");
  });
});

describe("runEventStudy: window di sekitar tanggal rilis", () => {
  it("meminta candle 15m sampai event+1j15m (limit 400) dan reaksi dihitung dari window itu", async () => {
    const candles = fakeCandles(SERIES);
    const report = await runEventStudy("NFP", {
      candles,
      calendar: fakeCalendar([release()]),
      now: () => T + 86400,
    });
    // Window mencakup SETELAH rilis: end = T + 3600 + 900, bukan 'latest'.
    expect(candles.calls).toEqual([{ endUtc: T + 4500, limit: 400 }]);
    // Base = close candle terakhir sebelum rilis (2730).
    const deltas = report.reactions.map((r) => [r.windowMinutes, r.deltaPips]);
    expect(deltas).toEqual([[5, -50], [15, -90], [60, 30]]);
    expect(report.reactions.every((r) => r.basePrice === 2730)).toBe(true);
    // Candle T+5400 di luar window tidak boleh ikut reaksi.
    expect(report.reactions.find((r) => r.windowMinutes === 60)?.endPrice).toBe(2733);
  });
});