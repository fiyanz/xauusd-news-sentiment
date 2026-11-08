import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const API_TIMEOUT_MS = 2000;
const DISCLAIMER = "FR-10: Research Analytics Only • Non-Advisory";

/**
 * Event study dihitung oleh API analitik (localhost:4000) dari kalender dan
 * candle nyata. Route ini hanya proksi — tidak ada angka bawaan.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = (searchParams.get("code") || "cpi").toLowerCase();

  try {
    const apiRes = await fetch(`http://localhost:4000/api/v1/analytics/event-study/${code}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (apiRes.ok) {
      const data = await apiRes.json();
      return NextResponse.json({ ...data, disclaimer: DISCLAIMER });
    }
  } catch {}

  return NextResponse.json(
    {
      status: "unavailable",
      reason:
        "Analisis event study tidak tersedia: API analitik (localhost:4000) tidak merespons atau data kalender/candle nyata belum ada.",
      eventCode: code.toUpperCase(),
      surprise: null,
      reactions: [],
      aggregatedStats: null,
      historicalLogs: [],
      disclaimer: DISCLAIMER,
    },
    {
      headers: {
        "Cache-Control": "public, max-age=10, stale-while-revalidate=60",
      },
    }
  );
}
