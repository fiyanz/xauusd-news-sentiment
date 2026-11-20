/**
 * Tes KARAKTERISASI kontrak HTTP API (behavior-preserving split server.ts).
 *
 * Seam yang diuji = interface HTTP publik (URL + response body persis),
 * bukan internal module. Fixture = baseline yang di-capture dari monolith
 * SEBELUM split (test/fixtures/*.json). Candle dikunci ke `to` = timestamp
 * candle terakhir saat baseline supaya slice DB identik antar-run.
 *
 * Prasyarat: dev server hidup di API_BASE_URL (default localhost:4000),
 * DB + sentiment service reachable seperti saat baseline di-capture.
 * Jalankan: bunx vitest@2.1.9 run test/server-contract.test.ts
 *
 * Field volatile yang TIDAK mungkin byte-identical antar-request (uptime,
 * timestamp respons) dinormalisasi di KEDUA sisi; sisanya tetap exact.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";

const BASE = process.env.API_BASE_URL ?? "http://localhost:4000";
const API = `${BASE}/api/v1`;

function fixture(name: string): string {
  return fs.readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf-8");
}
function pin(tf: string): string {
  return fs.readFileSync(new URL(`./fixtures/pin-${tf}.txt`, import.meta.url), "utf-8").trim();
}

/** Endpoint yang body-nya harus byte-identical dengan baseline. */
const EXACT: Array<[name: string, path: string]> = [
  ["market-latest", "/market/xauusd/latest"],
  ["calendar-upcoming", "/calendar/upcoming"],
  ["event-study-NFP", "/analytics/event-study/NFP"],
  ["event-study-CPI", "/analytics/event-study/CPI"],
  ["event-study-FOMC", "/analytics/event-study/FOMC"],
  ["event-study-PCE", "/analytics/event-study/PCE"],
  ["reports-cot-latest", "/reports/cot/latest"],
  ["reports-daily-latest", "/reports/daily/latest"],
];

