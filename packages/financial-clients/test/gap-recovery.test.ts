/**
 * Tes gap-recovery di INTERFACE healCandleGap (bukan internal).
 * Adapter in-memory DB + fake Deriv = seam nyata kedua (produksi: drizzle + DerivClient).
 */
import { describe, it, expect } from "vitest";
import { healCandleGap, type GapDbPort, type GapDerivPort } from "../src/gap-recovery.js";
import type { StoredCandleRow } from "../src/candle-repository.js";

type DC = { epoch: number; open: number; high: number; low: number; close: number };

/** DB in-memory: getMaxTimestamp + upsertCandles (hitung baris BARU). */
function memDb(initial: StoredCandleRow[] = []): GapDbPort & { rows: StoredCandleRow[] } {
  const rows = [...initial];
  return {
    rows,
    async getMaxTimestamp(tf) {
      const t = rows.filter((r) => r.timeframe === tf).map((r) => r.timestampUtc);
      return t.length ? Math.max(...t) : null;
    },
    async upsertCandles(incoming) {
      let added = 0;
      for (const r of incoming) {
        const i = rows.findIndex((x) => x.timeframe === r.timeframe && x.timestampUtc === r.timestampUtc);
        if (i >= 0) rows[i] = r;
        else {
          rows.push(r);
          added++;
        }
      }
      return added;
    },
  };
}

/** Fake Deriv: ticks_history candles — kembalikan `count` candle terbaru dgn epoch <= end. */
function fakeDeriv(series: DC[]): GapDerivPort & { calls: number } {
  const asc = [...series].sort((a, b) => a.epoch - b.epoch);
  const port = {
    calls: 0,
    async fetchCandles(_symbol: string, _gran: number, count: number, end: number | "latest") {
      port.calls++;
      const cap = end === "latest" ? Infinity : end;
      const eligible = asc.filter((c) => c.epoch <= cap);
      return eligible.slice(-count); //Deriv kembalikan terbaru, urut naik
    },
  };
  return port;
}

function row(tf: string, ts: number): StoredCandleRow {
  return { symbol: "XAUUSD", timeframe: tf, timestampUtc: ts, open: 1, high: 2, low: 0.5, close: 1.5, volume: 0, source: "deriv-cfd" };
}
function series(from: number, to: number, gran: number): DC[] {
  const out: DC[] = [];
  for (let t = from; t <= to; t += gran) out.push({ epoch: t, open: 1, high: 2, low: 0.5, close: 1.5 });
  return out;
}

const GRAN = 3600;
const NOW = 1_795_148_000;
const BUCKET = Math.floor(NOW / GRAN) * GRAN;

describe("healCandleGap", () => {
  it("mengisi gap downtime: candle maxTs+gran..bucket sekarang tersimpan, caughtUp", async () => {
    const maxTs = BUCKET - 10 * GRAN; // gap 10 jam
    const db = memDb([row("1h", maxTs)]);
    const deriv = fakeDeriv(series(maxTs - 5 * GRAN, BUCKET, GRAN));
    const res = await healCandleGap({ symbol: "frxXAUUSD", tf: "1h", granularity: GRAN }, { db, deriv, now: () => NOW });
    expect(res.filled).toBe(10);
    expect(res.caughtUp).toBe(true);
    expect(await db.getMaxTimestamp("1h")).toBe(BUCKET);
  });

  it("tidak ada gap (maxTs = bucket sekarang) -> noop, Deriv tidak dipanggil", async () => {
    const db = memDb([row("1h", BUCKET)]);
    const deriv = fakeDeriv(series(BUCKET - 5 * GRAN, BUCKET, GRAN));
    const res = await healCandleGap({ symbol: "frxXAUUSD", tf: "1h", granularity: GRAN }, { db, deriv, now: () => NOW });
    expect(res.filled).toBe(0);
    expect(res.caughtUp).toBe(true);
    expect(res.stoppedReason).toBe("no-gap");
    expect(deriv.calls).toBe(0);
  });

  it("DB kosong -> seed window terbaru, caughtUp", async () => {
    const db = memDb([]);
    const deriv = fakeDeriv(series(BUCKET - 20 * GRAN, BUCKET, GRAN));
    const res = await healCandleGap({ symbol: "frxXAUUSD", tf: "1h", granularity: GRAN }, { db, deriv, now: () => NOW }, { seedCount: 25 });
    expect(res.filled).toBe(21);
    expect(res.stoppedReason).toBe("seeded");
    expect(await db.getMaxTimestamp("1h")).toBe(BUCKET);
  });

  it("gap panjang > pageSize -> paginasi mundur beberapa page sampai tertutup", async () => {
    const maxTs = BUCKET - 20 * GRAN;
    const db = memDb([row("1h", maxTs)]);
    const deriv = fakeDeriv(series(maxTs - 5 * GRAN, BUCKET, GRAN));
    const res = await healCandleGap({ symbol: "frxXAUUSD", tf: "1h", granularity: GRAN }, { db, deriv, now: () => NOW }, { pageSize: 5, delayMs: 0 });
    expect(res.filled).toBe(20);
    expect(res.caughtUp).toBe(true);
    expect(res.pages).toBeGreaterThan(1);
    expect(await db.getMaxTimestamp("1h")).toBe(BUCKET);
  });

  it("provider kehabisan history di tengah gap -> berhenti graceful, tidak loop tak hingga", async () => {
    const maxTs = BUCKET - 20 * GRAN;
    const db = memDb([row("1h", maxTs)]);
    // Deriv cuma punya 5 candle terbaru; sisa gap tak tersedia (market-closed/exhausted).
    const deriv = fakeDeriv(series(BUCKET - 4 * GRAN, BUCKET, GRAN));
    const res = await healCandleGap({ symbol: "frxXAUUSD", tf: "1h", granularity: GRAN }, { db, deriv, now: () => NOW }, { pageSize: 5, delayMs: 0, maxPages: 40 });
    expect(res.filled).toBe(5);
    expect(res.caughtUp).toBe(false);
    expect(res.stoppedReason).toBe("provider-exhausted");
    expect(res.pages).toBeLessThanOrEqual(3);
  });

  it("idempotent: run kedua setelah gap tertutup -> filled 0", async () => {
    const maxTs = BUCKET - 10 * GRAN;
    const db = memDb([row("1h", maxTs)]);
    const deriv = fakeDeriv(series(maxTs - 5 * GRAN, BUCKET, GRAN));
    const ports = { db, deriv, now: () => NOW };
    const first = await healCandleGap({ symbol: "frxXAUUSD", tf: "1h", granularity: GRAN }, ports);
    const second = await healCandleGap({ symbol: "frxXAUUSD", tf: "1h", granularity: GRAN }, ports);
    expect(first.filled).toBe(10);
    expect(second.filled).toBe(0);
    expect(second.caughtUp).toBe(true);
  });
});
