/**
 * Tes candle-repository DI INTERFACE (getCandles) — seam yang sama dengan
 * pemanggil produksi. Adapter: DB in-memory + CSV fixture in-memory
 * (dua adapter nyata per seam, bukan mock lapis demi lapis).
 * Fixture CSV diparse memakai parser kanonik modul, jadi jalur parse ikut teruji.
 */
import { describe, it, expect } from "vitest";
import {
  getCandles,
  fetchExpertCandles,
  parseCsvLine,
  parseCandleLine,
  aggregateCandles,
  subdivideCandles,
  binarySearchBefore,
} from "../src/candle-repository.js";
import type {
  CandleDbPort,
  CsvSeriesAdapter,
  ParsedCandle,
  StoredCandleRow,
} from "../src/candle-repository.js";
import type { OHLCV, Timeframe } from "@repo/types";
import { COMPLIANCE_DISCLAIMER_FR10 } from "@repo/types";

// ---------------------------------------------------------------------------
// Fixture & adapter in-memory
// ---------------------------------------------------------------------------

/** 8 bar H1 mulai 1420041600 (batas bucket 4h), campuran nilai unik. */
const H1_BASE = 1420041600;
const H1_BARS = Array.from({ length: 8 }, (_, i) => ({
  ts: H1_BASE + i * 3600,
  open: 1180 + i,
  high: 1186 + i,
  low: 1174 + i,
  close: 1183 + i, // bull
  volume: 10 + i * 10,
}));

function toCsvTime(ts: number): string {
  return new Date(ts * 1000).toISOString().replace("T", " ").replace(".000Z", "+00:00");
}

const H1_CSV =
  "time,open,high,low,close,volume,spread\n" +
  H1_BARS.map((b) => `${toCsvTime(b.ts)},${b.open},${b.high},${b.low},${b.close},${b.volume},0.5`).join("\n");

function parseFixture(text: string, tf: Timeframe): ParsedCandle[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => parseCandleLine(l, tf))
    .filter((c): c is ParsedCandle => c !== null)
    .sort((a, b) => a.timestampUtc - b.timestampUtc);
}

function stripEstimated(c: ParsedCandle): OHLCV {
  const { isEstimated: _drop, ...rest } = c;
  return rest;
}

/** Adapter CSV in-memory dari teks fixture (produksi = adapter file). */
function csvFixture(h1Text: string, intradayText = ""): CsvSeriesAdapter {
  const h1 = parseFixture(h1Text, "1h").map(stripEstimated);
  const m15 = intradayText ? parseFixture(intradayText, "15m") : [];
  return {
    loadH1: async () => h1,
    loadIntraday: async (tf) => (tf === "15m" ? m15 : []),
  };
}

const CSV_EMPTY: CsvSeriesAdapter = {
  loadH1: async () => [],
  loadIntraday: async () => [],
};

type TestRow = StoredCandleRow & { id: string };

function dbRow(tf: Timeframe, ts: number, source: StoredCandleRow["source"], i = 0): TestRow {
  return {
    id: `XAUUSD_${tf}_${ts}`,
    symbol: "XAUUSD",
    timeframe: tf,
    timestampUtc: ts,
    open: 1200 + i,
    high: 1205 + i,
    low: 1195 + i,
    close: 1202 + i,
    volume: 7,
    source,
  };
}

/** Adapter DB in-memory: semantik lte (inklusif) + urut naik, seperti drizzle. */
function dbFixture(all: TestRow[]): { port: CandleDbPort; calls: Array<{ tf: string; limit: number; to?: number }> } {
  const calls: Array<{ tf: string; limit: number; to?: number }> = [];
  const port: CandleDbPort = {
    async queryCandles(tf, limit, to) {
      calls.push({ tf, limit, to });
      let rows = all.filter((r) => r.timeframe === tf);
      if (to !== undefined && Number.isFinite(to)) rows = rows.filter((r) => r.timestampUtc <= to);
      return rows
        .slice()
        .sort((a, b) => b.timestampUtc - a.timestampUtc)
        .slice(0, limit)
        .reverse();
    },
  };
  return { port, calls };
}

