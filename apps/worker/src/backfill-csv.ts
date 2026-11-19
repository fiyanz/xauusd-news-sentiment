/**
 * Backfill history harga PENUH (2010+) dari CSV H1 ke price_candles (TiDB).
 *
 * Provenance JUJUR:
 * - Semua baris CSV diberi source='csv-historical'; volume apa adanya dari CSV
 *   (tahun awal memang 0 di sumber — bukan angka karangan, tidak diimputasi).
 * - 4h diagregasi dari H1 per bucket 4 jam UTC: open=first, high=max, low=min,
 *   close=last, volume=sum. Ini agregasi data nyata, bukan estimasi.
 * - 15m/30m TIDAK dibuat dari CSV (tidak ada data intraday nyata di CSV H1;
 *   timeframe itu tetap Deriv-only sesuai keputusan user).
 *
 * Idempotent: onConflictDoNothing(id). Id CSV = `XAUUSD_<tf>_<epoch>` sama
 * dengan id Deriv, jadi pada overlap baris Deriv recent MENANG (tidak ditimpa).
 *
 * Jalankan dari apps/worker: bunx tsx src/backfill-csv.ts
 * DATABASE_URL dibaca otomatis dari .env root oleh @repo/database.
 */
import fs from "node:fs";
import path from "node:path";
import { db, priceCandles, sql, client, and, eq } from "@repo/database";
import { parseCsvLine, aggregateCandles } from "@repo/financial-clients";
import type { OHLCV } from "@repo/types";

const BATCH = 500; // ukuran batch insert (1000 memicu CONNECTION_CLOSED di gateway TiDB)
const MAX_ATTEMPTS = 4; // retry per batch; aman karena onConflictDoNothing idempotent
const H1_SEC = 3600;
const H4_SEC = 14400;
const SOURCE = "csv-historical";

// Path CSV relatif repo root (cwd saat dijalankan = apps/worker).
const root = process.env.REPO_ROOT
  ? path.resolve(process.env.REPO_ROOT)
  : path.resolve(process.cwd(), "../..");
const CSV_PATH = path.join(
  root,
  "services/sentiment-analysis/data/raw/price/xauusd_h1_complete.csv"
);

interface CsvCandle {
  epoch: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * Parse CSV H1 (header: time,open,high,low,close,volume,spread) memakai
 * parser CSV kanonik candle-repository (parseCsvLine, sadar kutip ganda).
 * time '2010-01-01 00:00:00+00:00' -> epoch detik UTC. Baris rusak dilewati
 * (dihitung, bukan diam-diam dibuang). Duplikat epoch: baris pertama menang.
 */
function parseCsv(): { rows: CsvCandle[]; skipped: number; duplicates: number } {
  const text = fs.readFileSync(CSV_PATH, "utf-8");
  const lines = text.split(/\r?\n/);
  const byEpoch = new Map<number, CsvCandle>();
  let skipped = 0;
  let duplicates = 0;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    const cells = parseCsvLine(line);
    if (cells.length < 6) {
      skipped++;
      continue;
    }
    // Spasi -> 'T' supaya format ISO 8601 valid dan Date.parse deterministik.
    const ms = Date.parse(cells[0]!.trim().replace(" ", "T"));
    const open = Number(cells[1]);
    const high = Number(cells[2]);
    const low = Number(cells[3]);
    const close = Number(cells[4]);
    const volume = Number(cells[5]);
    if (
      !Number.isFinite(ms) ||
      ![open, high, low, close, volume].every(Number.isFinite)
    ) {
      skipped++;
      continue;
    }
    const epoch = Math.floor(ms / 1000);
    if (epoch % H1_SEC !== 0) {
      // Candle H1 harus tepat di batas jam UTC.
      skipped++;
      continue;
    }
    if (byEpoch.has(epoch)) {
      duplicates++;
      continue;
    }
    byEpoch.set(epoch, { epoch, open, high, low, close, volume });
  }

  const rows = [...byEpoch.values()].sort((a, b) => a.epoch - b.epoch);
  return { rows, skipped, duplicates };
}

/**
 * Agregasi H1 -> 4h per bucket floor(epoch/14400)*14400 — delegate ke
 * aggregateCandles kanonik (candle-repository), satu tempat untuk semua
 * agregasi. Input terurut naik: open = jam pertama, close = jam terakhir,
 * high = max, low = min, volume = jumlah volume H1 (nyata dari CSV).
 * Bucket terakhir boleh parsial (agregasi jam yang tersedia, bukan karangan).
 */
