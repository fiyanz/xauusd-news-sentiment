import { z } from "zod";

export const ImpactLevelSchema = z.enum(["HIGH", "MEDIUM", "LOW"]);
export type ImpactLevel = z.infer<typeof ImpactLevelSchema>;

export const TimeframeSchema = z.enum(["1m", "5m", "15m", "30m", "1h", "4h", "1D"]);
export type Timeframe = z.infer<typeof TimeframeSchema>;

export const JobStatusSchema = z.enum(["SUCCESS", "PARTIAL", "FAILED"]);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const OHLCVSchema = z.object({
  symbol: z.string().default("XAUUSD"),
  timeframe: TimeframeSchema,
  timestampUtc: z.number().describe("Unix timestamp in seconds UTC"),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  volume: z.number().default(0),
});
export type OHLCV = z.infer<typeof OHLCVSchema>;

export const EventTypeSchema = z.object({
  id: z.string().uuid(),
  code: z.string().describe("e.g. NFP, CPI, FOMC, PPI"),
  name: z.string(),
  country: z.string().default("USD"),
  impact: ImpactLevelSchema,
  historicalStdDev: z.number().default(0.2),
});
export type EventType = z.infer<typeof EventTypeSchema>;

export const EconomicReleaseSchema = z.object({
  id: z.string().uuid(),
  eventTypeId: z.string().uuid(),
  releaseDateUtc: z.number().describe("Unix timestamp in seconds UTC"),
  actual: z.number(),
  forecast: z.number().nullable(),
  previous: z.number().nullable(),
  surpriseVal: z.number().describe("Actual - Forecast (or fallback Actual - Previous)"),
  zScore: z.number().describe("Standardized Surprise Score"),
});
export type EconomicRelease = z.infer<typeof EconomicReleaseSchema>;

export const EventReactionSchema = z.object({
  id: z.string().uuid(),
  releaseId: z.string().uuid(),
  windowMinutes: z.number().describe("e.g. 5, 15, 60"),
  basePrice: z.number().describe("Close price at T - 1m"),
  endPrice: z.number().describe("Close price at T + window"),
  deltaPips: z.number().describe("(endPrice - basePrice) * 10 for Gold"),
  maxSpikePips: z.number(),
  maxDrawdownPips: z.number(),
  isRetraced: z.boolean(),
  retraceMinutes: z.number().nullable(),
});
export type EventReaction = z.infer<typeof EventReactionSchema>;

export const COTReportSchema = z.object({
  id: z.string().uuid(),
  reportDate: z.string().describe("YYYY-MM-DD"),
  nonCommercialLong: z.number(),
  nonCommercialShort: z.number(),
  netPosition: z.number(),
  changeNet: z.number(),
});
export type COTReport = z.infer<typeof COTReportSchema>;

export const DailyDigestSchema = z.object({
  id: z.string().uuid(),
  reportDate: z.string().describe("YYYY-MM-DD"),
  openPrice: z.number(),
  highPrice: z.number(),
  lowPrice: z.number(),
  closePrice: z.number(),
  markdownContent: z.string(),
  complianceDisclaimer: z.string(),
  createdAtUtc: z.number(),
});
export type DailyDigest = z.infer<typeof DailyDigestSchema>;

export const CollectionLogSchema = z.object({
  id: z.string().uuid(),
  sourceName: z.string(),
  jobType: z.string(),
  status: JobStatusSchema,
  rowsInserted: z.number(),
  executionMs: z.number(),
  errorLog: z.string().nullable(),
  executedAtUtc: z.number(),
});
export type CollectionLog = z.infer<typeof CollectionLogSchema>;

export const COMPLIANCE_DISCLAIMER_FR10 =
  "Pemberitahuan Kepatuhan (FR-10): Seluruh data, grafik, dan analisis historis yang disajikan dalam sistem ini bertujuan murni sebagai materi edukasi dan informasi riset internal pasar. Sistem ini tidak memberikan sinyal perdagangan, rekomendasi investasi, maupun ajakan untuk bertransaksi derivatif keuangan. Penyedia sistem tidak bertanggung jawab atas keputusan finansial independen pengguna.";
