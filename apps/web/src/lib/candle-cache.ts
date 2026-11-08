import fs from "fs";
import path from "path";
import readline from "readline";

import { repoRoot } from "./paths";

export interface CandleData {
  timestampUtc: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /**
   * True when the bar was derived from H1 instead of being a real intraday
   * print (either subdivided from H1, or flagged `is_real = 0` in the raw CSV).
   */
  isEstimated?: boolean;
}

/**
 * `real`        -> bars come from a real intraday dataset.
 * `estimated`   -> bars are H1-derived and must never be presented as prints.
 * `unknown`     -> provenance could not be determined.
 */
export type CandleSource = "real" | "estimated" | "unknown";

export interface CandleSeriesResult {
  symbol: string;
  timeframe: string;
  count: number;
  data: CandleData[];
  source: CandleSource;
  /** Number of bars in `data` that are H1-derived estimates, not real prints. */
  estimatedCount: number;
  disclaimer: string;
}

export const CANDLE_SERIES_DISCLAIMER = "FR-10: Research Analytics Only • Non-Advisory";

/** Parsed CSV rows stay in memory for at most 5 minutes before being re-read. */
const CACHE_TTL_MS = 5 * 60 * 1000;
/** Files are read in 1 MiB chunks instead of one giant `readFileSync` allocation. */
const FILE_CHUNK_BYTES = 1024 * 1024;
const DEFAULT_VOLUME = 100;
const DEFAULT_LIMIT = 250;
const MAX_LIMIT = 5000;

const DATASET_ROOT = repoRoot();
const PRICE_DIR_REL = path.join("services", "sentiment-analysis", "data", "raw", "price");

// In-memory cache singletons
let h1Cache: CacheEntry<CandleData[]> | null = null;
const intradayCache = new Map<string, CacheEntry<CandleData[]>>();
let lastCandlePrice: number | null = null;
let lastCandleSource: CandleSource = "unknown";

interface FileStamp {
  mtimeMs: number;
  size: number;
}

interface CacheEntry<T> {
  data: T;
  loadedAtMs: number;
  mtimeMs: number;
  size: number;
}

export function findCsvPath(): string | null {
  const candidates = [
    path.resolve(process.cwd(), "../../services/sentiment-analysis/data/raw/price/xauusd_h1_complete.csv"),
    path.resolve(process.cwd(), "services/sentiment-analysis/data/raw/price/xauusd_h1_complete.csv"),
    path.resolve(repoRoot(), "services/sentiment-analysis/data/raw/price/xauusd_h1_complete.csv"),
  ];

  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return c;
    }
  }
  return null;
}

function repoRootCandidates(): string[] {
  return [
    path.resolve(process.cwd(), "../.."),
    path.resolve(process.cwd(), ".."),
    path.resolve(process.cwd()),
    DATASET_ROOT,
  ];
}

/** Candidate locations for the real intraday CSVs written by the price pipeline. */
export function intradayCsvCandidates(tf: "5m" | "15m"): string[] {
  const filename = tf === "5m" ? "xauusd_m5.csv" : "xauusd_m15.csv";
  return repoRootCandidates().map((root) => path.join(root, PRICE_DIR_REL, filename));
}

export function findIntradayCsvPath(tf: "5m" | "15m"): string | null {
  for (const candidate of intradayCsvCandidates(tf)) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // Ignore unreadable candidates.
    }
  }
  return null;
}

function statFile(filePath: string): FileStamp | null {
  try {
    const stats = fs.statSync(filePath);
    return { mtimeMs: stats.mtimeMs, size: stats.size };
  } catch {
    return null;
  }
}

function isCacheFresh(entry: CacheEntry<unknown>, stamp: FileStamp | null): boolean {
  if (Date.now() - entry.loadedAtMs >= CACHE_TTL_MS) return false;
  if (!stamp) return false;
  return entry.mtimeMs === stamp.mtimeMs && entry.size === stamp.size;
}

/**
 * Read a file in bounded chunks. Avoids the single multi-megabyte string
 * allocation (and the transient 2x memory spike) of `readFileSync(path, "utf8")`.
 */
function readFileBuffered(filePath: string): string {
  const fd = fs.openSync(filePath, "r");
  try {
    const { size } = fs.fstatSync(fd);
    if (size === 0) return "";
    const buffer = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const chunk = Math.min(FILE_CHUNK_BYTES, size - offset);
      const bytesRead = fs.readSync(fd, buffer, offset, chunk, offset);
      if (bytesRead <= 0) break;
      offset += bytesRead;
    }
    return buffer.toString("utf-8");
  } finally {
    fs.closeSync(fd);
  }
}