function aggregate4h(rows: CsvCandle[]): CsvCandle[] {
  const h1: OHLCV[] = rows.map((r) => ({
    symbol: "XAUUSD",
    timeframe: "1h",
    timestampUtc: r.epoch,
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    volume: r.volume,
  }));
  return aggregateCandles(h1, H4_SEC, "4h").map((c) => ({
    epoch: c.timestampUtc,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
  }));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Insert per batch; konflik id (baris Deriv recent) dilewati, bukan ditimpa. */
async function insertRows(tf: string, rows: CsvCandle[]): Promise<void> {
  // Resume: insert ascending + batch atomik -> semua epoch <= max yang sudah
  // tersimpan pasti masuk. Lewati agar rerun tidak mengirim ulang puluhan ribu
  // baris konflik (latency gateway TiDB tinggi).
  const [existing] = await db
    .select({ maxTs: sql<number | null>`max(${priceCandles.timestampUtc})` })
    .from(priceCandles)
    .where(and(eq(priceCandles.timeframe, tf), eq(priceCandles.source, SOURCE)));
  const maxTs = existing?.maxTs == null ? null : Number(existing.maxTs);
  const pending = maxTs == null ? rows : rows.filter((r) => r.epoch > maxTs);
  if (pending.length < rows.length) {
    console.log(
      `[backfill-csv] ${tf}: resume — ${rows.length - pending.length} baris sudah ada, lanjut ${pending.length}`
    );
  }
  for (let i = 0; i < pending.length; i += BATCH) {
    const batch = pending.slice(i, i + BATCH).map((r) => ({
      id: `XAUUSD_${tf}_${r.epoch}`,
      symbol: "XAUUSD",
      timeframe: tf,
      timestampUtc: r.epoch,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume,
      source: SOURCE,
    }));
    // Retry dengan backoff: gateway TiDB kadang menutup koneksi (CONNECTION_CLOSED).
    // onConflictDoNothing membuat retry aman (baris yang sudah masuk dilewati).
    for (let attempt = 1; ; attempt++) {
      try {
        await db.insert(priceCandles).values(batch).onConflictDoNothing();
        break;
      } catch (err) {
        if (attempt >= MAX_ATTEMPTS) throw err;
        console.warn(
          `[backfill-csv] ${tf} batch ${i / BATCH + 1} gagal (percobaan ${attempt}): ` +
            `${err instanceof Error ? err.message : String(err)} — retry...`
        );
        await sleep(1000 * attempt);
      }
    }
    const done = Math.min(i + BATCH, pending.length);
    if (done % 10000 === 0 || done === pending.length) {
      console.log(`[backfill-csv] ${tf}: ${done}/${pending.length} baris diproses`);
    }
  }
}

(async () => {
  if (!fs.existsSync(CSV_PATH)) {
    console.error(`[backfill-csv] CSV tidak ditemukan: ${CSV_PATH}`);
    process.exit(1);
  }

  const { rows, skipped, duplicates } = parseCsv();
  if (rows.length === 0) {
    console.error("[backfill-csv] Tidak ada baris H1 valid — batal (tidak ada yang di-insert).");
    process.exit(1);
  }
  const first = rows[0]!;
  const last = rows[rows.length - 1]!;
  console.log(
    `[backfill-csv] CSV H1: ${rows.length} baris valid ` +
      `(${new Date(first.epoch * 1000).toISOString()} .. ${new Date(last.epoch * 1000).toISOString()}), ` +
      `skipped=${skipped}, duplikat=${duplicates}`
  );

  // 1. H1 apa adanya dari CSV (volume nyata CSV, termasuk 0 di tahun awal).
  await insertRows("1h", rows);

  // 2. 4h agregasi dari H1. 15m/30m sengaja TIDAK difabrikasi.
  const h4 = aggregate4h(rows);
  console.log(`[backfill-csv] Agregasi 4h: ${h4.length} bucket dari ${rows.length} candle H1`);
  await insertRows("4h", h4);

  // 3. Verifikasi langsung dari DB: count per (timeframe, source) + rentang waktu.
  const counts = await db
    .select({
      tf: priceCandles.timeframe,
      source: priceCandles.source,
      n: sql<number>`count(*)`,
      minTs: sql<number>`min(${priceCandles.timestampUtc})`,
      maxTs: sql<number>`max(${priceCandles.timestampUtc})`,
    })
    .from(priceCandles)
    .groupBy(priceCandles.timeframe, priceCandles.source)
    .orderBy(priceCandles.timeframe, priceCandles.source);
  console.log("[backfill-csv] COUNTS TiDB (timeframe, source, n, rentang):");
  for (const c of counts) {
    const lo = new Date(Number(c.minTs) * 1000).toISOString().slice(0, 10);
    const hi = new Date(Number(c.maxTs) * 1000).toISOString().slice(0, 10);
    console.log(`  ${c.tf}\t${c.source}\tn=${c.n}\t${lo} .. ${hi}`);
  }

  await client.end();
  process.exit(0);
})().catch(async (err) => {
  console.error("[backfill-csv] GAGAL:", err instanceof Error ? err.message : String(err));
  await client.end().catch(() => {});
  process.exit(1);
});
