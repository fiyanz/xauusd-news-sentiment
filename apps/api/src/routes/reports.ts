/**
 * Module domain reports: laporan CFTC COT terbaru + ringkasan harian markdown.
 * Interface = GET /api/v1/reports/cot/latest + /daily/latest;
 * FinancialClient di-inject lewat options plugin.
 */
import type { FastifyPluginAsync } from "fastify";
import type { FinancialClient } from "@repo/financial-clients";
import { formatDate } from "@repo/core-analytics";
import { COMPLIANCE_DISCLAIMER_FR10 } from "@repo/types";

const reportsRoutes: FastifyPluginAsync<{ client: FinancialClient }> = async (fastify, { client }) => {
  fastify.get("/api/v1/reports/cot/latest", async () => {
    const cot = await client.fetchLatestCOTReport();

    if (!cot) {
      return {
        status: "unavailable",
        reason: "Laporan CFTC COT tidak bisa diakses (sumber: cftc.gov/dea/newcot/deafut.txt).",
        report: null,
        disclaimer: COMPLIANCE_DISCLAIMER_FR10,
      };
    }

    return {
      status: "ok",
      report: cot,
      source: "CFTC Commitments of Traders — Futures Only (deafut.txt)",
      disclaimer: COMPLIANCE_DISCLAIMER_FR10,
    };
  });

  fastify.get("/api/v1/reports/daily/latest", async () => {
    const now = new Date().toISOString().split("T")[0]!;
    const candles = await client.fetchXauusdCandles("1h", 24 * 7);

    if (candles.length === 0) {
      return {
        date: now,
        status: "unavailable",
        reason: "Data candle XAUUSD tidak tersedia.",
        markdownContent: null,
        complianceDisclaimer: COMPLIANCE_DISCLAIMER_FR10,
      };
    }

    const isSimulated = candles.every((candle) => candle.isSimulated === true);
    const first = candles[0]!;
    const last = candles[candles.length - 1]!;
    const high = Math.max(...candles.map((candle) => candle.high));
    const low = Math.min(...candles.map((candle) => candle.low));
    const changePct = ((last.close - first.open) / first.open) * 100;

    const cot = await client.fetchLatestCOTReport();
    const events = await client.fetchEconomicCalendar(30);
    const nowSec = Math.floor(Date.now() / 1000);
    const upcoming = events.filter((event) => event.dateUtc >= nowSec - 7 * 86400).slice(-8);

    const lines: string[] = [];
    lines.push(`# Ringkasan Harian Pasar Emas (XAUUSD) — ${now}`);
    lines.push("");
    lines.push(
      `> Sumber harga: ${
        isSimulated ? "CANDLE SINTETIS (dataset historis tidak tersedia)" : "dataset historis XAUUSD H1"
      }.`
    );
    lines.push("");
    lines.push("## 1. Pergerakan Harga (7 hari terakhir)");
    lines.push(
      `- Close terakhir: ${last.close.toFixed(2)} (${new Date(last.timestampUtc * 1000).toISOString()})`
    );
    lines.push(`- Rentang 7 hari: ${low.toFixed(2)} – ${high.toFixed(2)}`);
    lines.push(`- Perubahan: ${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%`);
    lines.push("");
    lines.push("## 2. Kalender Ekonomi (rilis terbaru / akan datang)");
    if (upcoming.length === 0) {
      lines.push("- Tidak ada data kalender yang tersedia.");
    } else {
      for (const event of upcoming) {
        const actual = event.actual === null ? "n/a" : event.actual;
        const forecast = event.forecast === null ? "n/a" : event.forecast;
        const simulated = event.isSimulated ? " (simulated)" : "";
        lines.push(
          `- ${formatDate(event.dateUtc)} — ${event.eventName}: actual ${actual}, forecast ${forecast}${simulated}`
        );
      }
    }
    lines.push("");
    lines.push("## 3. Posisi Institusional CFTC COT");
    if (cot) {
      lines.push(`- Tanggal laporan: ${cot.reportDate}`);
      lines.push(
        `- Non-commercial net: ${cot.netPosition > 0 ? "+" : ""}${cot.netPosition.toLocaleString("id-ID")} kontrak`
      );
      lines.push(
        `- Perubahan mingguan: ${cot.changeNet > 0 ? "+" : ""}${cot.changeNet.toLocaleString("id-ID")} kontrak`
      );
      lines.push(`- Sumber: cftc.gov/dea/newcot/deafut.txt`);
    } else {
      lines.push("- Data COT tidak tersedia (sumber CFTC tidak bisa diakses).");
    }
    lines.push("");
    lines.push(`_${COMPLIANCE_DISCLAIMER_FR10}_`);

    return {
      date: now,
      status: "ok",
      markdownContent: lines.join("\n"),
      sources: {
        candles: isSimulated ? "simulated" : "expert-dataset-h1",
        calendar: events.length > 0 ? "economic_calendar_enriched.csv" : "unavailable",
        cot: cot ? "cftc.gov/dea/newcot/deafut.txt" : "unavailable",
      },
      complianceDisclaimer: COMPLIANCE_DISCLAIMER_FR10,
    };
  });
};

export default reportsRoutes;