const DB_EMPTY: CandleDbPort = { queryCandles: async () => [] };
const DB_ERROR: CandleDbPort = {
  queryCandles: async () => {
    throw new Error("CONNECTION_CLOSED");
  },
};

// ---------------------------------------------------------------------------
// Interface utama: getCandles
// ---------------------------------------------------------------------------

describe("getCandles: jalur DB (adapter in-memory)", () => {
  it("window recent Deriv: passthrough baris (termasuk id), source deriv-cfd", async () => {
    const rows = [0, 1, 2].map((i) => dbRow("15m", 1795000000 + i * 900, "deriv-cfd", i));
    const { port, calls } = dbFixture(rows);
    const res = await getCandles("15m", 100, undefined, { db: port, csv: CSV_EMPTY });

    expect(calls).toEqual([{ tf: "15m", limit: 100, to: undefined }]);
    expect(res.timeframe).toBe("15m");
    expect(res.count).toBe(3);
    expect(res.data).toEqual(rows); // passthrough utuh, id tidak hilang
    expect(res.source).toBe("deriv-cfd");
    expect(res.isSimulated).toBe(false);
    expect(res.status).toBe("ok");
    expect(res.disclaimer).toBe(COMPLIANCE_DISCLAIMER_FR10);
  });

  it("window historis dalam: source csv-historical, to diteruskan ke port", async () => {
    const rows = [0, 1, 2].map((i) => dbRow("1h", 1417406400 + i * 3600, "csv-historical", i));
    const { port, calls } = dbFixture(rows);
    const res = await getCandles("1h", 500, 1420070400, { db: port, csv: CSV_EMPTY });

    expect(calls).toEqual([{ tf: "1h", limit: 500, to: 1420070400 }]);
    expect(res.source).toBe("csv-historical");
    expect(res.status).toBe("ok");
    expect(res.count).toBe(3);
    expect(res.data.every((r) => r.source === "csv-historical")).toBe(true);
  });

  it("label campuran: top-level = source baris TERBARU, label per-baris jujur", async () => {
    const rows = [
      dbRow("1h", 1417406400, "csv-historical"),
      dbRow("1h", 1417410000, "csv-historical"),
      dbRow("1h", 1795000000, "deriv-cfd"),
      dbRow("1h", 1795003600, "deriv-cfd"),
    ];
    const { port } = dbFixture(rows);
    const res = await getCandles("1h", 1000, undefined, { db: port, csv: CSV_EMPTY });

    expect(res.source).toBe("deriv-cfd");
    expect(res.data.map((r) => r.source)).toEqual([
      "csv-historical",
      "csv-historical",
      "deriv-cfd",
      "deriv-cfd",
    ]);
  });

  it("pagination to= di DB bersifat INKLUSIF (baris tepat di to ikut)", async () => {
    const rows = [0, 1, 2, 3].map((i) => dbRow("1h", 1420056000 + i * 3600, "csv-historical", i));
    const { port } = dbFixture(rows);
    const res = await getCandles("1h", 10, 1420063200, { db: port, csv: CSV_EMPTY });

    expect(res.count).toBe(3);
    expect(res.data[res.count - 1]!.timestampUtc).toBe(1420063200); // <= to
  });
});

