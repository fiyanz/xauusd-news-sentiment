import { getLastCachedPrice, loadH1Data } from "@/lib/candle-cache";

export const dynamic = "force-dynamic";

/**
 * Tick real-time merupakan SIMULASI mikro di sekitar harga nyata terakhir
 * (snapshot close candle H1 terakhir). Setiap tick ditandai `isSimulated: true`
 * dan tidak boleh dianggap sebagai harga pasar.
 */
export async function GET(request: Request) {
  let timer: NodeJS.Timeout | null = null;
  let isClosed = false;

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const h1 = loadH1Data();
      const lastRealPrice = h1.length > 0 ? h1[h1.length - 1]!.close : null;

      if (lastRealPrice === null || !Number.isFinite(lastRealPrice)) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              status: "unavailable",
              reason: "Belum ada data harga nyata.",
            })}\n\n`
          )
        );
        try {
          controller.close();
        } catch {}
        return;
      }

      let curPrice = getLastCachedPrice() ?? lastRealPrice;

      // Emit initial tick immediately
      const initialPayload = JSON.stringify({
        timestampUtc: Math.floor(Date.now() / 1000),
        price: curPrice,
        bid: Number((curPrice - 0.12).toFixed(2)),
        ask: Number((curPrice + 0.12).toFixed(2)),
        volume: Math.floor(Math.random() * 20) + 5,
        isSimulated: true,
      });

      controller.enqueue(encoder.encode(`data: ${initialPayload}\n\n`));

      timer = setInterval(() => {
        if (isClosed) return;
        try {
          // Micro-tick random walk with mean reversion to base
          const delta = (Math.random() - 0.49) * 0.4;
          curPrice = Number((curPrice + delta).toFixed(2));
          const nowSec = Math.floor(Date.now() / 1000);

          const payload = JSON.stringify({
            timestampUtc: nowSec,
            price: curPrice,
            bid: Number((curPrice - 0.12).toFixed(2)),
            ask: Number((curPrice + 0.12).toFixed(2)),
            volume: Math.floor(Math.random() * 25) + 5,
            isSimulated: true,
          });

          controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
        } catch {
          isClosed = true;
          if (timer) clearInterval(timer);
          try {
            controller.close();
          } catch {}
        }
      }, 1000);

      // Abort signal handling
      request.signal.addEventListener("abort", () => {
        isClosed = true;
        if (timer) clearInterval(timer);
        try {
          controller.close();
        } catch {}
      });
    },
    cancel() {
      isClosed = true;
      if (timer) clearInterval(timer);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
