/**
 * candle-gap-service — adapter I/O produksi untuk dua modul deep:
 * gap-recovery (@repo/financial-clients) dan candle-store (./candle-store).
 *
 * - createDrizzleCandleStorePort: CandleStorePort drizzle/TiDB (insert batch
 *   per kebijakan konflik + retry backoff, MAX(timestamp_utc) per tf/source).
 *   Konvensi id, ukuran batch, dan guard provenance TIDAK di sini — semua di
 *   modul deep candle-store; file ini hanya menerjemahkan ke SQL.
 * - createGapDbPort: GapDbPort di atas candle-store. getMaxTimestamp WAJIB
 *   memfilter source='deriv-cfd' supaya gap-healing murni Deriv: baris
 *   CSV/sintetis yang lebih baru tidak boleh menciptakan "no-gap" palsu.
 * - healAllCandleGaps: membungkus DerivClient sebagai GapDerivPort lalu
 *   menjalankan healCandleGap untuk semua timeframe (cycle pertama setelah
 *   server hidup menutup gap downtime; cycle berikutnya noop bila kontinu).
 *
 * Logika gap TIDAK di sini — di modul deep gap-recovery (teruji lewat
 * interface dengan adapter in-memory).
 */
import { db, priceCandles, sql, and, eq } from "@repo/database";
import {
  healCandleGap,
  type GapDbPort,
  type GapDerivPort,
  type GapHealResult,
  type DerivClient,
} from "@repo/financial-clients";
import {
  createCandleStore,
  type CandleStore,
  type CandleStorePort,
} from "./candle-store.js";

const DERIV_TIMEFRAMES = [
  ["15m", 900],
  ["30m", 1800],
  ["1h", 3600],
  ["4h", 14400],
] as const;

const MAX_ATTEMPTS = 4; // retry per batch; aman karena kedua kebijakan idempotent
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Adapter drizzle/TiDB untuk CandleStorePort. Retry dengan backoff di sini
 * (bukan di caller): gateway TiDB kadang menutup koneksi (CONNECTION_CLOSED).
 * refresh = onConflictDoUpdate(id) perbarui OHLCV+source; skip-existing =
 * onConflictDoNothing (baris lama menang). Keduanya idempotent -> retry aman.
 */
export function createDrizzleCandleStorePort(): CandleStorePort {
  return {
    async insertBatch(rows, policy) {
      if (rows.length === 0) return;
      for (let attempt = 1; ; attempt++) {
        try {
          if (policy === "refresh") {
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
                  source: sql`EXCLUDED.source`,
                },
              });
          } else {
            await db.insert(priceCandles).values(rows).onConflictDoNothing();
          }
          break;
        } catch (err) {
          if (attempt >= MAX_ATTEMPTS) throw err;
          console.warn(
            `[candle-store] batch ${rows.length} baris (${policy}) gagal ` +
              `(percobaan ${attempt}): ${err instanceof Error ? err.message : String(err)} — retry...`
          );
          await sleep(1000 * attempt);
        }
      }
    },
    async maxTimestamp(tf, source) {
      const conditions = [eq(priceCandles.timeframe, tf)];
      if (source !== null) conditions.push(eq(priceCandles.source, source));
      const r = await db
        .select({ m: sql<number | null>`max(${priceCandles.timestampUtc})` })
        .from(priceCandles)
        .where(and(...conditions));
      const m = r[0]?.m;
      // postgres-js mengembalikan aggregate max() sebagai string -> Number.
      return m == null ? null : Number(m);
    },
  };
}

/**
 * GapDbPort di atas candle-store. Healing murni Deriv: MAX difilter
 * source='deriv-cfd' (baris csv-historical/simulated diabaikan), upsert
 * memakai kebijakan refresh (Deriv sumber otoritatif untuk 15m/30m/1h/4h).
 */
export function createGapDbPort(
  store: CandleStore = createCandleStore(createDrizzleCandleStorePort())
): GapDbPort {
  return {
    getMaxTimestamp: (tf) => store.getMaxTimestamp(tf, "deriv-cfd"),
    upsertCandles: (rows) => store.upsertPriceCandles(rows, "refresh"),
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
      // Bukti filter provenance: MAX yang dipakai healing hanya baris Deriv.
      const maxDeriv = await dbPort.getMaxTimestamp(tf);
      console.log(
        `[GapHeal] ${tf}: MAX(deriv-cfd)=${maxDeriv == null ? "null" : new Date(maxDeriv * 1000).toISOString()} — healing murni Deriv (source filter aktif)`
      );
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