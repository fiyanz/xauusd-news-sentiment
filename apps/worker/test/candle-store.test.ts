/**
 * Tes candle-store di INTERFACE createCandleStore (bukan internal).
 * Adapter in-memory = seam nyata kedua (produksi: drizzle/TiDB di
 * candle-gap-service). Fake menyimpan baris by id dengan semantik konflik
 * SQL mentah (refresh = timpa, skip-existing = lewati) dan merekam panggilan
 * insertBatch supaya konvensi id, kebijakan, provenance guard, dan batching
 * teruji lewat interface yang sama dengan yang dipakai caller produksi.
 */
import { describe, it, expect } from "vitest";
import {
  createCandleStore,
  type CandleStorePort,
  type CandleConflictPolicy,
} from "../src/candle-store.js";
import type { StoredCandleRow, CandleProvenance } from "@repo/financial-clients";

type StoredWithId = StoredCandleRow & { id: string };

/** DB in-memory: Map by id + rekaman batch (ukuran & kebijakan per panggilan). */
function memPort(initial: StoredWithId[] = []) {
  const rows = new Map<string, StoredWithId>(initial.map((r) => [r.id, r]));
  const batches: { size: number; policy: CandleConflictPolicy }[] = [];
  const port: CandleStorePort & {
    rows: Map<string, StoredWithId>;
    batches: { size: number; policy: CandleConflictPolicy }[];
  } = {
    rows,
    batches,
    async insertBatch(batch, policy) {
      batches.push({ size: batch.length, policy });
      for (const r of batch) {
        const existing = rows.get(r.id);
        if (existing && policy === "skip-existing") continue;
        rows.set(r.id, { ...r });
      }
    },
    async maxTimestamp(tf, source) {
      const eligible = [...rows.values()].filter(
        (r) => r.timeframe === tf && (source === null || r.source === source)
      );
      return eligible.length ? Math.max(...eligible.map((r) => r.timestampUtc)) : null;
    },
  };
  return port;
}

function row(
  tf: string,
  ts: number,
  source: CandleProvenance = "deriv-cfd",
  close = 1.5
): StoredCandleRow {
  return {
    symbol: "XAUUSD",
    timeframe: tf,
    timestampUtc: ts,
    open: 1,
    high: 2,
    low: 0.5,
    close,
    volume: 0,
    source,
  };
}

describe("candle-store: guard provenance (tidak saling timpa)", () => {
  it("csv/simulated tidak menimpa baris lama meski policy refresh; deriv-cfd boleh upgrade csv", async () => {
    const derivRow: StoredWithId = { ...row("15m", 1000), id: "XAUUSD_15m_1000" };
    const csvRow: StoredWithId = { ...row("1h", 2000, "csv-historical", 9), id: "XAUUSD_1h_2000" };
    const port = memPort([derivRow, csvRow]);
    const store = createCandleStore(port);

    // CSV + sintetis meminta refresh -> tetap tidak boleh menimpa Deriv recent.
    await store.upsertPriceCandles(
      [row("15m", 1000, "csv-historical", 99), row("15m", 1000, "simulated", 98)],
      "refresh"
    );
    expect(port.rows.get("XAUUSD_15m_1000")?.source).toBe("deriv-cfd");
    expect(port.rows.get("XAUUSD_15m_1000")?.close).toBe(1.5);
    // Guard diterapkan modul: baris non-deriv dikirim ke port sebagai skip-existing.
    expect(port.batches.every((b) => b.policy === "skip-existing")).toBe(true);

    // Deriv refresh atas baris CSV lama -> upgrade (Deriv recent MENANG).
    await store.upsertPriceCandles([row("1h", 2000, "deriv-cfd", 5)], "refresh");
    expect(port.rows.get("XAUUSD_1h_2000")?.source).toBe("deriv-cfd");
    expect(port.rows.get("XAUUSD_1h_2000")?.close).toBe(5);
    expect(port.batches[port.batches.length - 1]?.policy).toBe("refresh");

    // skip-existing eksplisit: baris lama dipertahankan apa adanya.
    await store.upsertPriceCandles([row("1h", 2000, "deriv-cfd", 7)], "skip-existing");
    expect(port.rows.get("XAUUSD_1h_2000")?.close).toBe(5);
  });
});

describe("candle-store: getMaxTimestamp filter source", () => {
  it("MAX per tf difilter provenance: baris csv tidak menutupi MAX deriv (no-gap palsu)", async () => {
    const port = memPort([
      { ...row("15m", 1000, "deriv-cfd"), id: "XAUUSD_15m_1000" },
      { ...row("15m", 5000, "csv-historical"), id: "XAUUSD_15m_5000" },
      { ...row("1h", 9000, "csv-historical"), id: "XAUUSD_1h_9000" },
    ]);
    const store = createCandleStore(port);
    expect(await store.getMaxTimestamp("15m", "deriv-cfd")).toBe(1000);
    expect(await store.getMaxTimestamp("15m", "csv-historical")).toBe(5000);
    expect(await store.getMaxTimestamp("15m")).toBe(5000);
    expect(await store.getMaxTimestamp("4h", "deriv-cfd")).toBeNull();
    expect(await store.getMaxTimestamp("4h")).toBeNull();
  });
});

describe("candle-store: batching", () => {
  it("1200 baris dipecah jadi batch <= 500 per panggilan port, semua tersimpan", async () => {
    const port = memPort();
    const store = createCandleStore(port);
    const rows = Array.from({ length: 1200 }, (_, i) => row("1h", 1_000_000 + i * 3600));
    const n = await store.upsertPriceCandles(rows, "skip-existing");
    expect(n).toBe(1200);
    expect(port.rows.size).toBe(1200);
    expect(port.batches.length).toBe(3);
    expect(port.batches.every((b) => b.size <= 500)).toBe(true);
    expect(port.batches.reduce((acc, b) => acc + b.size, 0)).toBe(1200);
  });
});

describe("candle-store: konvensi id + tulis baris baru", () => {
  it("menyimpan baris dengan id <symbol>_<tf>_<epoch> tanpa caller membangun id", async () => {
    const port = memPort();
    const store = createCandleStore(port);
    const n = await store.upsertPriceCandles([row("15m", 1795000000), row("1h", 1795003600)], "refresh");
    expect(n).toBe(2);
    expect(port.rows.get("XAUUSD_15m_1795000000")?.close).toBe(1.5);
    expect(port.rows.get("XAUUSD_1h_1795003600")?.timeframe).toBe("1h");
    expect(port.rows.size).toBe(2);
  });

  it("input kosong -> 0 dan port tidak dipanggil", async () => {
    const port = memPort();
    const store = createCandleStore(port);
    expect(await store.upsertPriceCandles([], "refresh")).toBe(0);
    expect(port.batches).toHaveLength(0);
  });
});