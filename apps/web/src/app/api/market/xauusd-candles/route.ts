import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Proxy JSON: browser -> route ini -> apps/api (/api/v1/market/xauusd/candles).
 * Sumber candle berurutan: price_candles (Deriv via worker) -> CSV historis.
 * `source` dari API dipertahankan supaya chart bisa menampilkan provenance jujur
 * (deriv-cfd / csv-historical / simulated).
 */
const API_BASE =
  process.env.API_INTERNAL_URL ?? `http://localhost:${process.env.PORT_API ?? "4000"}`;

const API_TIMEOUT_MS = 8000;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.toString();

  try {
    const upstream = await fetch(
      `${API_BASE}/api/v1/market/xauusd/candles${query ? `?${query}` : ""}`,
      { cache: "no-store", signal: AbortSignal.timeout(API_TIMEOUT_MS) }
    );

    if (!upstream.ok) {
      return NextResponse.json(
        { status: "unavailable", reason: `API merespons HTTP ${upstream.status}.` },
        { status: upstream.status }
      );
    }

    const payload = await upstream.json();
    return NextResponse.json(payload, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json(
      {
        status: "unavailable",
        reason: `API di ${API_BASE} tidak terjangkau.`,
      },
      { status: 503 }
    );
  }
}
