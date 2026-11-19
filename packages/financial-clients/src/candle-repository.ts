/**
 * candle-repository — modul deep untuk jalur data candle XAUUSD.
 *
 * SATU interface kecil (`getCandles`) menyembunyikan seluruh resolusi:
 *   DB (price_candles) -> CSV expert (H1/intraday) -> estimasi H1 -> sintetis,
 * plus pelabelan provenance dan bentuk response API.
 *
 * Kosakata provenance TUNGGAL: 'deriv-cfd' | 'csv-historical' | 'simulated'.
 * (Kosakata lama 'real'/'estimated'/'unknown' sudah dihapus — estimasi H1
 * tetap dilabeli 'csv-historical' di response API, persis perilaku lama.)
 *
 * Ports & adapters (seam nyata, dua adapter per seam):
 * - DB port  : produksi = adapter drizzle (di-inject apps/api),
 *              tes      = adapter in-memory.
 * - CSV port : produksi = adapter file (cache TTL 5 menit + mtime),
 *              tes      = adapter fixture in-memory.
 *
 * Seam internal (pure, dipakai adapter saudara + tes modul ini):
 * parseCsvLine / parseCandleLine / aggregateCandles / subdivideCandles /
 * binarySearchBefore / resolveCsvWindow. Parser CSV kanonik tinggal di sini;
 * expert-data.ts dan worker backfill-csv.ts memakainya (hapus duplikasi).
 */
import fs from "node:fs";
import readline from "node:readline";
import path from "node:path";
import type { OHLCV, Timeframe } from "@repo/types";
import { COMPLIANCE_DISCLAIMER_FR10 } from "@repo/types";

// ---------------------------------------------------------------------------
// Interface publik (kecil: satu fungsi utama + tipe ports/response)
// ---------------------------------------------------------------------------

/** Satu kosakata provenance untuk seluruh sistem. */
export type CandleProvenance = "deriv-cfd" | "csv-historical" | "simulated";

/**
 * Baris candle dari DB. Kolom tambahan (mis. `id`) diteruskan apa adanya
 * ke response — modul TIDAK memetakan ulang baris DB (perilaku lama API).
 */
export interface StoredCandleRow {
  symbol: string;
  timeframe: string;
  timestampUtc: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  source: CandleProvenance;
}

/**
 * Port DB (seam). Kontrak:
 * - window terurut NAIK (terlama dulu), maksimal `limit` baris;
 * - `to` bersifat INKLUSIF (timestampUtc <= to) — sesuai adapter drizzle;
 * - melempar bila DB tidak bisa diakses; modul fallback ke CSV.
 */
export interface CandleDbPort {
  queryCandles(tf: string, limit: number, to?: number): Promise<StoredCandleRow[]>;
}

/** Baris CSV hasil parse; `isEstimated` hanya untuk baris estimasi intraday. */
export type ParsedCandle = OHLCV & { isEstimated?: boolean };

/**
 * Port CSV (seam). Produksi: file CSV pipeline harga (adapter file di bawah).
 * Tes: fixture in-memory. Kedua seri terurut naik; [] bila tidak tersedia.
 */
export interface CsvSeriesAdapter {
  loadH1(): Promise<OHLCV[]>;
  loadIntraday(tf: "5m" | "15m"): Promise<ParsedCandle[]>;
}

/** Dependensi yang di-inject pemanggil — modul tidak membuat I/O sendiri. */
export interface CandleRepositoryPorts {
  /** Adapter DB; tanpa ini modul langsung ke jalur CSV. */
  db?: CandleDbPort;
  /** Adapter CSV; default = adapter file produksi. */
  csv?: CsvSeriesAdapter;
  /** Direktori data expert untuk kandidat path CSV (default EXTERNAL_DATA_DIR). */
  expertDataDir?: string;
  /** Jam epoch detik untuk generator sintetis (default Date.now). */
  now?: () => number;
  /** RNG untuk generator sintetis (default Math.random). */
  random?: () => number;
}

/** Bentuk response endpoint /api/v1/market/xauusd/candles — PERSIS kontrak lama. */
export interface CandleWindow {
  timeframe: string;
  count: number;
  data: StoredCandleRow[];
  source: CandleProvenance;
  isSimulated: boolean;
  status: "ok" | "simulated" | "unavailable";
  disclaimer: string;
}

