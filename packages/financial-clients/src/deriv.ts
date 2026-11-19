/**
 * Klien Deriv (CFD Gold/USD) — WebSocket publik, tanpa dependency eksternal.
 *
 * Dipakai dua hal:
 *  - tick live (`subscribeTicks`)  -> SSE di apps/api -> chart
 *  - candle historis (`fetchCandles`) -> apps/worker -> price_candles
 *
 * Sumber: Deriv, bukan spot interbank. Jam trading Gold Deriv kira-kira
 * Minggu 22:10 s.d. Jumat 21:55 UTC (ada daily break) — jangan asumsikan 24/7.
 *
 * Market data Deriv publik tidak butuh API token. `DERIV_API_TOKEN` (bila ada)
 * sengaja tidak dipakai di sini supaya tidak ada authorize yang tidak perlu.
 */

export interface DerivTick {
  symbol: string;
  price: number;
  epoch: number;
}

export interface DerivCandle {
  epoch: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface DerivClientOptions {
  appId: string;
  /** Opsional; market data publik tidak membutuhkannya. */
  token?: string;
  url?: string;
  symbol?: string;
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type DerivTickMessage = {
  tick?: { symbol?: string; quote?: number; epoch?: number };
};

type DerivHistoryMessage = {
  /** Endpoint publik v3 menaruh candles di root. */
  candles?: Array<{ epoch?: number; open?: number; high?: number; low?: number; close?: number }>;
  /** Bentuk legacy: history.candles. */
  history?: {
    candles?: Array<{ epoch?: number; open?: number; high?: number; low?: number; close?: number }>;
  };
};

const DEFAULT_URL = "wss://api.derivws.com/trading/v1/options/ws/public";
const REQUEST_TIMEOUT_MS = 15_000;

export class DerivClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private tickHandlers = new Set<(tick: DerivTick) => void>();
  private subscribedSymbol: string | null = null;
  private closedByUser = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs = 1_000;
  /** Dipanggil saat koneksi hilang (bukan saat close() manual). */
  onDisconnect: (() => void) | null = null;

  readonly url: string;
  readonly symbol: string;
  private readonly token?: string;

  constructor(options: DerivClientOptions) {
    if (!options.appId) throw new Error("DerivClient butuh appId");
    this.url = options.url ?? `${DEFAULT_URL}?app_id=${encodeURIComponent(options.appId)}`;
    this.symbol = options.symbol ?? "frxXAUUSD";
    this.token = options.token;
  }

  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.reconnectDelayMs = 1_000;
      if (this.subscribedSymbol) this.subscribe(this.subscribedSymbol);
    });

    ws.addEventListener("message", (event: MessageEvent) => {
      this.handleMessage(typeof event.data === "string" ? event.data : "");
    });

    ws.addEventListener("close", () => {
      this.ws = null;
      this.failAllPending(new Error("Deriv WebSocket tertutup"));
      if (!this.closedByUser) {
        this.onDisconnect?.();
        this.scheduleReconnect();
      }
    });

    ws.addEventListener("error", () => {
      // "close" selalu menyusul; reconnect di sana.
    });
  }

  subscribe(symbol: string): void {
    this.subscribedSymbol = symbol;
    this.send({ ticks: symbol, subscribe: 1 });
  }

  onTick(handler: (tick: DerivTick) => void): () => void {
    this.tickHandlers.add(handler);
    return () => this.tickHandlers.delete(handler);
  }

  /** Tunggu koneksi siap; dipakai sebelum request supaya tidak ditolak. */
  async ready(timeoutMs = 15_000): Promise<void> {
    this.connect();
    const ws = this.ws;
    if (!ws) throw new Error("Deriv WebSocket gagal dibuat");
    if (ws.readyState === WebSocket.OPEN) return;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Deriv WebSocket timeout"));
      }, timeoutMs);
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onClose = () => {
        cleanup();
        reject(new Error("Deriv WebSocket tertutup"));
      };
      const cleanup = () => {
        clearTimeout(timer);
        ws.removeEventListener("open", onOpen);
        ws.removeEventListener("close", onClose);
      };
      ws.addEventListener("open", onOpen);
      ws.addEventListener("close", onClose);
    });
  }

  async fetchCandles(symbol: string, granularitySec: number, count: number, end: number | "latest" = "latest"): Promise<DerivCandle[]> {
    await this.ready();
    const response = (await this.request({
      ticks_history: symbol,
      adjust_start_time: 1,
      count,
      end,
      style: "candles",
      granularity: granularitySec,
    })) as DerivHistoryMessage;

    const candles = response.candles ?? response.history?.candles;
    if (!Array.isArray(candles)) throw new Error("Deriv tidak mengembalikan candles");

    return candles.flatMap((row) => {
      if (
        row.epoch === undefined ||
        row.open === undefined ||
        row.high === undefined ||
        row.low === undefined ||
        row.close === undefined
      ) {
        return [];
      }
      return [
        {
          epoch: row.epoch,
          open: row.open,
          high: row.high,
          low: row.low,
          close: row.close,
        },
      ];
    });
  }

  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.failAllPending(new Error("DerivClient ditutup"));
    this.ws?.close();
    this.ws = null;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.closedByUser) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30_000);
      this.connect();
    }, this.reconnectDelayMs);
  }

  private handleMessage(raw: string): void {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    const reqId = typeof payload.req_id === "number" ? payload.req_id : null;
    if (reqId !== null) {
      const pending = this.pending.get(reqId);
      if (!pending) return;
      this.pending.delete(reqId);
      clearTimeout(pending.timer);
      if (payload.error) {
        const error = payload.error as { message?: string };
        pending.reject(new Error(error.message ?? "Deriv error"));
      } else {
        pending.resolve(payload);
      }
      return;
    }

    const msgType = payload.msg_type;
    if (msgType === "tick") {
      const tick = (payload as unknown as DerivTickMessage).tick;
      if (!tick || typeof tick.quote !== "number") return;
      const parsed: DerivTick = {
        symbol: tick.symbol ?? this.symbol,
        price: tick.quote,
        epoch: typeof tick.epoch === "number" ? tick.epoch : Math.floor(Date.now() / 1000),
      };
      for (const handler of this.tickHandlers) handler(parsed);
    }
  }

  private request(payload: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Deriv request ${id} timeout`));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer });
      this.send({ ...payload, req_id: id });
    });
  }

  private send(payload: Record<string, unknown>): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      // Jangan buang request saat koneksi belum siap: park di pending supaya
      // reconnect tetap bisa memakainya? Sederhana: tolak agar pemanggil tahu.
      if (payload.req_id !== undefined) {
        const pending = this.pending.get(payload.req_id as number);
        if (pending) {
          this.pending.delete(payload.req_id as number);
          clearTimeout(pending.timer);
          pending.reject(new Error("Deriv WebSocket belum terhubung"));
        }
      }
      return;
    }
    ws.send(JSON.stringify(payload));
  }

  private failAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
