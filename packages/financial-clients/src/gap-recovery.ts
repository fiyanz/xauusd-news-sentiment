/**
 * gap-recovery — modul deep "Crash Recovery & Gap Healing" (skill
 * real-time-market-chart-pipeline §4). Ketika server mati lalu hidup lagi,
 * candle sempat bolong antara MAX(timestamp_utc) dan now. Modul ini menghitung
 * gap AKTUAL per timeframe lalu mem-fetch candle Deriv secukupnya (paginasi
 *mundur via `end`) untuk menutupnya, sebelum/bersamaan live stream lanjut.
 *
 * Ports & adapters (seam nyata, dua adapter per seam):
 * - DB port   : produksi = drizzle (MAX + upsert), tes = in-memory.
 * - Deriv port: produksi = DerivClient.fetchCandles, tes = fake seri.
 *
 * Idempotent (upsert by id). Jam break pasar / weekend dihormati: Deriv hanya
 * mengembalikan candle jam trading, jadi gap tertutup sejauh provider punya
 * data; loop berhenti saat mencapai data tersimpan ATAU provider kehabisan
 * history (bukan loop tak hingga pada gap market-closed).
 */
import type { StoredCandleRow } from "./candle-repository.js";

export interface GapDbPort {
  /**
   * MAX(timestamp_utc) untuk tf; null bila belum ada baris. Adapter produksi
   * (worker candle-gap-service) MEMFILTER source='deriv-cfd' supaya healing
   * murni Deriv — baris CSV/sintetis tidak boleh menciptakan "no-gap" palsu.
   */
  getMaxTimestamp(tf: string): Promise<number | null>;
  /** Upsert baris (onConflict id); kembalikan jumlah baris BARU yang ditambah. */
  upsertCandles(rows: StoredCandleRow[]): Promise<number>;
}

export interface GapDerivPort {
  fetchCandles(
    symbol: string,
    granularitySec: number,
    count: number,
    end: number | "latest"
  ): Promise<{ epoch: number; open: number; high: number; low: number; close: number }[]>;
}

export interface GapHealResult {
  tf: string;
  filled: number;
  gapSeconds: number;
  pages: number;
  caughtUp: boolean;
  /** Alasan berhenti bila tidak caughtUp (provider kehabisan history / batas page). */
  stoppedReason?: "provider-exhausted" | "max-pages" | "no-gap" | "seeded";
}

export interface GapHealConfig {
  pageSize?: number; // maks count ticks_history Deriv (default 5000)
  maxPages?: number; // batas aman paginasi (default 40)
  delayMs?: number; // jeda antar-page hormati rate limit (default 1200)
  seedCount?: number; // jumlah candle saat DB kosong (default 300)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function toRow(tf: string, c: { epoch: number; open: number; high: number; low: number; close: number }): StoredCandleRow {
  return {
    symbol: "XAUUSD",
    timeframe: tf,
    timestampUtc: c.epoch,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: 0, // Deriv tidak menyediakan volume — bukan angka karangan
    source: "deriv-cfd",
  };
}

/**
 * Interface utama: tutup gap candle untuk satu timeframe.
 * Dependensi di-inject (db, deriv, now) — modul tidak membuat I/O sendiri.
 */
export async function healCandleGap(
  opts: { symbol: string; tf: string; granularity: number },
  ports: { db: GapDbPort; deriv: GapDerivPort; now?: () => number },
  config: GapHealConfig = {}
): Promise<GapHealResult> {
  const { symbol, tf, granularity } = opts;
  const pageSize = config.pageSize ?? 5000;
  const maxPages = config.maxPages ?? 40;
  const delayMs = config.delayMs ?? 1200;
  const seedCount = config.seedCount ?? 300;
  const nowSec = (ports.now ?? (() => Math.floor(Date.now() / 1000)))();
  const currentBucket = Math.floor(nowSec / granularity) * granularity;

  const maxTs = await ports.db.getMaxTimestamp(tf);

  // DB kosong: seed window terbaru supaya chart punya data awal.
  if (maxTs === null) {
    const candles = await ports.deriv.fetchCandles(symbol, granularity, seedCount, "latest");
    const filled = await ports.db.upsertCandles(candles.map((c) => toRow(tf, c)));
    return { tf, filled, gapSeconds: 0, pages: 1, caughtUp: true, stoppedReason: "seeded" };
  }

  const gapSeconds = Math.max(0, nowSec - maxTs);

  // Sudah mengejar bucket sekarang -> tidak ada gap.
  if (maxTs >= currentBucket) {
    return { tf, filled: 0, gapSeconds, pages: 0, caughtUp: true, stoppedReason: "no-gap" };
  }

  const needed = Math.ceil((currentBucket - maxTs) / granularity) + 1;
  let end: number | "latest" = "latest";
  let filled = 0;
  let pages = 0;
  let caughtUp = false;
  let stoppedReason: GapHealResult["stoppedReason"];

  while (pages < maxPages) {
    const count = pages === 0 ? Math.min(needed, pageSize) : pageSize;
    const candles = await ports.deriv.fetchCandles(symbol, granularity, count, end);
    pages++;
    if (candles.length === 0) {
      stoppedReason = "provider-exhausted";
      break;
    }

    const oldest = Math.min(...candles.map((c) => c.epoch));
    const newRows = candles.filter((c) => c.epoch > maxTs).map((c) => toRow(tf, c));
    filled += await ports.db.upsertCandles(newRows);

    // Sudah mencapai data tersimpan -> gap tertutup.
    if (oldest <= maxTs + granularity) {
      caughtUp = true;
      break;
    }
    // Provider mengembalikan lebih sedikit dari diminta -> kehabisan history
    // (atau sisa gap adalah jam market-closed yang tak punya candle). Berhenti.
    if (candles.length < count) {
      stoppedReason = "provider-exhausted";
      break;
    }
    end = oldest - 1;
    if (delayMs > 0 && pages < maxPages) await sleep(delayMs);
  }

  if (!caughtUp && !stoppedReason) stoppedReason = "max-pages";
  return { tf, filled, gapSeconds, pages, caughtUp, stoppedReason };
}
