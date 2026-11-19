import fs from "node:fs";
import path from "node:path";
import { db, newsArticles, sql } from "@repo/database";

/** Ukuran batch insert corpus. TiDB Cloud menutup koneksi bila statement
 * multi-row terlalu besar (teks title+summary); 200 baris aman, 1000 terlalu besar. */
const BATCH_SIZE = 200;

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

/** topics di corpus berupa array; kolom DB menyimpan JSON string. */
function topicsToJson(raw: unknown): string | null {
  if (Array.isArray(raw)) return JSON.stringify(raw);
  if (typeof raw === "string" && raw.length > 0) return raw;
  return null;
}

/**
 * Ingest news_corpus.jsonl ke tabel news_articles secara incremental:
 * watermark = max(time_published_utc) di DB, hanya artikel >= watermark yang
 * diproses (artikel kembar disaring unique url), insert batch 1000 baris
 * dengan ON CONFLICT DO NOTHING(url).
 */
export async function ingestNewsCorpus(): Promise<{ inserted: number; skipped: number }> {
  const corpusPath = getCorpusPath();
  if (!fs.existsSync(corpusPath)) {
    console.warn(`[Worker] Corpus berita tidak ditemukan (${corpusPath}) — ingest dilewati.`);
    return { inserted: 0, skipped: 0 };
  }

  // Watermark: artikel lebih lama dari yang sudah tersimpan tidak perlu dibaca ulang.
  // Catatan: aggregate max() lewat sql`` dikembalikan postgres-js sebagai string,
  // bukan Date — wajib diconvert dulu (kalau tidak, getTime() crash saat re-run).
  const [watermarkRow] = await db
    .select({ maxPublished: sql<string | Date | null>`max(${newsArticles.timePublishedUtc})` })
    .from(newsArticles);
  const watermarkRaw = watermarkRow?.maxPublished ?? null;
  const watermark = watermarkRaw === null ? null : new Date(watermarkRaw);
  if (watermark !== null && Number.isNaN(watermark.getTime())) {
    console.warn("[Worker] Watermark tidak valid — ingest penuh tanpa watermark.");
  }
  const watermarkValid = watermark !== null && !Number.isNaN(watermark.getTime()) ? watermark : null;

  const rows: (typeof newsArticles.$inferInsert)[] = [];
  const seenUrls = new Set<string>();
  const seenIds = new Set<string>();
  let skipped = 0;

  const content = fs.readFileSync(corpusPath, "utf-8");
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;

    let article: CorpusArticle;
    try {
      article = JSON.parse(line) as CorpusArticle;
    } catch {
      skipped++; // Baris rusak dilewati, bukan ditebak isinya.
      continue;
    }

    const id = textOrNull(article.id);
    const url = textOrNull(article.url);
    const title = textOrNull(article.title);
    const published = parsePublishedUtc(article.time_published_utc);
    if (!id || !url || !title || !published) {
      skipped++; // Field wajib kontrak tidak lengkap.
      continue;
    }
    if (watermarkValid && published.getTime() < watermarkValid.getTime()) {
      skipped++; // Sudah terwakili watermark.
      continue;
    }
    if (seenUrls.has(url) || seenIds.has(id)) {
      skipped++; // Duplikat url/id dalam corpus (id hf bisa tabrakan antar artikel).
      continue;
    }
    seenUrls.add(url);
    seenIds.add(id);

    rows.push({
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
    });
  }

  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    // returning() hanya berisi baris yang benar-benar masuk.
    // ON CONFLICT DO NOTHING tanpa target: covers unique url DAN primary key id
    // (corpus punya 582 id kembar dengan url berbeda — conflict id tidak boleh crash).
    const result = await db
      .insert(newsArticles)
      .values(batch)
      .onConflictDoNothing()
      .returning({ id: newsArticles.id });
    inserted += result.length;
  }

  console.log(
    `[Worker] News corpus: ${inserted} artikel baru disimpan, ${skipped} dilewati` +
      (watermarkValid ? ` (watermark ${watermarkValid.toISOString()})` : " (DB kosong, ingest penuh)") +
      "."
  );
  return { inserted, skipped };
}