function toNumberOr(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (trimmed === "") return fallback;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : fallback;
}

/** Parse a single CSV row honouring double-quoted fields. */
function parseCsvLine(line: string): string[] {
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

/** Parse a single CSV row. Returns `null` for headers and malformed rows. */
export function parseCandleCsvLine(line: string): CandleData | null {
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

  // `is_real` column (1 = real print, 0 = estimated). Only estimates are
  // flagged; genuine prints omit the property entirely.
  const rawFlag = parts[6];
  const isEstimated =
    rawFlag !== undefined && rawFlag.trim() !== "" && Number(rawFlag.trim()) === 0;

  return {
    timestampUtc,
    open,
    high,
    low,
    close,
    volume: toNumberOr(parts[5], DEFAULT_VOLUME),
    ...(isEstimated ? { isEstimated: true } : {}),
  };
}

/** Parse a whole CSV document into chronologically sorted candles. */
export function parseCandleCsv(content: string): CandleData[] {
  const candles: CandleData[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const candle = parseCandleCsvLine(trimmed);
    if (candle) candles.push(candle);
  }
  candles.sort((a, b) => a.timestampUtc - b.timestampUtc);
  return candles;
}

/** Stream-parse a CSV file line by line so memory stays bounded on large files. */
async function streamParseCandleCsv(filePath: string): Promise<CandleData[]> {
  const candles: CandleData[] = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity,
  });

  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const candle = parseCandleCsvLine(trimmed);
      if (candle) candles.push(candle);
    }
  } finally {
    rl.close();
  }

  candles.sort((a, b) => a.timestampUtc - b.timestampUtc);
  return candles;
}

export function loadH1Data(): CandleData[] {
  const csvPath = findCsvPath();
  if (!csvPath) {
    console.warn("[CandleCache] CSV file not found in candidate paths");
    return h1Cache?.data ?? [];
  }

  const stamp = statFile(csvPath);
  if (h1Cache && isCacheFresh(h1Cache, stamp)) {
    return h1Cache.data;
  }

  try {
    const parsed = parseCandleCsv(readFileBuffered(csvPath));
    if (parsed.length === 0) {
      // Keep serving the previous snapshot when the file is momentarily empty.
      return h1Cache?.data ?? [];
    }

    h1Cache = {
      data: parsed,
      loadedAtMs: Date.now(),
      mtimeMs: stamp?.mtimeMs ?? 0,
      size: stamp?.size ?? 0,
    };
    lastCandlePrice = parsed[parsed.length - 1]!.close;
    return parsed;
  } catch (error) {
    console.warn("[CandleCache] failed to read H1 CSV:", error);
    return h1Cache?.data ?? [];
  }
}

/**
 * Load the real intraday series for `5m` / `15m` from the price pipeline CSV.
 * Returns `[]` when the file does not exist yet — callers must then fall back
 * to the H1-derived estimate and label it as such.
 */
export async function loadIntradayCandles(tf: "5m" | "15m"): Promise<CandleData[]> {
  const filePath = findIntradayCsvPath(tf);
  const stamp = filePath ? statFile(filePath) : null;
  const cached = intradayCache.get(tf);

  if (cached && isCacheFresh(cached, stamp)) {
    return cached.data;
  }
  if (!filePath || !stamp) {
    // File gone or unreadable: tolerate the previous snapshot for the
    // remainder of the TTL, never indefinitely.
    return cached && Date.now() - cached.loadedAtMs < CACHE_TTL_MS ? cached.data : [];
  }

  try {
    const parsed = await streamParseCandleCsv(filePath);
    if (parsed.length === 0) {
      return cached?.data ?? [];
    }

    intradayCache.set(tf, {
      data: parsed,
      loadedAtMs: Date.now(),
      mtimeMs: stamp.mtimeMs,
      size: stamp.size,
    });
    return parsed;
  } catch (error) {
    console.warn(`[CandleCache] failed to read ${tf} intraday CSV:`, error);
    return cached?.data ?? [];
  }
}

export function getLastCachedPrice(): number | null {
  if (!h1Cache) {
    loadH1Data();
  }
  return lastCandlePrice;
}

/** Provenance of the most recent candle series produced by this module. */
export function getLastCandleSource(): CandleSource {
  return lastCandleSource;
}

