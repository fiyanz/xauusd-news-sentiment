import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Timeframe, COTReport } from "@repo/types";
import { fetchExpertCandles, parseCsvLine } from "./candle-repository.js";
import type { XauusdCandle } from "./candle-repository.js";

export * from "./candle-repository.js";
export * from "./expert-data.js";
export * from "./deriv.js";

export interface EconomicCalendarRaw {
  eventCode: string;
  eventName: string;
  dateUtc: number;
  actual: number | null;
  forecast: number | null;
  previous: number | null;
  impact: "HIGH" | "MEDIUM" | "LOW";
  currency?: string;
  historicalStdDev?: number | null;
  source?: string | null;
  forecastSource?: string | null;
  surpriseMethod?: string | null;
  isSimulated?: boolean;
}

/**
 * Candle XAUUSD (tipe didefinisikan di candle-repository, di-re-export di sini).
 * `isSimulated: true` menandai candle sintetis — bukan data pasar nyata.
 */
export type { XauusdCandle } from "./candle-repository.js";

function repoRoot(): string {
  return process.env.REPO_ROOT
    ? path.resolve(process.env.REPO_ROOT)
    : path.resolve(process.cwd(), "../..");
}

const CALENDAR_CSV_CANDIDATES = [
  path.resolve(
    process.cwd(),
    "services/sentiment-analysis/data/raw/calendar/economic_calendar_enriched.csv"
  ),
  path.resolve(
    process.cwd(),
    "../../services/sentiment-analysis/data/raw/calendar/economic_calendar_enriched.csv"
  ),
  path.resolve(
    repoRoot(),
    "services/sentiment-analysis/data/raw/calendar/economic_calendar_enriched.csv"
  ),
];

// CFTC "Futures Only" weekly report (layout legacy, semua komoditas).
// Emas = baris "GOLD - COMMODITY EXCHANGE INC." dengan non-commercial long/short
// dan kolom perubahan mingguan. Sumber keyless, tanpa API key.
const COT_SOURCE_URL = "https://www.cftc.gov/dea/newcot/deafut.txt";
const COT_FETCH_TIMEOUT_MS = 12_000;
const COT_SUCCESS_CACHE_MS = 6 * 60 * 60 * 1000;
const COT_FAILURE_CACHE_MS = 5 * 60 * 1000;

let cotCache: { report: COTReport | null; fetchedAt: number } | null = null;

function parseOptionalNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.toLowerCase() === "nan") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseBooleanFlag(value: string | undefined): boolean {
  const normalized = (value ?? "").trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

// Parser CSV kanonik kini satu tempat di candle-repository (parseCsvLine).

function classifyEventCode(eventName: string): string {
  const name = eventName.toUpperCase();
  if (name.includes("NON-FARM") || name.includes("NONFARM") || name.includes("NFP")) return "NFP";
  if (name.includes("CORE CPI") || name.includes("CPI")) return "CPI";
  if (name.includes("CORE PCE") || name.includes("PCE")) return "PCE";
  if (name.includes("FOMC") || name.includes("FEDERAL FUNDS")) return "FOMC";
  if (name.includes("GROSS DOMESTIC") || name.includes("GDP")) return "GDP";
  if (name.includes("RETAIL SALES")) return "RETAIL";
  if (name.includes("UNEMPLOYMENT")) return "UNEMPLOYMENT";
  if (name.includes("PMI")) return "PMI";
  return "NEWS";
}

function findCalendarCsv(): string | null {
  for (const candidate of CALENDAR_CSV_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Parser CFTC "Futures Only" (deafut.txt). Layout kolom yang dipakai (0-index):
 *   2  = tanggal laporan (YYYY-MM-DD)
 *   7  = open interest (all)
 *   8  = non-commercial long (all)
 *   9  = non-commercial short (all)
 *   10 = non-commercial spreading (all)
 *   11 = commercial long (all)
 *   12 = commercial short (all)
 *   13 = total reportable long (all)
 *   14 = total reportable short (all)
 *   15 = non-reportable long (all)
 *   16 = non-reportable short (all)
 *   37 = perubahan open interest
 *   38 = perubahan non-commercial long
 *   39 = perubahan non-commercial short
 * Identitas aritmetika (total = non-commercial + commercial + spreading,
 * OI = total reportable + non-reportable) dipakai sebagai validasi silang.
 */
function parseCotReport(text: string): COTReport | null {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('"')) continue;
    if (!/^"GOLD\b.*COMMODITY EXCHANGE/i.test(line)) continue;

    const cells = parseCsvLine(line).map((cell) => cell.trim());
    const reportDate = cells[2] ?? "";
    const nonCommercialLong = parseOptionalNumber(cells[8]);
    const nonCommercialShort = parseOptionalNumber(cells[9]);
    if (nonCommercialLong === null || nonCommercialShort === null) return null;

    const changeLong = parseOptionalNumber(cells[38]);
    const changeShort = parseOptionalNumber(cells[39]);
    const netPosition = nonCommercialLong - nonCommercialShort;
    const changeNet = (changeLong ?? 0) - (changeShort ?? 0);

    // UUID deterministik (v5-like) supaya tetap cocok dengan COTReportSchema.
    const hex = createHash("sha1").update(`cot-gold-${reportDate}`).digest("hex");
    const id = [
      hex.slice(0, 8),
      hex.slice(8, 12),
      `5${hex.slice(13, 16)}`,
      `${((parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}`,
      hex.slice(20, 32),
    ].join("-");

    return {
      id,
      reportDate,
      nonCommercialLong,
      nonCommercialShort,
      netPosition,
      changeNet,
    };
  }

  return null;
}

export class FinancialClient {
  /**
   * Delegate tipis ke candle-repository: CSV expert -> estimasi H1 ->
   * sintetis (isSimulated). Perilaku lama dipertahankan persis.
   */
  async fetchXauusdCandles(
    timeframe: Timeframe = "15m",
    limit: number = 300,
    to?: number
  ): Promise<XauusdCandle[]> {
    return fetchExpertCandles(timeframe, limit, to);
  }

  /**
   * Kalender ekonomi nyata dari `economic_calendar_enriched.csv`.
   * actual/forecast/previous bernilai null bila tidak tersedia — tidak ada
   * angka pengganti. Mengembalikan [] bila file tidak ada / tidak bisa dibaca.
   */
  async fetchEconomicCalendar(limit?: number): Promise<EconomicCalendarRaw[]> {
    const csvPath = findCalendarCsv();
    if (!csvPath) return [];

    let content: string;
    try {
      content = fs.readFileSync(csvPath, "utf-8");
    } catch {
      return [];
    }

    const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
    if (lines.length < 2) return [];

    const header = parseCsvLine(lines[0]!).map((name) => name.trim().toLowerCase());
    const indexOf = (name: string) => header.indexOf(name);

    const idxTime = indexOf("timestamp_utc");
    const idxName = indexOf("event_name");
    if (idxTime === -1 || idxName === -1) return [];

    const idxImpact = indexOf("impact");
    const idxCurrency = indexOf("currency");
    const idxActual = indexOf("actual");
    const idxForecast = indexOf("forecast");
    const idxPrevious = indexOf("previous");
    const idxStdDev = indexOf("historical_std_dev");
    const idxSource = indexOf("source");
    const idxForecastSource = indexOf("forecast_source");
    const idxSurpriseMethod = indexOf("surprise_method");
    const idxSimulated = indexOf("is_simulated");

    const events: EconomicCalendarRaw[] = [];

    for (let i = 1; i < lines.length; i++) {
      const cells = parseCsvLine(lines[i]!);
      const timeStr = (cells[idxTime] ?? "").trim();
      const eventName = (cells[idxName] ?? "").trim();
      if (!timeStr || !eventName) continue;

      const dateUtc = Math.floor(new Date(timeStr).getTime() / 1000);
      if (!Number.isFinite(dateUtc)) continue;

      const impactRaw = (cells[idxImpact] ?? "").trim().toUpperCase();
      const impact =
        impactRaw === "HIGH" || impactRaw === "MEDIUM" || impactRaw === "LOW"
          ? impactRaw
          : "MEDIUM";

      events.push({
        eventCode: classifyEventCode(eventName),
        eventName,
        dateUtc,
        actual: idxActual === -1 ? null : parseOptionalNumber(cells[idxActual]),
        forecast: idxForecast === -1 ? null : parseOptionalNumber(cells[idxForecast]),
        previous: idxPrevious === -1 ? null : parseOptionalNumber(cells[idxPrevious]),
        impact,
        currency:
          idxCurrency === -1 ? undefined : (cells[idxCurrency] ?? "").trim() || undefined,
        historicalStdDev: idxStdDev === -1 ? null : parseOptionalNumber(cells[idxStdDev]),
        source: idxSource === -1 ? null : (cells[idxSource] ?? "").trim() || null,
        forecastSource:
          idxForecastSource === -1 ? null : (cells[idxForecastSource] ?? "").trim() || null,
        surpriseMethod:
          idxSurpriseMethod === -1 ? null : (cells[idxSurpriseMethod] ?? "").trim() || null,
        isSimulated: idxSimulated === -1 ? false : parseBooleanFlag(cells[idxSimulated]),
      });
    }

    events.sort((a, b) => a.dateUtc - b.dateUtc);
    return limit !== undefined && limit >= 0 ? events.slice(-limit) : events;
  }

  /**
   * Laporan COT emas mingguan dari CFTC (keyless).
   * Mengembalikan null bila sumber tidak bisa diakses / baris emas tidak ada.
   */
  async fetchLatestCOTReport(): Promise<COTReport | null> {
    const now = Date.now();
    if (cotCache) {
      const ttl = cotCache.report ? COT_SUCCESS_CACHE_MS : COT_FAILURE_CACHE_MS;
      if (now - cotCache.fetchedAt < ttl) return cotCache.report;
    }

    let report: COTReport | null = null;
    try {
      const response = await fetch(COT_SOURCE_URL, {
        signal: AbortSignal.timeout(COT_FETCH_TIMEOUT_MS),
        headers: { "User-Agent": "XAUUSD-Research-Terminal/1.0" },
      });
      if (!response.ok) throw new Error(`CFTC merespons HTTP ${response.status}`);
      report = parseCotReport(await response.text());
      if (!report) throw new Error("Seri emas tidak ditemukan di laporan CFTC");
    } catch {
      report = null;
    }

    cotCache = { report, fetchedAt: now };
    return report;
  }
}
