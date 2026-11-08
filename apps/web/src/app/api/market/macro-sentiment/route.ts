import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

import { sentimentDataPath } from "@/lib/paths";

export const dynamic = "force-dynamic";

const API_TIMEOUT_MS = 2000;
const DISCLAIMER = "FR-10: Research Analytics Only • Non-Advisory";

function getPredictionFilePath(): string | null {
  const candidates = [
    path.resolve(process.cwd(), "../../services/sentiment-analysis/data/processed/latest_prediction.json"),
    path.resolve(process.cwd(), "services/sentiment-analysis/data/processed/latest_prediction.json"),
    sentimentDataPath("data/processed/latest_prediction.json"),
  ];

  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return c;
    }
  }
  return null;
}

export async function GET() {
  // 1. Try external API port 4000 first
  try {
    const apiRes = await fetch("http://localhost:4000/api/v1/analytics/macro-sentiment/latest", {
      cache: "no-store",
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (apiRes.ok) {
      const data = await apiRes.json();
      return NextResponse.json({ ...data, disclaimer: DISCLAIMER });
    }
  } catch {}

  // 2. Direct file reading fallback from Python pipeline output
  const filePath = getPredictionFilePath();
  if (filePath) {
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const json = JSON.parse(content);
      return NextResponse.json({
        ...json,
        status: "ok",
        disclaimer: DISCLAIMER,
      });
    } catch {}
  }

  // 3. Unavailable — tanpa angka karangan
  return NextResponse.json(
    {
      status: "unavailable",
      reason:
        "latest_prediction.json belum tersedia atau tidak bisa dibaca — pipeline sentiment-analysis belum dijalankan.",
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
      disclaimer: DISCLAIMER,
    },
    {
      headers: {
        "Cache-Control": "public, max-age=5, stale-while-revalidate=30",
      },
    }
  );
}
