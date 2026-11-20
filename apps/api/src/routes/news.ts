/**
 * Module domain news: berita terbaru dari news_articles (di-ingest worker).
 * Interface = GET /api/v1/news/latest (limit + filter topic opsional).
 * parseTopics tetap lokal di sini (perilaku sama, tanpa import cross-app).
 */
import type { FastifyPluginAsync } from "fastify";
import { COMPLIANCE_DISCLAIMER_FR10 } from "@repo/types";
import { db, newsArticles, desc, like } from "@repo/database";

/** Kolom topics disimpan sebagai JSON string; kembalikan array bila valid. */
function parseTopics(raw: string | null): unknown[] | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const newsRoutes: FastifyPluginAsync = async (fastify) => {
  // Berita terbaru dari news_articles (di-ingest worker dari corpus sentiment).
  fastify.get<{ Querystring: { limit?: string; topic?: string } }>(
    "/api/v1/news/latest",
    async (request, reply) => {
      const limit = Math.max(1, Math.min(Number(request.query.limit) || 50, 200));
      const topic = (request.query.topic ?? "").trim();

      try {
        // Filter topic opsional lewat kolom topics (JSON string) dengan LIKE.
        const topicFilter = topic
          ? like(newsArticles.topics, `%${topic.replace(/[\\%_]/g, "\\$&")}%`)
          : undefined;
        const rows = await db
          .select()
          .from(newsArticles)
          .where(topicFilter)
          .orderBy(desc(newsArticles.timePublishedUtc))
          .limit(limit);

        const articles = rows.map((row) => ({
          ...row,
          topics: parseTopics(row.topics),
        }));
        return {
          status: "ok",
          count: articles.length,
          articles,
          disclaimer: COMPLIANCE_DISCLAIMER_FR10,
        };
      } catch (error) {
        // DB mati/tabel belum ada -> unavailable, bukan data karangan.
        console.warn(
          `[API] news_articles tidak bisa dibaca: ${error instanceof Error ? error.message : String(error)}`
        );
        return reply.status(503).send({
          status: "unavailable",
          reason: "Database berita tidak bisa diakses.",
          count: 0,
          articles: [],
          disclaimer: COMPLIANCE_DISCLAIMER_FR10,
        });
      }
    }
  );
};

export default newsRoutes;