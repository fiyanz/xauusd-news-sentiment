import fs from "node:fs";
import path from "node:path";
import { db, newsArticles, sql } from "@repo/database";

/** Ukuran batch insert corpus. TiDB Cloud menutup koneksi bila statement
 * multi-row terlalu besar (teks title+summary); 200 baris aman, 1000 terlalu besar. */
export const BATCH_SIZE = 200;

/** Seam pure: pecah rows menjadi batch maksimal `size` baris (default BATCH_SIZE),
 * urutan terjaga, tanpa memutasi input. 0 rows -> 0 batch. */
export function toBatches<T>(rows: T[], size: number = BATCH_SIZE): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < rows.length; i += size) {
    batches.push(rows.slice(i, i + size));
  }
  return batches;
}

/** Bentuk baris mentah news_corpus.jsonl (hanya field yang dipakai). */
interface CorpusArticle {
  id?: unknown;
  url?: unknown;
  title?: unknown;
  summary?: unknown;
  publisher?: unknown;
  source_feed?: unknown;
  time_published_utc?: unknown;
  overall_sentiment_score?: unknown;
  overall_sentiment_label?: unknown;
  sentiment_lm?: unknown;
  topics?: unknown;
}

/** Row siap insert ke news_articles (kontrak schema; ingestedAt diisi default DB).
 * Dipakai bersama oleh seam pure dan adapter store — tidak bergantung drizzle. */
export interface NewsRow {
  id: string;
  url: string;
  title: string;
  summary: string | null;
  publisher: string | null;
  sourceFeed: string | null;
  timePublishedUtc: Date;
  sentimentScore: number | null;
  sentimentLabel: string | null;
  sentimentLm: number | null;
  topics: string | null;
}

function repoRoot(): string {
  return process.env.REPO_ROOT
    ? path.resolve(process.env.REPO_ROOT)
    : path.resolve(process.cwd(), "../..");
}

/** Lokasi corpus JSONL hasil pipeline sentiment-analysis (struktur path sama dengan repo). */
function getCorpusPath(): string {
  const rel = "services/sentiment-analysis/data/processed/news_corpus.jsonl";
  const direct = path.resolve(process.cwd(), rel);
  if (fs.existsSync(direct)) return direct;
  const fromApps = path.resolve(process.cwd(), "../../", rel);
  if (fs.existsSync(fromApps)) return fromApps;
  return path.resolve(repoRoot(), rel);
}

/**
 * Parse waktu publikasi corpus ("YYYY-MM-DD HH:MM:SS+00:00" atau ISO 8601).
 * Tidak valid -> null (baris dilewati, bukan waktu karangan).
 */
