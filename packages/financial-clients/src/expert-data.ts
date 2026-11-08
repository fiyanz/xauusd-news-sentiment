import fs from "node:fs";
import readline from "node:readline";
import path from "node:path";
import type { OHLCV, Timeframe } from "@repo/types";

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

/** Parsed CSV rows stay in memory for at most 5 minutes before being re-read. */
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * `real`      -> bars come from a real intraday dataset.
 * `estimated` -> bars are H1-derived and must never be presented as prints.
 * `unknown`   -> provenance could not be determined.
 */
export type CandleSource = "real" | "estimated" | "unknown";

export interface RealNewsEvent {
  timestampUtc: number;
  dateStr: string;
  currency: string;
  name: string;
  impact: string;
}

type ParsedCandle = OHLCV & { isEstimated?: boolean };

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

// In-memory caches for ultra-fast candle querying (<1ms after first read)
const csvCaches = new Map<string, CsvCacheEntry>();
const csvInFlight = new Map<string, Promise<ParsedCandle[]>>();
let cachedH1Candles: OHLCV[] | null = null;
let lastCandleSource: CandleSource = "unknown";

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

function parseCandleLine(line: string, tf: Timeframe): ParsedCandle | null {
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

/** Stream-parse a candle CSV line by line so memory stays bounded on large files. */
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

function isEstimatedCandle(candle: ParsedCandle): boolean {
  return candle.isEstimated === true;
}

export class ExpertDataService {
  private dataDir: string;

  constructor(dataDir: string = EXPERT_DATA_DIR) {
    this.dataDir = dataDir;
  }

  /** Provenance of the most recent `getRecentCandles` result. */
  getLastCandleSource(): CandleSource {
    return lastCandleSource;
  }

  private resolveH1Path(): string | null {
    // cwd-relative candidates first (they track the running app), the absolute
    // repo path last as a fallback — mirrors candle-cache.ts.
    const candidates = [
      path.resolve(process.cwd(), "../../", PRICE_DIR_REL, "xauusd_h1_complete.csv"),
      path.resolve(process.cwd(), "..", PRICE_DIR_REL, "xauusd_h1_complete.csv"),
      path.resolve(process.cwd(), PRICE_DIR_REL, "xauusd_h1_complete.csv"),
      REFRESHED_H1_CSV,
      path.join(this.dataDir, "XAUUSD_H1.csv"),
    ];
    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch {
        // Ignore unreadable candidates.
      }
    }
    return null;
  }

  /** Candidate locations for the real intraday CSVs written by the price pipeline. */
  private resolveIntradayPath(tf: "5m" | "15m"): string | null {
    const filename = tf === "5m" ? "xauusd_m5.csv" : "xauusd_m15.csv";
    // cwd-relative candidates first (they track the running app), the absolute
    // repo root last as a fallback — mirrors candle-cache.ts.
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
        // Ignore unreadable candidates.
      }
    }
    return null;
  }

  /**
   * Read a candle CSV with a 5 minute TTL + mtime check. Concurrent callers
   * share a single in-flight read so a cold cache is only parsed once.
   */
  private async readCsv(filePath: string, tf: Timeframe): Promise<ParsedCandle[]> {
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
        console.warn(`[ExpertDataService] failed to read ${tf} CSV at ${filePath}:`, error);
        return [];
      } finally {
        csvInFlight.delete(key);
      }
    })();

    csvInFlight.set(key, promise);
    return promise;
  }

  private async loadH1IntoMemory(): Promise<OHLCV[]> {
    const filePath = this.resolveH1Path();
    if (!filePath) return cachedH1Candles ?? [];

    const parsed = await this.readCsv(filePath, "1h");
    if (parsed.length === 0) return cachedH1Candles ?? [];

    cachedH1Candles = parsed.map(stripEstimated);
    return cachedH1Candles;
  }

  /**
   * Load the real intraday series for `5m` / `15m` from the price pipeline CSV.
   * Returns `[]` when the file does not exist yet — callers must then fall back
   * to the H1-derived estimate and label it as such.
   */
  private async loadIntradayIntoMemory(tf: "5m" | "15m"): Promise<ParsedCandle[]> {
    const filePath = this.resolveIntradayPath(tf);
    if (!filePath) return [];
    return this.readCsv(filePath, tf);
  }

  // Load real historical candles with optional window cutoff `to`
  async getRecentCandles(
    timeframe: Timeframe = "15m",
    limit: number = 300,
    to?: number
  ): Promise<OHLCV[]> {
    const rawH1 = await this.loadH1IntoMemory();
    if (rawH1.length === 0) return [];

    let targetSeries: OHLCV[];
    let source: CandleSource = "real";

    if (timeframe === "4h") {
      targetSeries = this.aggregate(rawH1, 4 * 3600, "4h");
    } else if (timeframe === "1D") {
      targetSeries = this.aggregate(rawH1, 24 * 3600, "1D");
    } else if (timeframe === "15m" || timeframe === "5m") {
      const subCount = timeframe === "15m" ? 4 : 12;
      const subSec = timeframe === "15m" ? 900 : 300;
      const intraday = await this.loadIntradayIntoMemory(timeframe);
      const hasUsableIntraday =
        intraday.length > 0 && (to === undefined || isNaN(to) || to > intraday[0]!.timestampUtc);

      if (hasUsableIntraday) {
        targetSeries = intraday.map(stripEstimated);
        source = intraday.some(isEstimatedCandle) ? "estimated" : "real";
      } else {
        // No real intraday CSV yet (or the requested window predates it):
        // derive bars from H1 and label them as estimates.
        const neededH1 = Math.ceil(limit / subCount) + 5;
        let windowedH1 = rawH1;
        let found = true;
        if (to !== undefined && !isNaN(to)) {
          const endH1Idx = this.binarySearchBefore(rawH1, to);
          if (endH1Idx === -1) {
            found = false;
          } else {
            const startH1Idx = Math.max(0, endH1Idx - neededH1 + 1);
            windowedH1 = rawH1.slice(startH1Idx, Math.min(rawH1.length, endH1Idx + 2));
          }
        } else {
          windowedH1 = rawH1.slice(-neededH1);
        }
        targetSeries = found ? this.subdivide(windowedH1, subCount, subSec, timeframe) : [];
        source = found ? "estimated" : "unknown";
      }
    } else if (timeframe === "1m") {
      const neededH1 = Math.ceil(limit / 60) + 5;
      let windowedH1 = rawH1;
      if (to !== undefined && !isNaN(to)) {
        const endH1Idx = this.binarySearchBefore(rawH1, to);
        windowedH1 =
          endH1Idx === -1
            ? []
            : rawH1.slice(Math.max(0, endH1Idx - neededH1 + 1), Math.min(rawH1.length, endH1Idx + 2));
      } else {
        windowedH1 = rawH1.slice(-neededH1);
      }
      targetSeries = this.subdivide(windowedH1, 60, 60, "1m");
      source = "estimated";
    } else {
      targetSeries = rawH1;
    }

    lastCandleSource = targetSeries.length > 0 ? source : "unknown";

    if (to !== undefined && !isNaN(to)) {
      const bestIdx = this.binarySearchBefore(targetSeries, to);
      if (bestIdx === -1) return [];
      const startIdx = Math.max(0, bestIdx - limit + 1);
      return targetSeries.slice(startIdx, bestIdx + 1);
    }

    return targetSeries.slice(-limit);
  }

  private binarySearchBefore(candles: OHLCV[], targetTs: number): number {
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

  private aggregate(raw: OHLCV[], intervalSec: number, tf: Timeframe): OHLCV[] {
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

  // ESTIMATE ONLY: subdivides an H1 bar into intraday bars. Used solely as the
  // labelled fallback when no real intraday CSV is available.
  private subdivide(raw: OHLCV[], subCount: number, subSec: number, tf: Timeframe): OHLCV[] {
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
        const subHigh = Number((Math.max(subOpen, subClose) + (isBull ? range * 0.15 : range * 0.05)).toFixed(2));
        const subLow = Number((Math.min(subOpen, subClose) - (!isBull ? range * 0.15 : range * 0.05)).toFixed(2));

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

  // Load real high-impact economic news releases
  async getHighImpactNews(limit: number = 100): Promise<RealNewsEvent[]> {
    const filePath = path.join(this.dataDir, "news_calendar_high_impact.csv");
    if (!this.dataDir || !fs.existsSync(filePath)) return [];

    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    const events: RealNewsEvent[] = [];
    let isHeader = true;

    for await (const line of rl) {
      if (isHeader) {
        isHeader = false;
        continue;
      }
      if (!line.trim()) continue;

      const parts = parseCsvLine(line);
      if (parts.length < 4) continue;

      const tsStr = parts[0]!;
      const currency = parts[1]!;
      const name = parts[2]!;
      const impact = parts[3]!;

      const timestampUtc = Math.floor(new Date(tsStr + "Z").getTime() / 1000);

      events.push({
        timestampUtc,
        dateStr: tsStr,
        currency,
        name,
        impact,
      });
    }

    return events.slice(-limit);
  }
}

/** Provenance of the most recent `ExpertDataService.getRecentCandles` result. */
export function getLastCandleSource(): CandleSource {
  return lastCandleSource;
}
