import path from "path";

/**
 * Root repo, portabel: `REPO_ROOT` di env bila diset, kalau tidak diturunkan
 * dari cwd (`../..` — cocok untuk apps/* yang dijalankan dari direktorinya).
 */
export function repoRoot(): string {
  return process.env.REPO_ROOT
    ? path.resolve(process.env.REPO_ROOT)
    : path.resolve(process.cwd(), "../..");
}

/** Path di dalam services/sentiment-analysis (data/model Python). */
export function sentimentDataPath(...segments: string[]): string {
  return path.resolve(repoRoot(), "services", "sentiment-analysis", ...segments);
}