/**
 * Candle XAUUSD. `isSimulated: true` menandai candle sintetis yang digenerate
 * ketika dataset historis tidak tersedia — bukan data pasar nyata.
 */
export type XauusdCandle = OHLCV & { isSimulated?: boolean };

/**
 * Interface utama: window candle untuk API.
 * Resolusi DB-first -> CSV -> estimasi H1 -> sintetis; source top-level =
 * source baris terbaru dalam window (perilaku lama API, dipertahankan).
 */
export async function getCandles(
  tf: Timeframe,
  limit: number,
  to: number | undefined,
  ports: CandleRepositoryPorts = {}
): Promise<CandleWindow> {
  // 1. DB (candle Deriv recent + backfill CSV historis, berlabel source).
  let data: StoredCandleRow[] = [];
  let source: CandleProvenance = "deriv-cfd";
  let isSimulated = false;

  if (ports.db) {
    try {
      data = await ports.db.queryCandles(tf, limit, to);
      if (data.length > 0) {
        // Badge jujur: top-level source = source baris terbaru dalam window
        // (window recent -> deriv-cfd; window lama -> csv-historical).
        source = data[data.length - 1]!.source;
      }
    } catch (error) {
      console.warn(
        `[candle-repository] price_candles tidak bisa dibaca (${tf}): ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // 2. Fallback CSV historis bila DB kosong/mati. Synthetic selalu ditandai.
  if (data.length === 0) {
    const fallback = await fetchExpertCandles(tf, limit, to, ports);
    isSimulated = fallback.length > 0 && fallback.every((c) => c.isSimulated === true);
    source = isSimulated ? "simulated" : "csv-historical";
    data = fallback.map((c) => ({
      symbol: c.symbol,
      timeframe: c.timeframe,
      timestampUtc: c.timestampUtc,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
      source,
    }));
  }

  return {
    timeframe: tf,
    count: data.length,
    data,
    source,
    isSimulated,
    status: data.length === 0 ? "unavailable" : isSimulated ? "simulated" : "ok",
    disclaimer: COMPLIANCE_DISCLAIMER_FR10,
  };
}

/**
 * Jalur CSV saja (tanpa DB): CSV expert -> estimasi H1 -> sintetis.
 * Dipakai FinancialClient.fetchXauusdCandles (latest, event-study, daily
 * report, worker) — perilaku lama dipertahankan persis.
 */
export async function fetchExpertCandles(
  timeframe: Timeframe = "15m",
  limit: number = 300,
  to?: number,
  ports: Omit<CandleRepositoryPorts, "db"> = {}
): Promise<XauusdCandle[]> {
  const csv = ports.csv ?? createFileCsvAdapter(ports.expertDataDir);
  const realCandles = await resolveCsvWindow(timeframe, limit, to, csv);
  if (realCandles.length > 0) {
    // Data historis nyata (atau estimasi H1 berlabel) — tanpa isSimulated.
    return realCandles;
  }
  // Fallback synthetic generator — SELALU ditandai isSimulated: true.
  return generateSimulatedCandles(
    timeframe,
    limit,
    ports.now ?? (() => Math.floor(Date.now() / 1000)),
    ports.random ?? Math.random
  );
}

// ---------------------------------------------------------------------------
// Seam internal: parser CSV kanonik (satu tempat untuk seluruh repo)
// ---------------------------------------------------------------------------

/** Parse satu baris CSV dengan dukungan field berkutip ganda. */
export function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      cells.push(current);
      current = "";
    } else {
      current += ch;
    }
  }

  cells.push(current);
  return cells;
}

function toNumberOr(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (trimmed === "") return fallback;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Parse satu baris candle CSV (time,open,high,low,close,volume[,is_real]).
 * Baris header/rusak -> null. Kolom ke-6 = 0 menandai estimasi intraday
 * (perilaku lama dipertahankan, termasuk quirk kolom spread H1).
 */
export function parseCandleLine(line: string, tf: Timeframe): ParsedCandle | null {
  const parts = parseCsvLine(line);
  if (parts.length < 5) return null;

  const timeStr = (parts[0] ?? "").trim();
  if (!timeStr || /^(time|timestamp|date_time|date)\s*,?$/i.test(timeStr)) return null;

  const open = Number((parts[1] ?? "").trim());
  const high = Number((parts[2] ?? "").trim());
  const low = Number((parts[3] ?? "").trim());
  const close = Number((parts[4] ?? "").trim());
  if (![open, high, low, close].every((v) => Number.isFinite(v))) return null;

  const timestampUtc = Math.floor(new Date(timeStr).getTime() / 1000);
  if (!Number.isFinite(timestampUtc)) return null;

  // Kolom `is_real` (1 = print nyata, 0 = estimasi). Hanya estimasi yang
  // ditandai; print asli tidak memiliki properti ini sama sekali.
  const rawFlag = parts[6];
  const isEstimated =
    rawFlag !== undefined && rawFlag.trim() !== "" && Number(rawFlag.trim()) === 0;

  return {
    symbol: "XAUUSD",
    timeframe: tf,
    timestampUtc,
    open,
    high,
    low,
    close,
    volume: toNumberOr(parts[5], 100),
    ...(isEstimated ? { isEstimated: true } : {}),
  };
}

/** Stream-parse CSV candle baris demi baris agar memori tetap terbatas. */
async function streamParseCandles(filePath: string, tf: Timeframe): Promise<ParsedCandle[]> {
  const candles: ParsedCandle[] = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const candle = parseCandleLine(trimmed, tf);
      if (candle) candles.push(candle);
    }
  } finally {
    rl.close();
  }

  candles.sort((a, b) => a.timestampUtc - b.timestampUtc);
  return candles;
}

/** Indeks baris terakhir dengan timestampUtc < targetTs (eksklusif), atau -1. */
export function binarySearchBefore(candles: OHLCV[], targetTs: number): number {
  let low = 0;
  let high = candles.length - 1;
  let bestIdx = -1;

  while (low <= high) {
    const mid = (low + high) >> 1;
    if (candles[mid]!.timestampUtc < targetTs) {
      bestIdx = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return bestIdx;
}

/**
 * Agregasi OHLCV per bucket floor(ts/intervalSec)*intervalSec.
 * Input terurut naik: open = pertama, high = max, low = min, close = terakhir,
 * volume = jumlah. Bucket terakhir boleh parsial (data nyata, bukan karangan).
 */
export function aggregateCandles(raw: OHLCV[], intervalSec: number, tf: Timeframe): OHLCV[] {
  if (raw.length === 0) return [];
  const aggregated: OHLCV[] = [];

  let bucketTs = Math.floor(raw[0]!.timestampUtc / intervalSec) * intervalSec;
  let o = raw[0]!.open;
  let h = raw[0]!.high;
  let l = raw[0]!.low;
  let c = raw[0]!.close;
  let v = raw[0]!.volume;

  for (let i = 1; i < raw.length; i++) {
    const cur = raw[i]!;
    const curBucket = Math.floor(cur.timestampUtc / intervalSec) * intervalSec;

    if (curBucket === bucketTs) {
      h = Math.max(h, cur.high);
      l = Math.min(l, cur.low);
      c = cur.close;
      v += cur.volume;
    } else {
      aggregated.push({
        symbol: "XAUUSD",
        timeframe: tf,
        timestampUtc: bucketTs,
        open: o,
        high: h,
        low: l,
        close: c,
        volume: v,
      });

      bucketTs = curBucket;
      o = cur.open;
      h = cur.high;
      l = cur.low;
      c = cur.close;
      v = cur.volume;
    }
  }
  aggregated.push({
    symbol: "XAUUSD",
    timeframe: tf,
    timestampUtc: bucketTs,
    open: o,
    high: h,
    low: l,
    close: c,
    volume: v,
  });

  return aggregated;
}

// Faktor wick estimasi subdivisi H1 (satu tempat, sebelumnya duplikat).
const WICK_TREND = 0.15; // wick searah arah bar (bull: high, bear: low)
const WICK_COUNTER = 0.05; // wick berlawanan arah bar

/**
 * ESTIMASI SAJA: subdivisi bar H1 menjadi bar intraday. Dipakai hanya sebagai
 * fallback berlabel ketika CSV intraday nyata tidak tersedia.
 */
export function subdivideCandles(
  raw: OHLCV[],
  subCount: number,
  subSec: number,
  tf: Timeframe
): OHLCV[] {
  const result: OHLCV[] = [];
  for (const item of raw) {
    const range = item.high - item.low;
    const isBull = item.close >= item.open;

    for (let step = 0; step < subCount; step++) {
      const subTs = item.timestampUtc + step * subSec;
      const progress = (step + 1) / subCount;
      const prevProgress = step / subCount;

      const subOpen = step === 0 ? item.open : Number((item.open + (item.close - item.open) * prevProgress).toFixed(2));
      const subClose = step === subCount - 1 ? item.close : Number((item.open + (item.close - item.open) * progress).toFixed(2));
      const subHigh = Number((Math.max(subOpen, subClose) + (isBull ? range * WICK_TREND : range * WICK_COUNTER)).toFixed(2));
      const subLow = Number((Math.min(subOpen, subClose) - (!isBull ? range * WICK_TREND : range * WICK_COUNTER)).toFixed(2));

      result.push({
        symbol: "XAUUSD",
        timeframe: tf,
        timestampUtc: subTs,
        open: subOpen,
        high: Math.min(item.high, Math.max(subHigh, subOpen, subClose)),
        low: Math.max(item.low, Math.min(subLow, subOpen, subClose)),
        close: subClose,
        volume: Math.floor(item.volume / subCount),
      });
    }
  }
  return result;
}

function stripEstimated(candle: ParsedCandle): OHLCV {
  return {
    symbol: candle.symbol,
    timeframe: candle.timeframe,
    timestampUtc: candle.timestampUtc,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
  };
}

/**
 * Resolusi window CSV murni (tanpa I/O): H1 -> agregasi 4h/1D, subdivisi
 * intraday, atau CSV intraday nyata bila tersedia. `to` EKSKLUSIF di sini
 * (binarySearchBefore) — berbeda dengan port DB yang inklusif; keduanya
 * perilaku lama yang dipertahankan. Mengembalikan [] bila H1 tidak ada.
 */
export async function resolveCsvWindow(
  timeframe: Timeframe,
  limit: number,
  to: number | undefined,
  csv: CsvSeriesAdapter
): Promise<OHLCV[]> {
  const rawH1 = await csv.loadH1();
  if (rawH1.length === 0) return [];

  let targetSeries: OHLCV[];
  if (timeframe === "4h") {
    targetSeries = aggregateCandles(rawH1, 4 * 3600, "4h");
  } else if (timeframe === "1D") {
    targetSeries = aggregateCandles(rawH1, 24 * 3600, "1D");
  } else if (timeframe === "15m" || timeframe === "5m") {
    const subCount = timeframe === "15m" ? 4 : 12;
    const subSec = timeframe === "15m" ? 900 : 300;
    const intraday = await csv.loadIntraday(timeframe);
    const hasUsableIntraday =
      intraday.length > 0 && (to === undefined || isNaN(to) || to > intraday[0]!.timestampUtc);

    if (hasUsableIntraday) {
      targetSeries = intraday.map(stripEstimated);
    } else {
      // Belum ada CSV intraday nyata (atau window diminta mendahuluinya):
      // turunkan bar dari H1 sebagai estimasi.
      const neededH1 = Math.ceil(limit / subCount) + 5;
      let windowedH1 = rawH1;
      let found = true;
      if (to !== undefined && !isNaN(to)) {
        const endH1Idx = binarySearchBefore(rawH1, to);
        if (endH1Idx === -1) {
          found = false;
        } else {
          const startH1Idx = Math.max(0, endH1Idx - neededH1 + 1);
          windowedH1 = rawH1.slice(startH1Idx, Math.min(rawH1.length, endH1Idx + 2));
        }
      } else {
        windowedH1 = rawH1.slice(-neededH1);
      }
      targetSeries = found ? subdivideCandles(windowedH1, subCount, subSec, timeframe) : [];
    }
  } else if (timeframe === "30m") {
    // Tidak ada CSV intraday 30m; turunkan dari H1 dan tandai estimasi.
    const neededH1 = Math.ceil(limit / 2) + 5;
    let windowedH1 = rawH1;
    if (to !== undefined && !isNaN(to)) {
      const endH1Idx = binarySearchBefore(rawH1, to);
      windowedH1 =
        endH1Idx === -1
          ? []
          : rawH1.slice(Math.max(0, endH1Idx - neededH1 + 1), Math.min(rawH1.length, endH1Idx + 2));
    } else {
      windowedH1 = rawH1.slice(-neededH1);
    }
    targetSeries = subdivideCandles(windowedH1, 2, 1800, "30m");
  } else if (timeframe === "1m") {
    const neededH1 = Math.ceil(limit / 60) + 5;
    let windowedH1 = rawH1;
    if (to !== undefined && !isNaN(to)) {
      const endH1Idx = binarySearchBefore(rawH1, to);
      windowedH1 =
        endH1Idx === -1
          ? []
          : rawH1.slice(Math.max(0, endH1Idx - neededH1 + 1), Math.min(rawH1.length, endH1Idx + 2));
    } else {
      windowedH1 = rawH1.slice(-neededH1);
    }
    targetSeries = subdivideCandles(windowedH1, 60, 60, "1m");
  } else {
    targetSeries = rawH1;
  }

  if (to !== undefined && !isNaN(to)) {
    const bestIdx = binarySearchBefore(targetSeries, to);
    if (bestIdx === -1) return [];
    const startIdx = Math.max(0, bestIdx - limit + 1);
    return targetSeries.slice(startIdx, bestIdx + 1);
  }

  return targetSeries.slice(-limit);
}

/** Generator sintetis (fallback terakhir) — selalu berlabel isSimulated. */
function generateSimulatedCandles(
  timeframe: Timeframe,
  limit: number,
  now: () => number,
  random: () => number
): XauusdCandle[] {
  const nowSec = now();
  const intervalSec =
    timeframe === "1m"
      ? 60
      : timeframe === "5m"
      ? 300
      : timeframe === "15m"
      ? 900
      : timeframe === "30m"
      ? 1800
      : timeframe === "1h"
      ? 3600
      : timeframe === "4h"
      ? 14400
      : 86400;

  const basePrice = 4122.75;
  const candles: XauusdCandle[] = [];

  let curClose = basePrice;
  for (let i = limit; i >= 0; i--) {
    const ts = nowSec - i * intervalSec;
    const variation = (random() - 0.48) * 3.5;
    const open = curClose;
    const close = Number((open + variation).toFixed(2));
    const high = Number((Math.max(open, close) + random() * 2.0).toFixed(2));
    const low = Number((Math.min(open, close) - random() * 2.0).toFixed(2));
    const volume = Math.floor(random() * 800) + 100;

    curClose = close;
    candles.push({
      symbol: "XAUUSD",
      timeframe,
      timestampUtc: ts,
      open,
      high,
      low,
      close,
      volume,
      isSimulated: true,
    });
  }

  return candles;
}

// ---------------------------------------------------------------------------
// Adapter CSV produksi (file): path resolution + cache TTL 5 menit + mtime.
// Dipindah dari expert-data.ts — satu tempat, dipakai semua pemanggil.
// ---------------------------------------------------------------------------

const PRICE_DIR_REL = path.join("services", "sentiment-analysis", "data", "raw", "price");

/** Root repo, portabel: `REPO_ROOT` di env atau diturunkan dari cwd. */
function repoRoot(): string {
  return process.env.REPO_ROOT
    ? path.resolve(process.env.REPO_ROOT)
    : path.resolve(process.cwd(), "../..");
}

const REFRESHED_H1_CSV = path.resolve(repoRoot(), PRICE_DIR_REL, "xauusd_h1_complete.csv");
const EXPERT_DATA_DIR = process.env.EXTERNAL_DATA_DIR || "";
const REPO_ROOT = repoRoot();

/** Baris CSV hasil parse tinggal di memori maksimal 5 menit sebelum dibaca ulang. */
const CACHE_TTL_MS = 5 * 60 * 1000;

interface FileStamp {
  mtimeMs: number;
  size: number;
}

interface CsvCacheEntry {
  data: ParsedCandle[];
  loadedAtMs: number;
  mtimeMs: number;
  size: number;
}

// Cache in-memory untuk query candle ultra-cepat (<1ms setelah baca pertama).
const csvCaches = new Map<string, CsvCacheEntry>();
const csvInFlight = new Map<string, Promise<ParsedCandle[]>>();
let cachedH1Candles: OHLCV[] | null = null;

function statFile(filePath: string): FileStamp | null {
  try {
    const stats = fs.statSync(filePath);
    return { mtimeMs: stats.mtimeMs, size: stats.size };
  } catch {
    return null;
  }
}

function isCacheFresh(entry: CsvCacheEntry, stamp: FileStamp | null): boolean {
  if (Date.now() - entry.loadedAtMs >= CACHE_TTL_MS) return false;
  if (!stamp) return false;
  return entry.mtimeMs === stamp.mtimeMs && entry.size === stamp.size;
}

function resolveH1Path(dataDir: string): string | null {
  // Kandidat relatif cwd dulu (mengikuti app yang berjalan), path absolut
  // repo terakhir sebagai fallback — perilaku lama expert-data.
  const candidates = [
    path.resolve(process.cwd(), "../../", PRICE_DIR_REL, "xauusd_h1_complete.csv"),
    path.resolve(process.cwd(), "..", PRICE_DIR_REL, "xauusd_h1_complete.csv"),
    path.resolve(process.cwd(), PRICE_DIR_REL, "xauusd_h1_complete.csv"),
    REFRESHED_H1_CSV,
    path.join(dataDir, "XAUUSD_H1.csv"),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // Abaikan kandidat yang tidak bisa dibaca.
    }
  }
  return null;
}

/** Kandidat lokasi CSV intraday nyata yang ditulis pipeline harga. */
function resolveIntradayPath(tf: "5m" | "15m"): string | null {
  const filename = tf === "5m" ? "xauusd_m5.csv" : "xauusd_m15.csv";
  const candidates = [
    path.resolve(process.cwd(), "../../", PRICE_DIR_REL, filename),
    path.resolve(process.cwd(), "..", PRICE_DIR_REL, filename),
    path.resolve(process.cwd(), PRICE_DIR_REL, filename),
    path.resolve(REPO_ROOT, PRICE_DIR_REL, filename),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // Abaikan kandidat yang tidak bisa dibaca.
    }
  }
  return null;
}

/**
 * Baca CSV candle dengan TTL 5 menit + cek mtime. Pemanggil concurrent
 * berbagi satu pembacaan in-flight sehingga cache dingin hanya diparse sekali.
 */
async function readCsv(filePath: string, tf: Timeframe): Promise<ParsedCandle[]> {
  const key = `${tf}:${filePath}`;
  const stamp = statFile(filePath);
  const cached = csvCaches.get(key);
  if (cached && isCacheFresh(cached, stamp)) {
    return cached.data;
  }

  const existing = csvInFlight.get(key);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const parsed = await streamParseCandles(filePath, tf);
      if (parsed.length > 0) {
        csvCaches.set(key, {
          data: parsed,
          loadedAtMs: Date.now(),
          mtimeMs: stamp?.mtimeMs ?? 0,
          size: stamp?.size ?? 0,
        });
      }
      return parsed;
    } catch (error) {
      console.warn(`[candle-repository] gagal membaca CSV ${tf} di ${filePath}:`, error);
      return [];
    } finally {
      csvInFlight.delete(key);
    }
  })();

  csvInFlight.set(key, promise);
  return promise;
}

/**
 * Adapter CSV produksi: membaca file pipeline harga dengan cache.
 * `dataDir` = direktori data expert (kandidat fallback XAUUSD_H1.csv).
 */
export function createFileCsvAdapter(dataDir: string = EXPERT_DATA_DIR): CsvSeriesAdapter {
  return {
    async loadH1(): Promise<OHLCV[]> {
      const filePath = resolveH1Path(dataDir);
      if (!filePath) return cachedH1Candles ?? [];
      const parsed = await readCsv(filePath, "1h");
      if (parsed.length === 0) return cachedH1Candles ?? [];
      cachedH1Candles = parsed.map(stripEstimated);
      return cachedH1Candles;
    },
    async loadIntraday(tf: "5m" | "15m"): Promise<ParsedCandle[]> {
      const filePath = resolveIntradayPath(tf);
      if (!filePath) return [];
      return readCsv(filePath, tf);
    },
  };
}