describe("getCandles: fallback CSV (DB kosong/mati)", () => {
  it("DB kosong -> CSV H1, baris tanpa id, source csv-historical", async () => {
    const res = await getCandles("1h", 5, undefined, { db: DB_EMPTY, csv: csvFixture(H1_CSV) });

    expect(res.count).toBe(5);
    expect(res.source).toBe("csv-historical");
    expect(res.isSimulated).toBe(false);
    expect(res.status).toBe("ok");
    // Bentuk baris fallback: tepat 9 field, tanpa id (kontrak lama API).
    expect(Object.keys(res.data[0]!)).toEqual([
      "symbol",
      "timeframe",
      "timestampUtc",
      "open",
      "high",
      "low",
      "close",
      "volume",
      "source",
    ]);
    const last = H1_BARS[7]!;
    expect(res.data[4]).toEqual({
      symbol: "XAUUSD",
      timeframe: "1h",
      timestampUtc: last.ts,
      open: last.open,
      high: last.high,
      low: last.low,
      close: last.close,
      volume: last.volume,
      source: "csv-historical",
    });
  });

  it("DB error -> fallback CSV, tidak melempar", async () => {
    const res = await getCandles("1h", 3, undefined, { db: DB_ERROR, csv: csvFixture(H1_CSV) });
    expect(res.status).toBe("ok");
    expect(res.source).toBe("csv-historical");
    expect(res.count).toBe(3);
  });

  it("tanpa port db sama sekali -> langsung CSV", async () => {
    const res = await getCandles("1h", 2, undefined, { csv: csvFixture(H1_CSV) });
    expect(res.count).toBe(2);
    expect(res.source).toBe("csv-historical");
  });

  it("pagination to= di CSV bersifat EKSKLUSIF (perilaku lama dipertahankan)", async () => {
    const res = await getCandles("1h", 100, 1420056000, { db: DB_EMPTY, csv: csvFixture(H1_CSV) });
    // baris dengan ts == to TIDAK ikut (binarySearchBefore strict <).
    expect(res.data[res.count - 1]!.timestampUtc).toBe(1420052400);
    expect(res.count).toBe(4);
  });

  it("4h dari CSV = agregasi H1 per bucket (open pertama, close terakhir, volume jumlah)", async () => {
    const res = await getCandles("4h", 1000, undefined, { db: DB_EMPTY, csv: csvFixture(H1_CSV) });
    expect(res.count).toBe(2);
    expect(res.source).toBe("csv-historical");
    const b0 = H1_BARS.slice(0, 4);
    const b1 = H1_BARS.slice(4, 8);
    expect(res.data[0]).toEqual({
      symbol: "XAUUSD",
      timeframe: "4h",
      timestampUtc: 1420041600,
      open: b0[0]!.open,
      high: Math.max(...b0.map((b) => b.high)),
      low: Math.min(...b0.map((b) => b.low)),
      close: b0[3]!.close,
      volume: b0.reduce((s, b) => s + b.volume, 0),
      source: "csv-historical",
    });
    expect(res.data[1]!.timestampUtc).toBe(1420056000);
    expect(res.data[1]!.volume).toBe(b1.reduce((s, b) => s + b.volume, 0));
  });

  it("15m tanpa intraday = estimasi subdivisi H1, tetap csv-historical (bukan simulated)", async () => {
    const res = await getCandles("15m", 8, 1420070400, { db: DB_EMPTY, csv: csvFixture(H1_CSV) });
    expect(res.count).toBe(8);
    expect(res.source).toBe("csv-historical");
    expect(res.isSimulated).toBe(false);
    expect(res.status).toBe("ok");
    // 8 bar terakhir = 2 bar H1 terakhir x 4 sub-bar, jarak 900 detik.
    const parent = H1_BARS[6]!;
    expect(res.data[0]!.timestampUtc).toBe(parent.ts);
    expect(res.data[0]!.open).toBe(parent.open);
    for (let i = 1; i < res.count; i++) {
      expect(res.data[i]!.timestampUtc - res.data[i - 1]!.timestampUtc).toBe(900);
    }
    expect(res.data[res.count - 1]!.timestampUtc).toBeLessThan(1420070400);
    for (const row of res.data) {
      const p = H1_BARS.find((b) => row.timestampUtc >= b.ts && row.timestampUtc < b.ts + 3600)!;
      expect(row.volume).toBe(Math.floor(p.volume / 4));
      expect(row.high).toBeLessThanOrEqual(p.high);
      expect(row.low).toBeGreaterThanOrEqual(p.low);
    }
  });

  it("15m dengan intraday nyata -> pakai CSV intraday, bukan estimasi", async () => {
    const intradayCsv =
      "time,open,high,low,close,volume,is_real\n" +
      [0, 1, 2, 3, 4, 5]
        .map((i) => `${toCsvTime(1420060000 + i * 900)},${1190 + i},${1192 + i},${1188 + i},${1191 + i},50,1`)
        .join("\n");
    const res = await getCandles("15m", 4, undefined, {
      db: DB_EMPTY,
      csv: csvFixture(H1_CSV, intradayCsv),
    });
    expect(res.count).toBe(4);
    expect(res.source).toBe("csv-historical");
    expect(res.data[0]!.timestampUtc).toBe(1420060000 + 2 * 900);
    expect(res.data[0]!.open).toBe(1192);
    expect(res.data[3]!.volume).toBe(50);
  });

  it("intraday berflag estimasi (is_real=0) -> tetap csv-historical di kosakata API", async () => {
    const intradayCsv =
      "time,open,high,low,close,volume,is_real\n" +
      [0, 1, 2]
        .map((i) => `${toCsvTime(1420060000 + i * 900)},${1190 + i},${1192 + i},${1188 + i},${1191 + i},50,0`)
        .join("\n");
    const res = await getCandles("15m", 3, undefined, {
      db: DB_EMPTY,
      csv: csvFixture(H1_CSV, intradayCsv),
    });
    expect(res.source).toBe("csv-historical");
    expect(res.isSimulated).toBe(false);
    expect(res.data.every((r) => !("isEstimated" in r))).toBe(true);
  });
});