/** Normalisasi field volatile (hanya field ini; sisanya dibandingkan exact). */
function normalizeVolatile(name: string, body: string): string {
  const obj = JSON.parse(body) as Record<string, unknown>;
  if (name === "system-health") {
    expect(typeof obj.uptime).toBe("number");
    expect(String(obj.timestamp)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    obj.uptime = "<uptime>";
    obj.timestamp = "<timestamp>";
  }
  if (name === "pipeline-sync-no-token") {
    expect(String(obj.timestamp)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    obj.timestamp = "<timestamp>";
  }
  return JSON.stringify(obj);
}

describe("kontrak HTTP persis baseline (characterization)", () => {
  for (const [name, path] of EXACT) {
    it(`${path} body byte-identical dengan baseline`, async () => {
      const res = await fetch(`${API}${path}`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(fixture(name));
    }, 30_000);
  }

  for (const tf of ["1h", "15m", "4h"]) {
    it(`/market/xauusd/candles?tf=${tf}&limit=50 (to dipin) byte-identical`, async () => {
      const res = await fetch(`${API}/market/xauusd/candles?tf=${tf}&limit=50&to=${pin(tf)}`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(fixture(`candles-${tf}`));
    }, 30_000);
  }

  it("/system/health identik kecuali uptime+timestamp (volatile)", async () => {
    const res = await fetch(`${API}/system/health`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(normalizeVolatile("system-health", body)).toBe(
      normalizeVolatile("system-health", fixture("system-health"))
    );
  }, 30_000);

  it("POST /pipeline/sync tanpa token -> 503 disabled, shape persis (timestamp volatile)", async () => {
    const res = await fetch(`${API}/pipeline/sync`, { method: "POST" });
    expect(res.status).toBe(503);
    const body = await res.text();
    expect(normalizeVolatile("pipeline-sync-no-token", body)).toBe(
      normalizeVolatile("pipeline-sync-no-token", fixture("pipeline-sync-no-token"))
    );
  }, 30_000);

  // Dua endpoint di bawah bersumber DATA LIVE (sentiment service + ingest
  // worker), jadi byte baseline bisa drift antar-waktu tanpa perubahan kode.
  // Kontrak diuji lewat invarian yang tidak boleh berubah: pass-through
  // persis (sentiment) dan serialisasi per-baris + shape (news).

  it("/analytics/macro-sentiment/latest = pass-through byte-persis sentiment service", async () => {
    const res = await fetch(`${API}/analytics/macro-sentiment/latest`);
    expect(res.status).toBe(200);
    const body = await res.text();
    const obj = JSON.parse(body) as Record<string, unknown>;
    const baseline = JSON.parse(fixture("macro-sentiment-latest")) as Record<string, unknown>;
    expect(obj.disclaimer).toBe(baseline.disclaimer);

    const sentimentUrl = (process.env.SENTIMENT_SERVICE_URL || "http://localhost:8000").replace(/\/+$/, "");
    let pred: Record<string, unknown> | null = null;
    try {
      const s = await fetch(`${sentimentUrl}/prediction`, { signal: AbortSignal.timeout(5000) });
      if (s.ok) pred = (await s.json()) as Record<string, unknown>;
    } catch {
      // service mati -> cabang unavailable di bawah
    }

    if (pred) {
      // Urutan key spread sama dengan handler: {...pred, status, disclaimer}.
      expect(body).toBe(JSON.stringify({ ...pred, status: "ok", disclaimer: obj.disclaimer }));
    } else {
      expect(obj.status).toBe("unavailable");
      expect(obj.reason).toBe(
        "Prediksi sentiment belum tersedia — sentiment service tidak merespons atau pipeline belum dijalankan."
      );
      for (const k of [
        "model_champion", "current_price", "prediction_horizon", "predicted_return_pct",
        "predicted_target_price", "predicted_pips_delta", "signal", "sentiment_label",
        "confidence_pct", "macro_drivers",
      ]) {
        expect(obj[k]).toBeNull();
      }
    }
  }, 30_000);

  it("/news/latest?limit=5 shape + serialisasi per-baris persis baseline (baris baru worker = drift wajar)", async () => {
    const res = await fetch(`${API}/news/latest?limit=5`);
    expect(res.status).toBe(200);
    const now = (await res.json()) as {
      status: string; count: number; disclaimer: string;
      articles: Array<Record<string, unknown> & { id: string }>;
    };
    const base = JSON.parse(fixture("news-latest-5")) as typeof now;

    expect(Object.keys(now).sort()).toEqual(Object.keys(base).sort());
    expect(now.status).toBe("ok");
    expect(now.disclaimer).toBe(base.disclaimer);
    expect(now.count).toBe(now.articles.length);
    expect(now.articles.length).toBeLessThanOrEqual(5);
    for (const a of now.articles) {
      expect(Object.keys(a).sort()).toEqual(Object.keys(base.articles[0]!).sort());
    }

    // Artikel baseline yang masih ada di DB harus terserialisasi byte-identical
    // (top-5 bisa bergeser karena worker meng-ingest berita baru).
    const res200 = await fetch(`${API}/news/latest?limit=200`);
    expect(res200.status).toBe(200);
    const wide = (await res200.json()) as typeof now;
    const byId = new Map(wide.articles.map((a) => [a.id, a]));
    for (const a of base.articles) {
      const cur = byId.get(a.id);
      if (cur) expect(JSON.stringify(cur)).toBe(JSON.stringify(a));
    }
  }, 30_000);
});

describe("SSE /market/xauusd/stream", () => {
  it("tetap stream tick Deriv live (>=1 frame data, shape tick persis)", async () => {
    const ctrl = new AbortController();
    const res = await fetch(`${API}/market/xauusd/stream`, { signal: ctrl.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache");

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const dataFrames = () => buf.split("\n\n").filter((f) => f.startsWith("data:"));
    // Tick Deriv ~1/detik; beri jendela 6 detik lalu abort.
    const timer = setTimeout(() => ctrl.abort(), 6_000);
    try {
      while (dataFrames().length < 2) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
      }
    } catch {
      // abort setelah jendela waktu -> lanjut dengan frame yang terkumpul
    } finally {
      clearTimeout(timer);
      ctrl.abort();
    }

    const frames = dataFrames();
    expect(frames.length).toBeGreaterThanOrEqual(1);
    const tick = JSON.parse(frames[0]!.slice("data:".length)) as Record<string, unknown>;
    expect(Object.keys(tick).sort()).toEqual(
      ["ask", "bid", "isSimulated", "price", "source", "timestampUtc"].sort()
    );
    expect(tick.source).toBe("deriv-cfd");
    expect(tick.isSimulated).toBe(false);
    expect(tick.bid).toBeNull();
    expect(tick.ask).toBeNull();
    expect(typeof tick.price).toBe("number");
    expect(typeof tick.timestampUtc).toBe("number");
  }, 20_000);
});