function parsePublishedUtc(raw: unknown): Date | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const iso = raw.includes("T") ? raw : raw.replace(" ", "T");
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function textOrNull(raw: unknown): string | null {
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

function numberOrNull(raw: unknown): number | null {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

/** Encode topics untuk kolom DB: array -> JSON string; string non-kosong
 * (sudah JSON) diteruskan; selain itu null. Kontrak bersama dengan API. */
export function topicsToJson(raw: unknown): string | null {
  if (Array.isArray(raw)) return JSON.stringify(raw);
  if (typeof raw === "string" && raw.length > 0) return raw;
  return null;
}

/** Decode topics dari kolom DB (JSON string) -> array bila valid, else null.
 * Cermin persis parseTopics di apps/api — sengaja di-export dari sini supaya
 * round-trip encode/decode bisa dites dan nanti disatukan saat integrasi. */
export function parseTopics(raw: string | null): unknown[] | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Seam pure: normalisasi hasil max(time_published_utc) menjadi Date valid.
 * Quirk postgres-js: aggregate max() lewat sql`` dikembalikan sebagai STRING,
 * bukan Date — tanpa konversi ini getTime() crash saat re-run.
 * null/undefined (DB kosong) atau nilai tidak valid -> null (ingest penuh). */
export function toWatermark(raw: string | Date | null | undefined): Date | null {
  if (raw === null || raw === undefined) return null;
  const parsed = raw instanceof Date ? raw : new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Seam pure: buang duplikat url ATAU id (first-wins, urutan terjaga).
 * Corpus nyata punya 582 id kembar dengan url berbeda — keduanya harus
 * disaring sebelum insert agar ON CONFLICT tidak membuang baris diam-diam.
 * Tidak memutasi input. */
export function dedupeRows(rows: NewsRow[]): NewsRow[] {
  const seenUrls = new Set<string>();
  const seenIds = new Set<string>();
  const unique: NewsRow[] = [];
  for (const row of rows) {
    if (seenUrls.has(row.url) || seenIds.has(row.id)) continue;
    seenUrls.add(row.url);
    seenIds.add(row.id);
    unique.push(row);
  }
  return unique;
}

/** Seam pure: satu baris JSONL corpus -> NewsRow, atau null bila baris rusak
 * atau field wajib kontrak (id, url, title, waktu publikasi valid) tidak lengkap.
 * Tidak melempar error dan tidak menyentuh I/O — aman dites tanpa TiDB. */
export function parseArticleLine(line: string): NewsRow | null {
  let article: CorpusArticle;
  try {
    article = JSON.parse(line) as CorpusArticle;
  } catch {
    return null; // Baris rusak dilewati, bukan ditebak isinya.
  }

  const id = textOrNull(article.id);
  const url = textOrNull(article.url);
  const title = textOrNull(article.title);
  const published = parsePublishedUtc(article.time_published_utc);
  if (!id || !url || !title || !published) return null; // Field wajib kontrak tidak lengkap.

  return {
    id,
    url,
    title,
    summary: textOrNull(article.summary),
    publisher: textOrNull(article.publisher),
    sourceFeed: textOrNull(article.source_feed),
    timePublishedUtc: published,
    sentimentScore: numberOrNull(article.overall_sentiment_score),
    sentimentLabel: textOrNull(article.overall_sentiment_label),
    sentimentLm: numberOrNull(article.sentiment_lm),
    topics: topicsToJson(article.topics),
  };
}

/** Port pembaca corpus (seam I/O). Adapter produksi: file JSONL di repo;
 * adapter tes: in-memory. readCorpus() = null berarti corpus tidak ditemukan
 * (ingest dilewati tanpa error). */
export interface CorpusReader {
  readCorpus(): string | null;
}

/** Port penyimpanan berita (seam I/O). Adapter produksi: drizzle + TiDB;
 * adapter tes: in-memory. Kontrak insertBatch: satu batch <= BATCH_SIZE baris,
 * ON CONFLICT DO NOTHING mencakup unique url DAN primary key id, dan hanya
 * menghitung baris yang benar-benar masuk. readWatermark mengembalikan nilai
 * mentah max(time_published_utc) — postgres-js mengembalikannya sebagai string. */
export interface NewsStore {
  readWatermark(): Promise<string | Date | null>;
  insertBatch(rows: NewsRow[]): Promise<number>;
}

/** Ports opsional untuk ingestNewsCorpus. Tanpa ports (call no-arg dari
 * worker/index.ts) adapter produksi fs + drizzle yang dipakai — perilaku lama
 * tetap utuh; dengan ports, seluruh perilaku bisa dites tanpa TiDB. */
export interface IngestPorts {
  reader?: CorpusReader;
  store?: NewsStore;
}

/** Adapter produksi untuk seam reader: baca corpus JSONL dari filesystem. */
function createFileCorpusReader(): CorpusReader {
  return {
    readCorpus(): string | null {
      const corpusPath = getCorpusPath();
      if (!fs.existsSync(corpusPath)) {
        console.warn(`[Worker] Corpus berita tidak ditemukan (${corpusPath}) — ingest dilewati.`);
        return null;
      }
      return fs.readFileSync(corpusPath, "utf-8");
    },
  };
}

/** Adapter produksi untuk seam store: drizzle di atas TiDB (postgres-js). */
function createDrizzleNewsStore(): NewsStore {
  return {
    async readWatermark(): Promise<string | Date | null> {
      const [watermarkRow] = await db
        .select({ maxPublished: sql<string | Date | null>`max(${newsArticles.timePublishedUtc})` })
        .from(newsArticles);
      return watermarkRow?.maxPublished ?? null;
    },
    async insertBatch(rows: NewsRow[]): Promise<number> {
      // returning() hanya berisi baris yang benar-benar masuk.
      // ON CONFLICT DO NOTHING tanpa target: covers unique url DAN primary key id
      // (corpus punya 582 id kembar dengan url berbeda — conflict id tidak boleh crash).
      const result = await db
        .insert(newsArticles)
        .values(rows)
        .onConflictDoNothing()
        .returning({ id: newsArticles.id });
      return result.length;
    },
  };
}

/**
 * Ingest news_corpus.jsonl ke tabel news_articles secara incremental:
 * watermark = max(time_published_utc) di store, hanya artikel >= watermark yang
 * diproses, duplikat url/id disaring (dedupeRows), insert per batch BATCH_SIZE
 * (200) baris dengan ON CONFLICT DO NOTHING. Ports opsional menyuntik adapter
 * reader/store; default produksi = file corpus + drizzle db (call no-arg tetap jalan).
 */
export async function ingestNewsCorpus(
  ports: IngestPorts = {}
): Promise<{ inserted: number; skipped: number }> {
  const reader = ports.reader ?? createFileCorpusReader();
  const store = ports.store ?? createDrizzleNewsStore();

  const content = reader.readCorpus();
  if (content === null) return { inserted: 0, skipped: 0 };

  // Watermark: artikel lebih lama dari yang sudah tersimpan tidak perlu dibaca ulang.
  const watermarkRaw = await store.readWatermark();
  const watermarkValid = toWatermark(watermarkRaw);
  if (watermarkRaw !== null && watermarkValid === null) {
    console.warn("[Worker] Watermark tidak valid — ingest penuh tanpa watermark.");
  }

  let skipped = 0;
  const parsed: NewsRow[] = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;

    const row = parseArticleLine(line);
    if (!row) {
      skipped++; // Baris rusak atau field wajib kontrak tidak lengkap.
      continue;
    }
    if (watermarkValid && row.timePublishedUtc.getTime() < watermarkValid.getTime()) {
      skipped++; // Sudah terwakili watermark.
      continue;
    }
    parsed.push(row);
  }

  // Duplikat url/id dalam corpus (id hf bisa tabrakan antar artikel).
  const rows = dedupeRows(parsed);
  skipped += parsed.length - rows.length;

  let inserted = 0;
  for (const batch of toBatches(rows)) {
    inserted += await store.insertBatch(batch);
  }

  console.log(
    `[Worker] News corpus: ${inserted} artikel baru disimpan, ${skipped} dilewati` +
      (watermarkValid ? ` (watermark ${watermarkValid.toISOString()})` : " (DB kosong, ingest penuh)") +
      "."
  );
  return { inserted, skipped };
}