function clampLimit(limit: number): number {
  const value = Math.floor(Number(limit));
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_LIMIT;
  return Math.min(value, MAX_LIMIT);
}

function countEstimated(candles: CandleData[]): number {
  let total = 0;
  for (const candle of candles) {
    if (candle.isEstimated === true) total += 1;
  }
  return total;
}

// Binary search to find greatest index where timestampUtc < target
export function binarySearchBefore(candles: CandleData[], targetTs: number): number {
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

// Aggregate H1 into 4H or 1D
export function aggregateCandles(raw: CandleData[], intervalSec: number): CandleData[] {
  if (raw.length === 0) return [];
  const aggregated: CandleData[] = [];

  let currentBucketTs = Math.floor(raw[0]!.timestampUtc / intervalSec) * intervalSec;
  let currentOpen = raw[0]!.open;
  let currentHigh = raw[0]!.high;
  let currentLow = raw[0]!.low;
  let currentClose = raw[0]!.close;
  let currentVol = raw[0]!.volume;

  for (let i = 1; i < raw.length; i++) {
    const c = raw[i]!;
    const bucket = Math.floor(c.timestampUtc / intervalSec) * intervalSec;

    if (bucket === currentBucketTs) {
      currentHigh = Math.max(currentHigh, c.high);
      currentLow = Math.min(currentLow, c.low);
      currentClose = c.close;
      currentVol += c.volume;
    } else {
      aggregated.push({
        timestampUtc: currentBucketTs,
        open: currentOpen,
        high: currentHigh,
        low: currentLow,
        close: currentClose,
        volume: currentVol,
      });

      currentBucketTs = bucket;
      currentOpen = c.open;
      currentHigh = c.high;
      currentLow = c.low;
      currentClose = c.close;
      currentVol = c.volume;
    }
  }

  // Push final bucket
  aggregated.push({
    timestampUtc: currentBucketTs,
    open: currentOpen,
    high: currentHigh,
    low: currentLow,
    close: currentClose,
    volume: currentVol,
  });

  return aggregated;
}

// Subdivide H1 into intraday bars (15m or 5m) preserving OHLC envelope.
// NOTE: this is an ESTIMATE. It must only be used when no real intraday CSV
// is available, and the result must be labelled as estimated.
export function subdivideCandles(raw: CandleData[], subCount: number, subSec: number): CandleData[] {
  const result: CandleData[] = [];
  for (const h of raw) {
    const range = h.high - h.low;
    const isBull = h.close >= h.open;

    for (let step = 0; step < subCount; step++) {
      const subTs = h.timestampUtc + step * subSec;
      const progress = (step + 1) / subCount;
      const prevProgress = step / subCount;

      const subOpen = step === 0 ? h.open : Number((h.open + (h.close - h.open) * prevProgress).toFixed(2));
      const subClose = step === subCount - 1 ? h.close : Number((h.open + (h.close - h.open) * progress).toFixed(2));
      const subHigh = Number((Math.max(subOpen, subClose) + (isBull ? range * 0.15 : range * 0.05)).toFixed(2));
      const subLow = Number((Math.min(subOpen, subClose) - (!isBull ? range * 0.15 : range * 0.05)).toFixed(2));

      result.push({
        timestampUtc: subTs,
        open: subOpen,
        high: Math.min(h.high, Math.max(subHigh, subOpen, subClose)),
        low: Math.max(h.low, Math.min(subLow, subOpen, subClose)),
        close: subClose,
        volume: Math.floor(h.volume / subCount),
        isEstimated: true,
      });
    }
  }
  return result;
}

const INTRADAY_SUBDIVISION: Record<string, { subCount: number; subSec: number }> = {
  "1m": { subCount: 60, subSec: 60 },
  "5m": { subCount: 12, subSec: 300 },
  "15m": { subCount: 4, subSec: 900 },
};

/**
 * H1-derived intraday estimate. Used only when the real intraday CSV is
 * missing or does not cover the requested window.
 */
function buildEstimatedIntraday(tf: string, limit: number, to?: number): CandleData[] {
  const subdivision = INTRADAY_SUBDIVISION[tf];
  if (!subdivision) return [];

  const { subCount, subSec } = subdivision;
  const rawH1 = loadH1Data();
  if (rawH1.length === 0) return [];

  const neededH1 = Math.ceil(limit / subCount) + 5;
  let windowedH1 = rawH1;
  if (to !== undefined && !Number.isNaN(to)) {
    const endH1Idx = binarySearchBefore(rawH1, to);
    if (endH1Idx === -1) return [];
    const startH1Idx = Math.max(0, endH1Idx - neededH1 + 1);
    windowedH1 = rawH1.slice(startH1Idx, Math.min(rawH1.length, endH1Idx + 2));
  } else {
    windowedH1 = rawH1.slice(-neededH1);
  }

  const targetSeries = subdivideCandles(windowedH1, subCount, subSec);

  if (to !== undefined && !Number.isNaN(to)) {
    const endIdx = binarySearchBefore(targetSeries, to);
    if (endIdx === -1) return [];
    return targetSeries.slice(Math.max(0, endIdx - limit + 1), endIdx + 1);
  }
  return targetSeries.slice(-limit);
}

/**
 * Real intraday candles for `5m` / `15m`, or a clearly labelled H1 estimate
 * when the intraday CSV is not available (or does not cover `to`).
 */
export async function getIntradayCandles(
  tf: "5m" | "15m",
  limit: number,
  to?: number
): Promise<CandleSeriesResult> {
  const safeLimit = clampLimit(limit);
  const series = await loadIntradayCandles(tf);
  const upperBound = to !== undefined && Number.isFinite(to) ? to : Number.POSITIVE_INFINITY;

  if (series.length > 0 && upperBound > series[0]!.timestampUtc) {
    let endIdx = series.length;
    if (Number.isFinite(upperBound)) {
      const idx = binarySearchBefore(series, upperBound);
      endIdx = idx === -1 ? 0 : idx + 1;
    }

    if (endIdx > 0) {
      const data = series.slice(Math.max(0, endIdx - safeLimit), endIdx);
      if (data.length > 0) {
        const estimatedCount = countEstimated(data);
        const source: CandleSource = estimatedCount > 0 ? "estimated" : "real";
        lastCandleSource = source;
        return {
          symbol: "XAUUSD",
          timeframe: tf,
          count: data.length,
          data,
          source,
          estimatedCount,
          disclaimer: CANDLE_SERIES_DISCLAIMER,
        };
      }
    }
  }

  const estimated = buildEstimatedIntraday(tf, safeLimit, to);
  lastCandleSource = estimated.length > 0 ? "estimated" : "unknown";
  return {
    symbol: "XAUUSD",
    timeframe: tf,
    count: estimated.length,
    data: estimated,
    source: lastCandleSource,
    estimatedCount: estimated.length,
    disclaimer: CANDLE_SERIES_DISCLAIMER,
  };
}

/**
 * Full candle-series dispatch. `5m`/`15m` prefer the real intraday CSV and fall
 * back to a labelled H1 estimate; `1h`/`4h`/`1D` are built from the real H1
 * dataset. The result shape matches the `/api/market/candles` response.
 */
export async function getCandles(
  tf: string,
  limit: number,
  to?: number
): Promise<CandleSeriesResult> {
  const safeLimit = clampLimit(limit);

  if (tf === "5m" || tf === "15m") {
    return getIntradayCandles(tf, safeLimit, to);
  }

  const rawH1 = loadH1Data();
  let series: CandleData[];
  let source: CandleSource;

  if (tf === "4h") {
    series = aggregateCandles(rawH1, 4 * 3600);
    source = "real";
  } else if (tf === "1D") {
    series = aggregateCandles(rawH1, 24 * 3600);
    source = "real";
  } else if (tf === "1h") {
    series = rawH1;
    source = "real";
  } else if (tf === "1m" || tf === "5m" || tf === "15m") {
    series = buildEstimatedIntraday(tf, safeLimit, to);
    source = "estimated";
  } else {
    series = rawH1;
    source = "unknown";
  }

  let data: CandleData[];
  if (to !== undefined && Number.isFinite(to)) {
    const endIdx = binarySearchBefore(series, to);
    data = endIdx === -1 ? [] : series.slice(Math.max(0, endIdx - safeLimit + 1), endIdx + 1);
  } else {
    data = series.slice(-safeLimit);
  }

  lastCandleSource = data.length > 0 ? source : "unknown";
  return {
    symbol: "XAUUSD",
    timeframe: tf,
    count: data.length,
    data,
    source: lastCandleSource,
    estimatedCount: countEstimated(data),
    disclaimer: CANDLE_SERIES_DISCLAIMER,
  };
}
