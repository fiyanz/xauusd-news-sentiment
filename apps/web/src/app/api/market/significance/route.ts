import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

import { sentimentDataPath } from "@/lib/paths";

export const dynamic = "force-dynamic";

const API_TIMEOUT_MS = 2000;
const DISCLAIMER = "FR-10: Research Analytics Only • Non-Advisory";

function findSignificanceFile(): string | null {
  const candidates = [
    path.resolve(process.cwd(), "../../services/sentiment-analysis/reports/significance.json"),
    path.resolve(process.cwd(), "services/sentiment-analysis/reports/significance.json"),
    sentimentDataPath("reports/significance.json"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Signifikansi statistik model (reports/significance.json) yang ditulis oleh
 * pipeline evaluasi. Dibaca defensif: bila file belum ada, kembalikan
 * `unavailable` — tidak ada angka bawaan.
 */
export async function GET() {
  const filePath = findSignificanceFile();

  if (!filePath) {
    return NextResponse.json({
      status: "unavailable",
      reason: "reports/significance.json belum tersedia.",
      significance: null,
      disclaimer: DISCLAIMER,
    });
  }

  try {
    const significance = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return NextResponse.json({
      status: "ok",
      significance,
      disclaimer: DISCLAIMER,
    });
  } catch {
    return NextResponse.json({
      status: "unavailable",
      reason: "reports/significance.json tidak bisa dibaca.",
      significance: null,
      disclaimer: DISCLAIMER,
    });
  }
}
