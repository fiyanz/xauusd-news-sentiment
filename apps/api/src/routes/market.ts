/**
 * Module domain market: harga latest + candle windowed (DB-first).
 * Interface = GET /api/v1/market/xauusd/latest + /candles; caller meng-inject
 * FinancialClient lewat options plugin (satu instance dipakai bersama).
 * Resolusi candle (DB -> CSV -> estimasi -> sintetis) tetap di modul deep
 * candle-repository; di sini hanya parse query + adapter DB drizzle.
 */
import type { FastifyPluginAsync } from "fastify";
import { getCandles } from "@repo/financial-clients";
import type { FinancialClient, CandleDbPort, CandleProvenance } from "@repo/financial-clients";
import type { Timeframe } from "@repo/types";
import { COMPLIANCE_DISCLAIMER_FR10, TimeframeSchema } from "@repo/types";
import { db, priceCandles, and, desc, eq, lte } from "@repo/database";

const marketRoutes: FastifyPluginAsync<{ client: FinancialClient }> = async (fastify, { client }) => {
  fastify.get("/api/v1/market/xauusd/latest", async (_request, reply) => {
    const candles = await client.fetchXauusdCandles("15m", 5);
    if (!candles || candles.length === 0) {
      return reply.status(503).send({
        statusCode: 503,
        status: "unavailable",
        reason: "No candles available",
        disclaimer: COMPLIANCE_DISCLAIMER_FR10,
      });
    }
    const latest = candles[candles.length - 1]!;
    const isSimulated = latest.isSimulated === true;
    return {
      symbol: "XAUUSD",
      // Harga acuan = close candle terakhir. Bid/ask TIDAK dibangun karangan:
      // spread nyata tidak tersedia di sumber data.
      price: latest.close,
      bid: null,
      ask: null,
      spread: null,
      timestampUtc: latest.timestampUtc,
      isSimulated,
      status: isSimulated ? "simulated" : "ok",
      disclaimer: COMPLIANCE_DISCLAIMER_FR10,
    };
  });

  /**
   * Adapter DB produksi untuk port candle-repository (drizzle/TiDB).
   * Candle dari `price_candles` (Deriv recent + backfill CSV historis); kolom
   * `source` ikut dibaca supaya provenance per-baris jujur. Window terurut
   * naik, `to` inklusif (<=). DB mati -> melempar; modul fallback ke CSV.
   * Baris diteruskan apa adanya (termasuk `id`) — kontrak response tidak berubah.
   */
  const candleDbPort: CandleDbPort = {
    async queryCandles(tf, limit, to) {
      const conditions = [eq(priceCandles.symbol, "XAUUSD"), eq(priceCandles.timeframe, tf)];
      if (to !== undefined && Number.isFinite(to)) {
        conditions.push(lte(priceCandles.timestampUtc, to));
      }

      const rows = await db
        .select()
        .from(priceCandles)
        .where(and(...conditions))
        .orderBy(desc(priceCandles.timestampUtc))
        .limit(limit);
      rows.reverse();
      return rows.map((row) => ({ ...row, source: row.source as CandleProvenance }));
    },
  };

  // Windowed Paginated Candles API (prevents browser lag).
  // Seluruh resolusi (DB-first -> CSV -> estimasi -> sintetis) + pelabelan
  // provenance tinggal di modul deep candle-repository; endpoint ini hanya
  // mem-parse query dan meng-inject adapter DB drizzle.
  fastify.get<{ Querystring: { tf?: string; limit?: string; to?: string } }>(
    "/api/v1/market/xauusd/candles",
    async (request) => {
      const tfRaw = String(request.query.tf ?? "15m");
      const tf = TimeframeSchema.safeParse(tfRaw).success ? tfRaw : "15m";
      const limit = Math.max(1, Math.min(Number(request.query.limit) || 300, 1000)); // capped at 1000 for high performance
      const to = request.query.to ? Number(request.query.to) : undefined;

      return getCandles(tf as Timeframe, limit, to, { db: candleDbPort });
    }
  );
};

export default marketRoutes;