CREATE TABLE IF NOT EXISTS "news_articles" (
	"id" text PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"publisher" text,
	"source_feed" text,
	"time_published_utc" timestamp with time zone NOT NULL,
	"sentiment_score" double precision,
	"sentiment_label" text,
	"sentiment_lm" double precision,
	"topics" text,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "news_articles_url_unique" UNIQUE("url")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "news_time_published_idx" ON "news_articles" USING btree ("time_published_utc" DESC NULLS LAST);