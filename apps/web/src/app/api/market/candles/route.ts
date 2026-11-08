import { NextResponse } from "next/server";
import { getCandles } from "@/lib/candle-cache";

export const dynamic = "force-dynamic";

const CACHE_HEADERS = {
  "Cache-Control": "public, max-age=5, stale-while-revalidate=30",
};

/**
 * Series XAUUSD. `5m`/`15m` memakai CSV intraday nyata bila tersedia, dan
 * fallback ke estimasi H1 yang ditandai `source: "estimated"` — tidak pernah
 * menampilkan estimasi sebagai data pasar.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const tf = searchParams.get("tf") || "1h";
  const limitParam = searchParams.get("limit");
  const toParam = searchParams.get("to");

  const parsedLimit = Number.parseInt(limitParam ?? "250", 10);
  const limit = Number.isFinite(parsedLimit) ? parsedLimit : 250;
  const parsedTo = Number.parseInt(toParam ?? "", 10);
  const to = toParam !== null && Number.isFinite(parsedTo) ? parsedTo : undefined;

  const result = await getCandles(tf, limit, to);

  if (result.count === 0) {
    return NextResponse.json(
      {
        status: "unavailable",
        reason: "Data candle XAUUSD tidak tersedia untuk parameter ini.",
        symbol: "XAUUSD",
        timeframe: tf,
        count: 0,
        data: [],
        source: result.source,
        estimatedCount: result.estimatedCount,
        disclaimer: result.disclaimer,
      },
      { headers: CACHE_HEADERS }
    );
  }

  return NextResponse.json(
    {
      symbol: result.symbol,
      timeframe: result.timeframe,
      count: result.count,
      data: result.data,
      source: result.source,
      estimatedCount: result.estimatedCount,
      disclaimer: result.disclaimer,
    },
    { headers: CACHE_HEADERS }
  );
}
