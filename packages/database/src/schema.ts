import { pgTable, text, integer, doublePrecision, boolean, index } from "drizzle-orm/pg-core";

export const eventTypes = pgTable("event_types", {
  id: text("id").primaryKey(),
  code: text("code").notNull().unique(), // NFP, CPI, FOMC, PPI
  name: text("name").notNull(),
  country: text("country").notNull().default("USD"),
  impact: text("impact").notNull().default("HIGH"), // HIGH, MEDIUM, LOW
  historicalStdDev: doublePrecision("historical_std_dev").notNull().default(0.2),
  createdAt: integer("created_at").notNull(),
});

export const economicReleases = pgTable(
  "economic_releases",
  {
    id: text("id").primaryKey(),
    eventTypeId: text("event_type_id").notNull().references(() => eventTypes.id),
    releaseDateUtc: integer("release_date_utc").notNull(),
    actual: doublePrecision("actual").notNull(),
    forecast: doublePrecision("forecast"),
    previous: doublePrecision("previous"),
    surpriseVal: doublePrecision("surprise_val").notNull(),
    zScore: doublePrecision("z_score").notNull(),
  },
  (table) => [
    index("releases_event_type_idx").on(table.eventTypeId),
    index("releases_date_idx").on(table.releaseDateUtc),
  ]
);

export const priceCandles = pgTable(
  "price_candles",
  {
    id: text("id").primaryKey(),
    symbol: text("symbol").notNull().default("XAUUSD"),
    timeframe: text("timeframe").notNull(), // 1m, 5m, 15m, 1h, 1D
    timestampUtc: integer("timestamp_utc").notNull(),
    open: doublePrecision("open").notNull(),
    high: doublePrecision("high").notNull(),
    low: doublePrecision("low").notNull(),
    close: doublePrecision("close").notNull(),
    volume: doublePrecision("volume").notNull().default(0),
  },
  (table) => [
    index("candles_sym_tf_ts_idx").on(table.symbol, table.timeframe, table.timestampUtc),
  ]
);

export const eventReactions = pgTable(
  "event_reactions",
  {
    id: text("id").primaryKey(),
    releaseId: text("release_id").notNull().references(() => economicReleases.id),
    windowMinutes: integer("window_minutes").notNull(), // 5, 15, 60
    basePrice: doublePrecision("base_price").notNull(),
    endPrice: doublePrecision("end_price").notNull(),
    deltaPips: doublePrecision("delta_pips").notNull(),
    maxSpikePips: doublePrecision("max_spike_pips").notNull(),
    maxDrawdownPips: doublePrecision("max_drawdown_pips").notNull(),
    isRetraced: boolean("is_retraced").notNull(),
    retraceMinutes: integer("retrace_minutes"),
  },
  (table) => [
    index("reactions_release_idx").on(table.releaseId),
  ]
);

export const cotReports = pgTable("cot_reports", {
  id: text("id").primaryKey(),
  reportDate: text("report_date").notNull().unique(), // YYYY-MM-DD
  nonCommercialLong: integer("non_commercial_long").notNull(),
  nonCommercialShort: integer("non_commercial_short").notNull(),
  netPosition: integer("net_position").notNull(),
  changeNet: integer("change_net").notNull(),
});

export const dailySummaries = pgTable("daily_summaries", {
  id: text("id").primaryKey(),
  reportDate: text("report_date").notNull().unique(), // YYYY-MM-DD
  openPrice: doublePrecision("open_price").notNull(),
  highPrice: doublePrecision("high_price").notNull(),
  lowPrice: doublePrecision("low_price").notNull(),
  closePrice: doublePrecision("close_price").notNull(),
  markdownContent: text("markdown_content").notNull(),
  complianceDisclaimer: text("compliance_disclaimer").notNull(),
  createdAtUtc: integer("created_at_utc").notNull(),
});

export const collectionLogs = pgTable("collection_logs", {
  id: text("id").primaryKey(),
  sourceName: text("source_name").notNull(),
  jobType: text("job_type").notNull(),
  status: text("status").notNull(), // SUCCESS, PARTIAL, FAILED
  rowsInserted: integer("rows_inserted").notNull(),
  executionMs: integer("execution_ms").notNull(),
  errorLog: text("error_log"),
  executedAtUtc: integer("executed_at_utc").notNull(),
});
