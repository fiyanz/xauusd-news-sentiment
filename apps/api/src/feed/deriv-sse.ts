/**
 * Module deep feed Deriv + SSE: satu koneksi WebSocket publik Deriv
 * (frxXAUUSD) untuk semua klien SSE; tick TIDAK disimpan ke DB.
 * Interface kecil: plugin Fastify (route GET /api/v1/market/xauusd/stream)
 * + broadcast(payload) untuk menyiar ke semua penulis SSE terdaftar.
 * Seluruh manajemen koneksi, reconnect, heartbeat, dan cleanup klien
 * tersembunyi di implementation ini (leverage untuk caller, locality
 * untuk maintainer). Bid/ask Deriv tidak disediakan -> null (tidak dikarang).
 */
import type { FastifyPluginAsync } from "fastify";
import { DerivClient } from "@repo/financial-clients";

const DERIV_APP_ID = process.env.DERIV_APP_ID ?? "";
const DERIV_SYMBOL = "frxXAUUSD";
const sseWriters = new Set<(chunk: string) => void>();

export function broadcast(payload: Record<string, unknown>): void {
  const chunk = `data: ${JSON.stringify(payload)}\n\n`;
  for (const write of sseWriters) {
    try {
      write(chunk);
    } catch {
      // Klien sudah pergi; entri akan dibersihkan oleh event "close".
    }
  }
}

let derivClient: DerivClient | null = null;
function startDeriv(): void {
  if (!DERIV_APP_ID || derivClient) return;
  const instance = new DerivClient({
    appId: DERIV_APP_ID,
    token: process.env.DERIV_API_TOKEN || undefined,
    symbol: DERIV_SYMBOL,
  });
  derivClient = instance;

  instance.onTick((tick) => {
    broadcast({
      timestampUtc: tick.epoch,
      price: tick.price,
      bid: null,
      ask: null,
      source: "deriv-cfd",
      isSimulated: false,
    });
  });

  instance.onDisconnect = () => {
    broadcast({
      status: "disconnected",
      reason: "Deriv WebSocket tertutup; menghubung ulang otomatis.",
    });
  };

  instance.connect();
  instance.subscribe(DERIV_SYMBOL);
}

/**
 * Origin web yang diizinkan. Default localhost:3000; bisa daftar dipisah koma
 * via WEB_ORIGIN (mis. "http://localhost:3000,https://domain.com").
 */
const WEB_ORIGIN = (process.env.WEB_ORIGIN || "http://localhost:3000")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const derivSseRoutes: FastifyPluginAsync = async (fastify) => {
  // Server-Sent Events (SSE) untuk harga live Deriv (frxXAUUSD).
  // Tick asli dari WebSocket Deriv — bukan simulasi.
  fastify.get("/api/v1/market/xauusd/stream", async (request, reply) => {
    // Fastify akan menutup response begitu handler selesai; hijack supaya
    // koneksi SSE tetap terbuka.
    reply.hijack();
    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("Access-Control-Allow-Origin", WEB_ORIGIN[0] ?? "");

    if (!DERIV_APP_ID) {
      reply.raw.write(
        `data: ${JSON.stringify({
          status: "unavailable",
          reason: "DERIV_APP_ID belum diatur di environment.",
        })}\n\n`
      );
      return reply.raw.end();
    }

    startDeriv();

    const write = (chunk: string) => reply.raw.write(chunk);
    sseWriters.add(write);

    // Heartbeat menjaga proxy/load balancer tidak menutup koneksi yang diam
    // (mis. saat market tutup dan tidak ada tick).
    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(": hb\n\n");
      } catch {
        // Klien sudah pergi; "close" akan membersihkan.
      }
    }, 25_000);

    request.raw.on("close", () => {
      clearInterval(heartbeat);
      sseWriters.delete(write);
    });
  });
};

export default derivSseRoutes;