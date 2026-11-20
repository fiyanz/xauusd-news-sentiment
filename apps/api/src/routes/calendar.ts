/**
 * Module domain calendar: kalender ekonomi rilis mendatang (impact HIGH).
 * Interface = GET /api/v1/calendar/upcoming; FinancialClient di-inject.
 */
import type { FastifyPluginAsync } from "fastify";
import type { FinancialClient } from "@repo/financial-clients";
import { COMPLIANCE_DISCLAIMER_FR10 } from "@repo/types";

const calendarRoutes: FastifyPluginAsync<{ client: FinancialClient }> = async (fastify, { client }) => {
  fastify.get("/api/v1/calendar/upcoming", async () => {
    const events = await client.fetchEconomicCalendar();

    if (events.length === 0) {
      return {
        status: "unavailable",
        reason:
          "Kalender ekonomi tidak tersedia (economic_calendar_enriched.csv tidak ditemukan).",
        count: 0,
        events: [],
        disclaimer: COMPLIANCE_DISCLAIMER_FR10,
      };
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const upcoming = events
      .filter((event) => event.impact === "HIGH" && event.dateUtc >= nowSec - 7 * 86400)
      .slice(-100);

    return {
      status: "ok",
      count: upcoming.length,
      events: upcoming,
      disclaimer: COMPLIANCE_DISCLAIMER_FR10,
    };
  });
};

export default calendarRoutes;