/**
 * ExpertDataService — cangkang tipis di atas candle-repository.
 *
 * Seluruh mesin candle (parser CSV kanonik, cache file, agregasi, subdivisi
 * estimasi, resolusi window) sudah pindah ke ./candle-repository.ts sebagai
 * satu modul deep. Di sini hanya tersisa: delegate getRecentCandles (kompat)
 * dan pembaca berita kalender high-impact (pakai parser CSV kanonik).
 *
 * Kosakata provenance lama ('real'/'estimated'/'unknown') dan state global
 * `lastCandleSource` DIHAPUS: tidak ada pemanggil, dan provenance kini satu
 * kosakata di candle-repository ('deriv-cfd'|'csv-historical'|'simulated').
 */
import fs from "node:fs";
import readline from "node:readline";
import path from "node:path";
import type { OHLCV, Timeframe } from "@repo/types";
import { createFileCsvAdapter, parseCsvLine, resolveCsvWindow } from "./candle-repository.js";

const EXPERT_DATA_DIR = process.env.EXTERNAL_DATA_DIR || "";

export interface RealNewsEvent {
  timestampUtc: number;
  dateStr: string;
  currency: string;
  name: string;
  impact: string;
}

export class ExpertDataService {
  private dataDir: string;

  constructor(dataDir: string = EXPERT_DATA_DIR) {
    this.dataDir = dataDir;
  }

  /**
   * Delegate tipis: resolusi window CSV (H1 -> agregasi/subdivisi/intraday)
   * tinggal di candle-repository. Perilaku lama dipertahankan, termasuk
   * `to` eksklusif dan [] bila CSV H1 tidak tersedia.
   */
  async getRecentCandles(
    timeframe: Timeframe = "15m",
    limit: number = 300,
    to?: number
  ): Promise<OHLCV[]> {
    return resolveCsvWindow(timeframe, limit, to, createFileCsvAdapter(this.dataDir));
  }

  // Baca rilis berita ekonomi high-impact nyata dari CSV kalender.
  async getHighImpactNews(limit: number = 100): Promise<RealNewsEvent[]> {
    const filePath = path.join(this.dataDir, "news_calendar_high_impact.csv");
    if (!this.dataDir || !fs.existsSync(filePath)) return [];

    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    const events: RealNewsEvent[] = [];
    let isHeader = true;

    for await (const line of rl) {
      if (isHeader) {
        isHeader = false;
        continue;
      }
      if (!line.trim()) continue;

      const parts = parseCsvLine(line);
      if (parts.length < 4) continue;

      const tsStr = parts[0]!;
      const currency = parts[1]!;
      const name = parts[2]!;
      const impact = parts[3]!;

      const timestampUtc = Math.floor(new Date(tsStr + "Z").getTime() / 1000);

      events.push({
        timestampUtc,
        dateStr: tsStr,
        currency,
        name,
        impact,
      });
    }

    return events.slice(-limit);
  }
}
