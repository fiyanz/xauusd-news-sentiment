/**
 * Module domain pipeline: trigger sync macro-sentiment (POST, token-gated).
 * Interface = POST /api/v1/pipeline/sync; lock single-flight ada di sentiment
 * service (cross-request), 409 already_running diteruskan apa adanya.
 */
import type { FastifyPluginAsync } from "fastify";

/**
 * Sentiment-analysis sekarang service HTTP terpisah (bukan spawn uv lokal).
 * Prediksi dan trigger sync diakses lewat URL ini sesuai kontrak deploy.
 */
const SENTIMENT_SERVICE_URL = (
  process.env.SENTIMENT_SERVICE_URL || "http://localhost:8000"
).replace(/\/+$/, "");

const PIPELINE_SYNC_TOKEN = process.env.PIPELINE_SYNC_TOKEN || "";

const pipelineRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post("/api/v1/pipeline/sync", async (request, reply) => {
    if (!PIPELINE_SYNC_TOKEN) {
      return reply.status(503).send({
        statusCode: 503,
        status: "disabled",
        error: "Service Unavailable",
        reason:
          "PIPELINE_SYNC_TOKEN tidak diset; endpoint sync dinonaktifkan untuk mencegah penyalahgunaan.",
        timestamp: new Date().toISOString(),
      });
    }

    const rawToken = request.headers["x-pipeline-token"];
    const providedToken = Array.isArray(rawToken) ? undefined : rawToken;
    if (providedToken !== PIPELINE_SYNC_TOKEN) {
      return reply.status(401).send({
        statusCode: 401,
        status: "unauthorized",
        error: "Unauthorized",
        reason: "Header x-pipeline-token tidak valid.",
        timestamp: new Date().toISOString(),
      });
    }

    // Teruskan ke sentiment service; lock single-flight ada di service (cross-request),
    // 409 already_running diteruskan dengan response shape lama.
    try {
      const res = await fetch(`${SENTIMENT_SERVICE_URL}/sync`, {
        method: "POST",
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 409) {
        return reply.status(409).send({
          statusCode: 409,
          error: "Conflict",
          message: "Pipeline sync already in progress.",
          timestamp: new Date().toISOString(),
        });
      }
      if (res.ok) {
        return {
          status: "sync_dispatched",
          message: "Automated macro-sentiment pipeline sync triggered in background.",
          timestamp: new Date().toISOString(),
        };
      }
      return reply.status(503).send({
        statusCode: 503,
        status: "unavailable",
        error: "Service Unavailable",
        reason: `Sentiment service menolak sync (HTTP ${res.status}).`,
        timestamp: new Date().toISOString(),
      });
    } catch {
      return reply.status(503).send({
        statusCode: 503,
        status: "unavailable",
        error: "Service Unavailable",
        reason: `Sentiment service tidak bisa dihubungi di ${SENTIMENT_SERVICE_URL}.`,
        timestamp: new Date().toISOString(),
      });
    }
  });
};

export default pipelineRoutes;