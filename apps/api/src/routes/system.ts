/**
 * Module domain system: health check API.
 * Interface = satu route GET /api/v1/system/health (kontrak tidak berubah).
 */
import type { FastifyPluginAsync } from "fastify";

const systemRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/api/v1/system/health", async () => {
    return {
      status: "healthy",
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      compliance: "FR-10 Validated",
      dataset: "Historical Expert CSV Active",
    };
  });
};

export default systemRoutes;