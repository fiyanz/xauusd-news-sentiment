CREATE TABLE IF NOT EXISTS "collection_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"source_name" text NOT NULL,
	"job_type" text NOT NULL,
	"status" text NOT NULL,
	"rows_inserted" integer NOT NULL,
	"execution_ms" integer NOT NULL,
	"error_log" text,
	"executed_at_utc" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cot_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"report_date" text NOT NULL,
	"non_commercial_long" integer NOT NULL,
	"non_commercial_short" integer NOT NULL,
	"net_position" integer NOT NULL,
	"change_net" integer NOT NULL,
	CONSTRAINT "cot_reports_report_date_unique" UNIQUE("report_date")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "daily_summaries" (
	"id" text PRIMARY KEY NOT NULL,
	"report_date" text NOT NULL,
	"open_price" double precision NOT NULL,
	"high_price" double precision NOT NULL,
	"low_price" double precision NOT NULL,
	"close_price" double precision NOT NULL,
	"markdown_content" text NOT NULL,
	"compliance_disclaimer" text NOT NULL,
	"created_at_utc" integer NOT NULL,
	CONSTRAINT "daily_summaries_report_date_unique" UNIQUE("report_date")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "economic_releases" (
	"id" text PRIMARY KEY NOT NULL,
	"event_type_id" text NOT NULL,
	"release_date_utc" integer NOT NULL,
	"actual" double precision NOT NULL,
	"forecast" double precision,
	"previous" double precision,
	"surprise_val" double precision NOT NULL,
	"z_score" double precision NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "event_reactions" (
	"id" text PRIMARY KEY NOT NULL,
	"release_id" text NOT NULL,
	"window_minutes" integer NOT NULL,
	"base_price" double precision NOT NULL,
	"end_price" double precision NOT NULL,
	"delta_pips" double precision NOT NULL,
	"max_spike_pips" double precision NOT NULL,
	"max_drawdown_pips" double precision NOT NULL,
	"is_retraced" boolean NOT NULL,
	"retrace_minutes" integer
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "event_types" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"country" text DEFAULT 'USD' NOT NULL,
	"impact" text DEFAULT 'HIGH' NOT NULL,
	"historical_std_dev" double precision DEFAULT 0.2 NOT NULL,
	"created_at" integer NOT NULL,
	CONSTRAINT "event_types_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "price_candles" (
	"id" text PRIMARY KEY NOT NULL,
	"symbol" text DEFAULT 'XAUUSD' NOT NULL,
	"timeframe" text NOT NULL,
	"timestamp_utc" integer NOT NULL,
	"open" double precision NOT NULL,
	"high" double precision NOT NULL,
	"low" double precision NOT NULL,
	"close" double precision NOT NULL,
	"volume" double precision DEFAULT 0 NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "economic_releases" ADD CONSTRAINT "economic_releases_event_type_id_event_types_id_fk" FOREIGN KEY ("event_type_id") REFERENCES "public"."event_types"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "event_reactions" ADD CONSTRAINT "event_reactions_release_id_economic_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."economic_releases"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "releases_event_type_idx" ON "economic_releases" USING btree ("event_type_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "releases_date_idx" ON "economic_releases" USING btree ("release_date_utc");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reactions_release_idx" ON "event_reactions" USING btree ("release_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "candles_sym_tf_ts_idx" ON "price_candles" USING btree ("symbol","timeframe","timestamp_utc");