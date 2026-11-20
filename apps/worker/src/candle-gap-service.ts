/**
 * candle-gap-service — adapter produksi untuk modul deep gap-recovery.
 *
 * Menyediakan GapDbPort (drizzle/TiDB: MAX(timestamp_utc) + upsert batch) dan
 * membungkus DerivClient sebagai GapDerivPort, lalu menjalankan healCandleGap
 * untuk semua timeframe. Dipanggil worker tiap cycle: cycle pertama setelah
 * server hidup menutup gap downtime; cycle berikutnya noop bila sudah kontinu
 * (sekaligus menyembuhkan gap akibat reconnect jaringan).
 *
 * Logika gap TIDAK di sini — di modul deep @repo/financial-clients/gap-recovery
 * (teruji lewat interface dengan adapter in-memory). File ini hanya adapter I/O.
 */
import { db, priceCandles, sql } from "@repo/database";
import {
  healCandleGap,
  type GapDbPort,
  type GapDerivPort,
  type GapHealResult,
  type DerivClient,
} from "@repo/financial-clients";

const BATCH = 500; // aman untuk DB managed (gateway TiDB)
const DERIV_TIMEFRAMES = [
  ["15m", 900],
  ["30m", 1800],
  ["1h", 3600],
  ["4h", 14400],
] as const;

/** Adapter DB produksi: MAX per tf + upsert batch onConflict(id) refresh OHLC. */
export function createGapDbPort(): GapDbPort {
  return {
    async getMaxTimestamp(tf) {
      const r = await db
        .select({ m: sql<number | null>`max(${priceCandles.timestampUtc})` })
        .from(priceCandles)
        .where(sql`${priceCandles.timeframe} = ${tf}`);
      const m = r[0]?.m;
      // postgres-js mengembalikan aggregate max() sebagai string -> Number.
      return m == null ? null : Number(m);
    },
    async upsertCandles(rows) {
      if (rows.length === 0) return 0;
      const withId = rows.map((r) => ({ ...r, id: `XAUUSD_${r.timeframe}_${r.timestampUtc}` }));
      for (let i = 0; i < withId.length; i += BATCH) {
        await db
          .insert(priceCandles)
          .values(withId.slice(i, i + BATCH))
          .onConflictDoUpdate({
            target: priceCandles.id,
            set: {
              open: sql`EXCLUDED.open`,
              high: sql`EXCLUDED.high`,
              low: sql`EXCLUDED.low`,
              close: sql`EXCLUDED.close`,
              volume: sql`EXCLUDED.volume`,
              source: sql`EXCLUDED.source`,
            },
          });
      }
      // Modul hanya mengirim candle epoch > maxTs, jadi ini efektif baris baru.
      return rows.length;
    },
  };
}

/** Jalankan gap-healing untuk semua timeframe Deriv memakai satu koneksi. */
export async function healAllCandleGaps(
  deriv: DerivClient,
  symbol: string,
  opts: { delayMs?: number } = {}
): Promise<GapHealResult[]> {
  const dbPort = createGapDbPort();
  const derivPort: GapDerivPort = {
    fetchCandles: (s, g, c, e) => deriv.fetchCandles(s, g, c, e),
  };
  const results: GapHealResult[] = [];
  for (const [tf, granularity] of DERIV_TIMEFRAMES) {
    try {
      const res = await healCandleGap(
        { symbol, tf, granularity },
        { db: dbPort, deriv: derivPort },
        { delayMs: opts.delayMs ?? 1200 }
      );
      const gapH = (res.gapSeconds / 3600).toFixed(1);
      console.log(
        `[GapHeal] ${tf}: +${res.filled} candle, gap ${gapH}j, ${res.pages} page, caughtUp=${res.caughtUp}${res.stoppedReason ? ` (${res.stoppedReason})` : ""}`
      );
      results.push(res);
    } catch (error) {
      console.warn(
        `[GapHeal] ${tf} gagal: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  return results;
}
