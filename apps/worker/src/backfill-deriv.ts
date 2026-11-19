/**
 * Backfill candle historis LANGSUNG dari Deriv (sumber sama dengan live) ke
 * price_candles. Semua candle real ber-provenance deriv-cfd; volume 0 (Deriv
 * tidak menyediakan volume, bukan angka karangan). Paginasi ticks_history
 * mundur via parameter `end` sampai Deriv kehabisan history.
 *
 * Jalankan dari apps/worker: bunx tsx src/backfill-deriv.ts
 * DB target dibaca dari .env (DATABASE_URL). Idempotent: onConflictDoNothing(id).
 */
import { DerivClient } from "@repo/financial-clients";
import { db, priceCandles, sql } from "@repo/database";

const SYMBOL = "frxXAUUSD";
const TFS = [
  ["15m", 900],
  ["30m", 1800],
  ["1h", 3600],
  ["4h", 14400],
] as const;
const PAGE = 5000; // maksimum count ticks_history Deriv
const MAX_PAGES = 40; // batas aman agar tidak loop tak hingga
const DELAY_MS = 1200; // jeda antar-request (hormati rate limit Deriv)
const BATCH = 500; // ukuran batch insert (aman untuk DB managed)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function backfillTf(deriv: DerivClient, tf: string, gran: number): Promise<number> {
  let end: number | "latest" = "latest";
  let total = 0;
  let pages = 0;
  while (pages < MAX_PAGES) {
    const candles = await deriv.fetchCandles(SYMBOL, gran, PAGE, end);
    pages++;
    if (candles.length === 0) break;

    const rows = candles.map((c) => ({
      id: `XAUUSD_${tf}_${c.epoch}`,
      symbol: "XAUUSD",
      timeframe: tf,
      timestampUtc: c.epoch,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: 0,
      source: "deriv-cfd",
    }));
    for (let i = 0; i < rows.length; i += BATCH) {
      await db.insert(priceCandles).values(rows.slice(i, i + BATCH)).onConflictDoNothing();
    }
    total += rows.length;
    const oldest = Math.min(...candles.map((c) => c.epoch));
    console.log(
      `[backfill] ${tf} page ${pages}: +${rows.length} (mundur ke ${new Date(oldest * 1000).toISOString().slice(0, 10)}), total ${total}`
    );
    if (candles.length < PAGE) break; // Deriv sudah kehabisan history
    end = oldest - 1;
    await sleep(DELAY_MS);
  }
  return total;
}

(async () => {
  const appId = process.env.DERIV_APP_ID;
  if (!appId) {
    console.error("[backfill] DERIV_APP_ID kosong — set di .env dulu.");
    process.exit(1);
  }
  const deriv = new DerivClient({ appId, symbol: SYMBOL });
  try {
    for (const [tf, gran] of TFS) {
      try {
        const n = await backfillTf(deriv, tf, gran);
        console.log(`[backfill] ${tf} SELESAI: ${n} candle disimpan.`);
      } catch (e) {
        console.warn(`[backfill] ${tf} gagal: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } finally {
    deriv.close();
  }
  const counts = await db
    .select({ tf: priceCandles.timeframe, n: sql<number>`count(*)` })
    .from(priceCandles)
    .groupBy(priceCandles.timeframe);
  console.log("[backfill] COUNTS TiDB:", JSON.stringify(counts));
  process.exit(0);
})();
