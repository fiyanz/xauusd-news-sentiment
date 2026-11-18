export const dynamic = "force-dynamic";

/**
 * Proxy SSE: browser -> route ini -> apps/api (/api/v1/market/xauusd/stream)
 * -> Deriv WebSocket. Tick asli Deriv (frxXAUUSD), bukan simulasi.
 * Kalau API mati, route mengirim satu event `status:"unavailable"` lalu tutup.
 */
const API_BASE =
  process.env.API_INTERNAL_URL ?? `http://localhost:${process.env.PORT_API ?? "4000"}`;

export async function GET(request: Request) {
  const headers = {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  };

  let upstream: Response;
  try {
    upstream = await fetch(`${API_BASE}/api/v1/market/xauusd/stream`, {
      headers: { Accept: "text/event-stream" },
      signal: request.signal,
      cache: "no-store",
    });
  } catch {
    const body = JSON.stringify({
      status: "unavailable",
      reason: `API di ${API_BASE} tidak terjangkau.`,
    });
    return new Response(`data: ${body}\n\n`, { status: 200, headers });
  }

  if (!upstream.ok || !upstream.body) {
    const body = JSON.stringify({
      status: "unavailable",
      reason: `API merespons HTTP ${upstream.status}.`,
    });
    return new Response(`data: ${body}\n\n`, { status: 200, headers });
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstream.body!.getReader();
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      let buffer = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? "";
          for (const part of parts) {
            controller.enqueue(encoder.encode(`${part}\n\n`));
          }
        }
        if (buffer) controller.enqueue(encoder.encode(buffer));
      } catch {
        // Koneksi upstream putus; stream ditutup di finally.
      } finally {
        try {
          controller.close();
        } catch {
          // Controller sudah tertutup.
        }
      }
    },
    cancel() {
      // request.signal membatalkan fetch upstream secara otomatis.
    },
  });

  return new Response(stream, { status: 200, headers });
}
