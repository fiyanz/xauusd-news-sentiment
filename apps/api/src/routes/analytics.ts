/**
 * Module domain analytics: event study per rilis + macro-sentiment terbaru.
 * Interface = GET /api/v1/analytics/event-study/:eventCode +
 * /api/v1/analytics/macro-sentiment/latest. Event study = adapter tipis di
 * seam runEventStudy (modul deep core-analytics); sentiment dibaca dari
 * sentiment service HTTP sesuai kontrak deploy.
 */
import type { FastifyPluginAsync } from "fastify";
import type { FinancialClient } from "@repo/financial-clients";
import { runEventStudy } from "@repo/core-analytics";
import { COMPLIANCE_DISCLAIMER_FR10 } from "@repo/types";

/**
 * Sentiment-analysis sekarang service HTTP terpisah (bukan spawn uv lokal).
 * Prediksi dan trigger sync diakses lewat URL ini sesuai kontrak deploy.
 */
const SENTIMENT_SERVICE_URL = (
  process.env.SENTIMENT_SERVICE_URL || "http://localhost:8000"
).replace(/\/+$/, "");

const analyticsRoutes: FastifyPluginAsync<{ client: FinancialClient }> = async (fastify, { client }) => {
  // Event study = adapter tipis di seam runEventStudy (modul deep core-analytics):
  // pemilihan window (event+1j15m, 400 candle 15m), stdDev nyata per rilis, dan
  // agregasi stats semua di modul. Endpoint hanya meng-inject port FinancialClient
  // dan memetakan report ke bentuk response lama (kontrak tidak berubah).
  fastify.get<{ Params: { eventCode: string } }>(
    "/api/v1/analytics/event-study/:eventCode",
    async (request) => {
      const report = await runEventStudy(request.params.eventCode, {
        candles: {
          fetchCandlesUpTo: (endUtc, limit) => client.fetchXauusdCandles("15m", limit, endUtc),
        },
        calendar: { fetchReleases: () => client.fetchEconomicCalendar() },
      });

      // Cabang tanpa rilis kalender: bentuk response lama (tanpa dataQuality).
      if (report.dataQuality.totalEvents === 0) {
        return {
          eventCode: report.eventCode,
          status: report.status,
          reason: report.reason,
          surprise: null,
          reactions: [],
          aggregatedStats: null,
          historicalLogs: [],
          disclaimer: COMPLIANCE_DISCLAIMER_FR10,
        };
      }

      return {
        eventCode: report.eventCode,
        status: report.status,
        reason: report.reason,
        surprise: report.surprise,
        reactions: report.reactions,
        aggregatedStats: report.aggregatedStats,
        historicalLogs: report.historicalLogs,
        dataQuality: report.dataQuality,
        disclaimer: COMPLIANCE_DISCLAIMER_FR10,
      };
    }
  );

  fastify.get("/api/v1/analytics/macro-sentiment/latest", async () => {
    // Prediksi dibaca dari sentiment service (timeout 5 detik), bukan file lagi.
    try {
      const res = await fetch(`${SENTIMENT_SERVICE_URL}/prediction`, {
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const pred = (await res.json()) as Record<string, unknown>;
        return {
          ...pred,
          status: "ok",
          disclaimer: COMPLIANCE_DISCLAIMER_FR10,
        };
      }
    } catch {
      // Service mati/timeout/rusak -> unavailable (bukan angka karangan).
    }

    return {
      status: "unavailable",
      reason:
        "Prediksi sentiment belum tersedia — sentiment service tidak merespons atau pipeline belum dijalankan.",
      model_champion: null,
      current_price: null,
      prediction_horizon: null,
      predicted_return_pct: null,
      predicted_target_price: null,
      predicted_pips_delta: null,
      signal: null,
      sentiment_label: null,
      confidence_pct: null,
      macro_drivers: null,
      disclaimer: COMPLIANCE_DISCLAIMER_FR10,
    };
  });
};

export default analyticsRoutes;