describe("getCandles: kosong semua -> sintetis berlabel", () => {
  it("DB kosong + CSV kosong -> simulated, deterministik dengan now/random inject", async () => {
    const res = await getCandles("15m", 10, undefined, {
      db: DB_EMPTY,
      csv: CSV_EMPTY,
      now: () => 1700000000,
      random: () => 0.5,
    });

    expect(res.count).toBe(11); // generator lama: limit + 1 bar (dipertahankan)
    expect(res.source).toBe("simulated");
    expect(res.isSimulated).toBe(true);
    expect(res.status).toBe("simulated");
    expect(res.data[0]).toEqual({
      symbol: "XAUUSD",
      timeframe: "15m",
      timestampUtc: 1700000000 - 10 * 900,
      open: 4122.75,
      high: 4123.82,
      low: 4121.75,
      close: 4122.82,
      volume: 500,
      source: "simulated",
    });
    expect(res.data[10]!.timestampUtc).toBe(1700000000);
    expect(res.data.every((r) => r.source === "simulated")).toBe(true);
  });
});

describe("fetchExpertCandles: jalur CSV tanpa DB (delegate FinancialClient)", () => {
  it("CSV ada -> OHLCV tanpa isSimulated", async () => {
    const candles = await fetchExpertCandles("1h", 3, undefined, { csv: csvFixture(H1_CSV) });
    expect(candles).toHaveLength(3);
    expect(candles.every((c) => c.isSimulated === undefined)).toBe(true);
    expect(candles[2]!.timestampUtc).toBe(H1_BARS[7]!.ts);
  });

  it("CSV kosong -> sintetis selalu isSimulated: true", async () => {
    const candles = await fetchExpertCandles("1h", 5, undefined, {
      csv: CSV_EMPTY,
      now: () => 1700000000,
      random: () => 0.5,
    });
    expect(candles).toHaveLength(6);
    expect(candles.every((c) => c.isSimulated === true)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Seam internal pure (parser kanonik, agregasi, subdivisi, binary search)
// ---------------------------------------------------------------------------

describe("seam internal: parseCsvLine / parseCandleLine", () => {
  it("parseCsvLine sadar kutip ganda dan escape", () => {
    expect(parseCsvLine('a,"b,c","d""e",f')).toEqual(["a", "b,c", 'd"e', "f"]);
  });

  it("parseCandleLine: header dan baris rusak -> null", () => {
    expect(parseCandleLine("time,open,high,low,close,volume,spread", "1h")).toBeNull();
    expect(parseCandleLine("2015-01-01 00:00:00+00:00,1,2,3", "1h")).toBeNull();
    expect(parseCandleLine("bukan-tanggal,1,2,3,4,5", "1h")).toBeNull();
    expect(parseCandleLine("2015-01-01 00:00:00+00:00,1,2,3,abc,5", "1h")).toBeNull();
  });

  it("parseCandleLine: volume kosong -> fallback 100, is_real=0 -> isEstimated", () => {
    const c = parseCandleLine("2015-01-01 00:00:00+00:00,1,2,3,4,,0", "15m");
    expect(c).not.toBeNull();
    expect(c!.volume).toBe(100);
    expect(c!.isEstimated).toBe(true);
    expect(c!.timestampUtc).toBe(1420070400);
    const real = parseCandleLine("2015-01-01 00:00:00+00:00,1,2,3,4,9,1", "15m");
    expect(real!.volume).toBe(9);
    expect(real!.isEstimated).toBeUndefined();
  });
});

describe("seam internal: aggregateCandles / subdivideCandles / binarySearchBefore", () => {
  const bar = (ts: number, o: number, h: number, l: number, c: number, v: number): OHLCV => ({
    symbol: "XAUUSD",
    timeframe: "1h",
    timestampUtc: ts,
    open: o,
    high: h,
    low: l,
    close: c,
    volume: v,
  });

  it("aggregateCandles: bucket parsial terakhir tetap diagregasi apa adanya", () => {
    const agg = aggregateCandles(
      [bar(0, 1, 5, 0, 2, 10), bar(3600, 2, 6, 1, 3, 20), bar(14400, 3, 7, 2, 4, 30)],
      14400,
      "4h"
    );
    expect(agg).toHaveLength(2);
    expect(agg[0]).toMatchObject({ timestampUtc: 0, open: 1, high: 6, low: 0, close: 3, volume: 30 });
    expect(agg[1]).toMatchObject({ timestampUtc: 14400, open: 3, close: 4, volume: 30 });
  });

  it("subdivideCandles: wick bull 0.15/0.05, volume floor(v/subCount)", () => {
    const subs = subdivideCandles([bar(0, 100, 115, 95, 110, 10)], 4, 900, "15m");
    expect(subs).toHaveLength(4);
    expect(subs[0]).toMatchObject({ timestampUtc: 0, open: 100, close: 102.5, high: 105.5, low: 99, volume: 2 });
    expect(subs[3]!.close).toBe(110); // sub-bar terakhir close = close induk
    expect(subs[3]!.timestampUtc).toBe(2700);
  });

  it("subdivideCandles: wick bear dibalik (low 0.15, high 0.05)", () => {
    const subs = subdivideCandles([bar(0, 110, 115, 95, 100, 10)], 4, 900, "15m");
    expect(subs[0]).toMatchObject({ open: 110, close: 107.5, high: 111, low: 104.5 });
  });

  it("binarySearchBefore: eksklusif, -1 bila semua >= target", () => {
    const rows = [bar(100, 1, 1, 1, 1, 1), bar(200, 1, 1, 1, 1, 1), bar(300, 1, 1, 1, 1, 1)];
    expect(binarySearchBefore(rows, 200)).toBe(0);
    expect(binarySearchBefore(rows, 301)).toBe(2);
    expect(binarySearchBefore(rows, 100)).toBe(-1);
    expect(binarySearchBefore([], 100)).toBe(-1);
  });
});
