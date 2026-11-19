import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

import { sentimentDataPath } from "@/lib/paths";

export const dynamic = "force-dynamic";

const DISCLAIMER = "FR-10: Research Analytics Only • Non-Advisory";
const EVENT_WINDOW_DAYS = 7;
const MAX_EVENTS = 50;

interface CalendarEvent {
  eventCode: string;
  eventName: string;
  dateUtc: number;
  dateStr: string;
  impact: string;
  actual: number | null;
  forecast: number | null;
  previous: number | null;
  /** Provenance jujur dari CSV: sumber data + flag simulasi (placeholder). */
  source: string;
  isSimulated: boolean;
}

let cachedCalendar: CalendarEvent[] | null = null;
let cachedCalendarAtMs = 0;
let cachedCalendarMtimeMs = 0;
const CALENDAR_CACHE_TTL_MS = 5 * 60 * 1000;

function findCalendarCsv(): string | null {
  const candidates = [
    path.resolve(process.cwd(), "../../services/sentiment-analysis/data/raw/calendar/economic_calendar_enriched.csv"),
    path.resolve(process.cwd(), "services/sentiment-analysis/data/raw/calendar/economic_calendar_enriched.csv"),
    sentimentDataPath("data/raw/calendar/economic_calendar_enriched.csv"),
  ];

  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return c;
    }
  }
  return null;
}

function parseOptionalNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.toLowerCase() === "nan") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

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

function classifyEventCode(eventName: string): string {
  const name = eventName.toUpperCase();
  if (name.includes("NON-FARM") || name.includes("NONFARM") || name.includes("NFP")) return "NFP";
  if (name.includes("CORE CPI") || name.includes("CPI")) return "CPI";
  if (name.includes("CORE PCE") || name.includes("PCE")) return "PCE";
  if (name.includes("FOMC") || name.includes("FEDERAL FUNDS")) return "FOMC";
  return "NEWS";
}

function loadCalendarData(): CalendarEvent[] {
  const csvPath = findCalendarCsv();

  if (csvPath) {
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(csvPath).mtimeMs;
    } catch {
      // Ignore unreadable files and fall through to a re-read.
    }
    if (
      cachedCalendar &&
      Date.now() - cachedCalendarAtMs < CALENDAR_CACHE_TTL_MS &&
      cachedCalendarMtimeMs === mtimeMs
    ) {
      return cachedCalendar;
    }
  }

  if (!csvPath) return cachedCalendar ?? [];

  let content: string;
  try {
    content = fs.readFileSync(csvPath, "utf-8");
  } catch {
    return cachedCalendar ?? [];
  }

  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) return [];

  const header = parseCsvLine(lines[0]!).map((name) => name.trim().toLowerCase());
  const indexOf = (name: string) => header.indexOf(name);

  const idxTime = indexOf("timestamp_utc");
  const idxName = indexOf("event_name");
  if (idxTime === -1 || idxName === -1) return [];

  const idxImpact = indexOf("impact");
  const idxActual = indexOf("actual");
  const idxForecast = indexOf("forecast");
  const idxPrevious = indexOf("previous");
  const idxSource = indexOf("source");
  const idxSimulated = indexOf("is_simulated");

  const events: CalendarEvent[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]!);
    const timeStr = (cells[idxTime] ?? "").trim();
    const name = (cells[idxName] ?? "").trim();
    if (!timeStr || !name) continue;

    const ts = Math.floor(new Date(timeStr).getTime() / 1000);
    if (!Number.isFinite(ts)) continue;

    const impact = (cells[idxImpact] ?? "").trim().toUpperCase();

    events.push({
      eventCode: classifyEventCode(name),
      eventName: name,
      dateUtc: ts,
      dateStr: timeStr.split(" ")[0] || timeStr.split("T")[0] || "",
      impact,
      actual: idxActual === -1 ? null : parseOptionalNumber(cells[idxActual]),
      forecast: idxForecast === -1 ? null : parseOptionalNumber(cells[idxForecast]),
      previous: idxPrevious === -1 ? null : parseOptionalNumber(cells[idxPrevious]),
      source: idxSource === -1 ? "" : (cells[idxSource] ?? "").trim(),
      isSimulated:
        idxSimulated !== -1 &&
        (cells[idxSimulated] ?? "").trim().toLowerCase() === "true",
    });
  }

  events.sort((a, b) => a.dateUtc - b.dateUtc);
  cachedCalendar = events;
  cachedCalendarAtMs = Date.now();
  try {
    cachedCalendarMtimeMs = fs.statSync(csvPath).mtimeMs;
  } catch {
    cachedCalendarMtimeMs = 0;
  }
  return cachedCalendar;
}

export async function GET() {
  const events = loadCalendarData();

  if (events.length === 0) {
    return NextResponse.json({
      status: "unavailable",
      reason: "Kalender ekonomi tidak tersedia (economic_calendar_enriched.csv tidak ditemukan).",
      count: 0,
      events: [],
      disclaimer: DISCLAIMER,
    });
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const upcoming = events
    .filter(
      (event) =>
        event.impact === "HIGH" && event.dateUtc >= nowSec - EVENT_WINDOW_DAYS * 86400
    )
    .slice(-MAX_EVENTS);

  return NextResponse.json({
    status: "ok",
    count: upcoming.length,
    events: upcoming,
    disclaimer: DISCLAIMER,
  });
}
