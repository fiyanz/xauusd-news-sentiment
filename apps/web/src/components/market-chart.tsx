"use client";

import React, { useEffect, useRef, useState } from "react";
import {
  createChart,
  ColorType,
  CrosshairMode,
  ISeriesApi,
  IChartApi,
  Time,
  SeriesMarker,
  LineStyle,
} from "lightweight-charts";
import {
  Crosshair,
  TrendingUp,
  Spline,
  Paintbrush,
  Type,
  Smile,
  Ruler,
  ZoomIn,
  Magnet,
  Lock,
  Eye,
  Trash2,
  Layers,
} from "lucide-react";

interface CandleItem {
  time: Time;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  /** True when the API flagged this bar as H1-derived rather than a real print. */
  isEstimated?: boolean;
}

type ChartDataSource =
  | "deriv-cfd"
  | "csv-historical"
  | "simulated"
  | "real"
  | "estimated"
  | "unknown";

interface PredictionSnapshot {
  status: string;
  signal: string | null;
  confidence_pct: number | null;
  predicted_target_price: number | null;
  predicted_pips_delta: string | null;
  sentiment_label: string | null;
  bucket_time_utc: string | null;
  timestamp_utc: string | null;
}

function signalTone(signal: string | null): "bullish" | "bearish" | "neutral" {
  const value = (signal ?? "").toUpperCase();
  if (value.includes("BULL") || value.includes("BUY") || value.includes("NAIK")) return "bullish";
  if (value.includes("BEAR") || value.includes("SELL") || value.includes("TURUN")) return "bearish";
  return "neutral";
}

const SIGNAL_COLOR: Record<"bullish" | "bearish" | "neutral", string> = {
  bullish: "#2962FF",
  bearish: "#F23645",
  neutral: "#FFD000",
};

function sourceLabel(source: ChartDataSource): string {
  switch (source) {
    case "deriv-cfd":
      return "Deriv CFD";
    case "csv-historical":
      return "CSV historis";
    case "simulated":
      return "Simulasi";
    case "real":
      return "Data nyata";
    case "estimated":
      return "Estimasi H1";
    default:
      return "Sumber tidak diketahui";
  }
}

function sourceTitle(source: ChartDataSource): string {
  switch (source) {
    case "deriv-cfd":
      return "Candle dari Deriv (CFD Gold/USD), bukan spot interbank.";
    case "csv-historical":
      return "Berasal dari dataset historis CSV.";
    case "simulated":
      return "Data sintetis — bukan harga pasar nyata.";
    case "real":
      return "Berasal dari dataset pasar nyata.";
    case "estimated":
      return "Data intraday nyata belum tersedia. Bar diturunkan dari H1 dan bukan cetakan pasar nyata.";
    default:
      return "API tidak melaporkan asal data.";
  }
}

function sourceTone(source: ChartDataSource): "emerald" | "amber" | "red" | "neutral" {
  switch (source) {
    case "deriv-cfd":
    case "csv-historical":
    case "real":
      return "emerald";
    case "estimated":
      return "amber";
    case "simulated":
      return "red";
    default:
      return "neutral";
  }
}

export interface MarketChartProps {
  timeframe: string;
  onPriceUpdate?: (price: { open: number; high: number; low: number; close: number; change: number }) => void;
}

function getTimeframeSeconds(tf: string): number {
  switch (tf) {
    case "5m":
      return 300;
    case "15m":
      return 900;
    case "30m":
      return 1800;
    case "4h":
      return 14400;
    case "1D":
      return 86400;
    case "1h":
    default:
      return 3600;
  }
}

export function MarketChart({ timeframe, onPriceUpdate }: MarketChartProps) {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const targetLineRef = useRef<ISeriesApi<"Line"> | null>(null);

  const [isLoading, setIsLoading] = useState(true);
  const [activeTool, setActiveTool] = useState<string>("crosshair");
  const [isLocked, setIsLocked] = useState(false);
  const [isMagnet, setIsMagnet] = useState(false);
  const [showDrawings, setShowDrawings] = useState(true);
  // Provenance of the candles currently on screen. `estimated` means the bars
  // are H1-derived and must never be read as real intraday prints.
  const [dataSource, setDataSource] = useState<ChartDataSource>("unknown");
  const [prediction, setPrediction] = useState<PredictionSnapshot | null>(null);
  const predictionRef = useRef<PredictionSnapshot | null>(null);
  const lastPriceRef = useRef<number | null>(null);
  const timeframeRef = useRef(timeframe);

  // Restore toolbar preferences from localStorage
  useEffect(() => {
    try {
      const savedTool = localStorage.getItem("xau_chart_tool");
      if (savedTool) setActiveTool(savedTool);
      const savedLocked = localStorage.getItem("xau_chart_locked");
      if (savedLocked !== null) setIsLocked(savedLocked === "true");
      const savedMagnet = localStorage.getItem("xau_chart_magnet");
      if (savedMagnet !== null) setIsMagnet(savedMagnet === "true");
      const savedDrawings = localStorage.getItem("xau_chart_drawings");
      if (savedDrawings !== null) setShowDrawings(savedDrawings === "true");
    } catch {}
  }, []);

  const handleSelectTool = (tool: string) => {
    setActiveTool(tool);
    try {
      localStorage.setItem("xau_chart_tool", tool);
    } catch {}
  };

  const handleToggleMagnet = () => {
    setIsMagnet((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("xau_chart_magnet", String(next));
      } catch {}
      return next;
    });
  };

  const handleToggleLock = () => {
    setIsLocked((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("xau_chart_locked", String(next));
      } catch {}
      return next;
    });
  };

  const handleToggleDrawings = () => {
    setShowDrawings((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("xau_chart_drawings", String(next));
      } catch {}
      return next;
    });
  };

  const [hoveredCandle, setHoveredCandle] = useState<{
    open: number;
    high: number;
    low: number;
    close: number;
    change: number;
  } | null>(null);

  const onPriceUpdateRef = useRef(onPriceUpdate);
  onPriceUpdateRef.current = onPriceUpdate;

  const currentCandlesRef = useRef<CandleItem[]>([]);
  const isFetchingOlderRef = useRef(false);
  const hasMoreHistoryRef = useRef(true);
  const isReadyRef = useRef(false);
  const userHasInteractedRef = useRef(false);

  // Initialize Lightweight Charts canvas with institutional dark theme
  useEffect(() => {
    if (!chartContainerRef.current) return;

    const chart = createChart(chartContainerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: "#0E131A" },
        textColor: "#788292",
      },
      grid: {
        vertLines: { color: "#151B24" },
        horzLines: { color: "#151B24" },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: "rgba(120, 130, 146, 0.35)",
          width: 1,
          style: 3,
          labelBackgroundColor: "#1E2633",
        },
        horzLine: {
          color: "rgba(120, 130, 146, 0.35)",
          width: 1,
          style: 3,
          labelBackgroundColor: "#F23645",
        },
      },
      rightPriceScale: {
        borderColor: "#232B38",
        scaleMargins: {
          top: 0.1,
          bottom: 0.2,
        },
      },
      timeScale: {
        borderColor: "#232B38",
        timeVisible: true,
        secondsVisible: false,
        barSpacing: 12,
        minBarSpacing: 2,
        rightOffset: 15,
        lockVisibleTimeRangeOnResize: true,
      },
      handleScale: {
        mouseWheel: true,
        pinch: true,
        axisPressedMouseMove: true,
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: true,
      },
    });

    // Candlestick Theme: Royal Blue (#2962FF) Bullish, Crimson Red (#F23645) Bearish
    const candleSeries = chart.addCandlestickSeries({
      upColor: "#2962FF",
      downColor: "#F23645",
      borderVisible: true,
      borderUpColor: "#2962FF",
      borderDownColor: "#F23645",
      wickUpColor: "#2962FF",
      wickDownColor: "#F23645",
    });

    const volumeSeries = chart.addHistogramSeries({
      color: "#2962FF",
      priceFormat: {
        type: "volume",
      },
      priceScaleId: "",
    });

    volumeSeries.priceScale().applyOptions({
      scaleMargins: {
        top: 0.82,
        bottom: 0,
      },
    });

    // Garis target prediksi (horizontal); di-update saat prediksi/candle berubah.
    const targetLine = chart.addLineSeries({
      color: SIGNAL_COLOR.neutral,
      lineStyle: LineStyle.Dashed,
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    targetLineRef.current = targetLine;

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;

    // Crosshair listener to update OHLC live
    chart.subscribeCrosshairMove((param) => {
      if (
        param.point === undefined ||
        !param.time ||
        param.point.x < 0 ||
        param.point.y < 0
      ) {
        return;
      }

      const data = param.seriesData.get(candleSeries) as CandleItem | undefined;
      if (data && data.open !== undefined) {
        const change = Number((((data.close - data.open) / data.open) * 100).toFixed(2));
        const val = {
          open: data.open,
          high: data.high,
          low: data.low,
          close: data.close,
          change,
        };
        setHoveredCandle(val);
        onPriceUpdateRef.current?.(val);
      }
    });

    // User interaction tracking (capture phase so stopPropagation by chart canvas cannot block it)
    const onUserTouch = () => {
      userHasInteractedRef.current = true;
    };
    const chartContainerEl = chartContainerRef.current;
    if (chartContainerEl) {
      chartContainerEl.addEventListener("wheel", onUserTouch, { capture: true, passive: true });
      chartContainerEl.addEventListener("pointerdown", onUserTouch, { capture: true, passive: true });
      chartContainerEl.addEventListener("mousedown", onUserTouch, { capture: true, passive: true });
      chartContainerEl.addEventListener("touchstart", onUserTouch, { capture: true, passive: true });
    }
    window.addEventListener("wheel", onUserTouch, { capture: true, passive: true });
    window.addEventListener("pointerdown", onUserTouch, { capture: true, passive: true });
    window.addEventListener("mousedown", onUserTouch, { capture: true, passive: true });
    window.addEventListener("touchstart", onUserTouch, { capture: true, passive: true });

    // Dynamic historical scroll & user view persistence
    let saveRangeTimer: NodeJS.Timeout | null = null;
    chart.timeScale().subscribeVisibleLogicalRangeChange(async (newRange) => {
      if (!newRange) return;

      // Persist visible view to localStorage once user interacted or initial load finished
      if (userHasInteractedRef.current || isReadyRef.current) {
        if (saveRangeTimer) clearTimeout(saveRangeTimer);
        saveRangeTimer = setTimeout(() => {
          try {
            localStorage.setItem(
              `xau_chart_range_${timeframe}`,
              JSON.stringify({
                from: newRange.from,
                to: newRange.to,
              })
            );
          } catch {}
        }, 120);
      }

      if (isFetchingOlderRef.current || !hasMoreHistoryRef.current) return;

      // When user scrolls near left boundary (first 15 bars)
      if (newRange.from < 15 && currentCandlesRef.current.length > 0) {
        isFetchingOlderRef.current = true;
        const earliestTs = currentCandlesRef.current[0]!.time as number;

        try {
          let olderCandles: CandleItem[] = [];

          // 1. Candle dari apps/api (DB Deriv -> CSV historis).
          let res = await fetch(`/api/market/xauusd-candles?tf=${timeframe}&limit=200&to=${earliestTs}`, {
            cache: "no-store",
            signal: AbortSignal.timeout(5000),
          }).catch(() => null);

          // 2. Fallback candle-cache bila API internal mati.
          if (!res || !res.ok) {
            res = await fetch(`/api/market/candles?tf=${timeframe}&limit=200&to=${earliestTs}`, {
              cache: "no-store",
              signal: AbortSignal.timeout(5000),
            }).catch(() => null);
          }

          if (res && res.ok) {
            const json = await res.json();
            olderCandles = (json.data || []).map((c: any) => ({
              time: c.timestampUtc as Time,
              open: c.open,
              high: c.high,
              low: c.low,
              close: c.close,
              volume: c.volume,
            }));

            if (olderCandles.length === 0) {
              hasMoreHistoryRef.current = false;
            } else {
              const existingMap = new Set(currentCandlesRef.current.map((c) => c.time));
              const freshOlder = olderCandles.filter((c) => !existingMap.has(c.time));

              if (freshOlder.length > 0) {
                const merged = [...freshOlder, ...currentCandlesRef.current].sort(
                  (a, b) => (a.time as number) - (b.time as number)
                );
                currentCandlesRef.current = merged;
                candleSeries.setData(merged);

                const volumeData = merged.map((c) => ({
                  time: c.time,
                  value: c.volume ?? 100,
                  color: c.close >= c.open ? "rgba(41, 98, 255, 0.35)" : "rgba(242, 54, 69, 0.35)",
                }));
                volumeSeries.setData(volumeData);
              } else {
                hasMoreHistoryRef.current = false;
              }
            }
          }
        } catch {
          // Quiet network retry
        } finally {
          isFetchingOlderRef.current = false;
        }
      }
    });

    // ResizeObserver ensures instant responsive adjustment without jank
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.contentRect && chartRef.current) {
          chartRef.current.applyOptions({
            width: entry.contentRect.width,
            height: entry.contentRect.height,
          });
        }
      }
    });

    if (chartContainerRef.current) {
      resizeObserver.observe(chartContainerRef.current);
    }

    // Real-Time Server-Sent Events (SSE) for low-overhead live tick updates
    const INTERNAL_STREAM_URL = "/api/market/stream";
    const FALLBACK_STREAM_URL = "http://localhost:4000/api/v1/market/xauusd/stream";
    const MAX_RECONNECT_DELAY_MS = 30_000;
    const FALLBACK_PROBE_INTERVAL = 10;

    let eventSource: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempt = 0;
    let useFallback = false;
    let fallbackAttempts = 0;
    let isStreamDisposed = false;

    const handleTick = (event: MessageEvent) => {
      try {
        const tick = JSON.parse(event.data as string) as { price?: number; timestampUtc?: number };
        if (
          !Number.isFinite(tick.price) ||
          !candleSeriesRef.current ||
          currentCandlesRef.current.length === 0
        ) {
          return;
        }
        const price = tick.price as number;
        lastPriceRef.current = price;

        const tfSec = getTimeframeSeconds(timeframe);
        const tickTs = tick.timestampUtc || Math.floor(Date.now() / 1000);
        const currentBucketTime = Math.floor(tickTs / tfSec) * tfSec;
        const lastCandle = currentCandlesRef.current[currentCandlesRef.current.length - 1]!;
        const lastCandleTs = Number(lastCandle.time);

        let targetCandle: CandleItem;

        if (currentBucketTime > lastCandleTs) {
          // New candle bar started for the timeframe
          targetCandle = {
            time: currentBucketTime as Time,
            open: price,
            high: price,
            low: price,
            close: price,
            volume: 1,
          };
          currentCandlesRef.current.push(targetCandle);
        } else {
          // Update active forming candle
          targetCandle = {
            time: lastCandle.time,
            open: lastCandle.open,
            high: Math.max(lastCandle.high, price),
            low: Math.min(lastCandle.low, price),
            close: price,
            volume: (lastCandle.volume ?? 100) + 1,
          };
          lastCandle.high = targetCandle.high;
          lastCandle.low = targetCandle.low;
          lastCandle.close = targetCandle.close;
          lastCandle.volume = targetCandle.volume;
        }

        candleSeriesRef.current.update(targetCandle);
        applyTargetLine(predictionRef.current);
        volumeSeriesRef.current?.update({
          time: targetCandle.time,
          value: targetCandle.volume ?? 100,
          color: targetCandle.close >= targetCandle.open ? "rgba(41, 98, 255, 0.35)" : "rgba(242, 54, 69, 0.35)",
        });

        const change = Number((((targetCandle.close - targetCandle.open) / targetCandle.open) * 100).toFixed(2));
        const val = {
          open: targetCandle.open,
          high: targetCandle.high,
          low: targetCandle.low,
          close: targetCandle.close,
          change,
        };
        setHoveredCandle(val);
        onPriceUpdateRef.current?.(val);
      } catch {
        // Ignore malformed tick
      }
    };

    // Attach identical handlers to every connection attempt (internal + fallback).
    const attachHandlers = (connection: EventSource) => {
      connection.onmessage = handleTick;
      connection.onopen = () => {
        reconnectAttempt = 0;
      };
      connection.onerror = () => {
        // EventSource would auto-reconnect on its own; close it so we own the
        // backoff and can move to the fallback endpoint.
        connection.close();
        if (isStreamDisposed) return;
        scheduleReconnect();
      };
    };

    const scheduleReconnect = () => {
      if (isStreamDisposed) return;
      if (reconnectTimer) clearTimeout(reconnectTimer);

      // First failure -> switch to the fallback endpoint. Afterwards stay on the
      // fallback, probing the internal route every 10th attempt so a recovered
      // route is picked up again.
      if (!useFallback) {
        useFallback = true;
        fallbackAttempts = 0;
      } else {
        fallbackAttempts += 1;
        if (fallbackAttempts >= FALLBACK_PROBE_INTERVAL) {
          useFallback = false;
          fallbackAttempts = 0;
        }
      }

      reconnectAttempt += 1;
      const delay = Math.min(MAX_RECONNECT_DELAY_MS, 1000 * 2 ** Math.min(reconnectAttempt - 1, 5));

      reconnectTimer = setTimeout(() => {
        if (isStreamDisposed) return;
        try {
          eventSource = new EventSource(useFallback ? FALLBACK_STREAM_URL : INTERNAL_STREAM_URL);
          attachHandlers(eventSource);
        } catch {
          scheduleReconnect();
        }
      }, delay);
    };

    const connectSSE = () => {
      try {
        // Connect to internal route first
        eventSource = new EventSource(INTERNAL_STREAM_URL);
        attachHandlers(eventSource);
      } catch {
        // Silent fallback — scheduleReconnect retries the fallback endpoint.
        scheduleReconnect();
      }
    };

    connectSSE();

    return () => {
      if (chartContainerEl) {
        chartContainerEl.removeEventListener("wheel", onUserTouch);
        chartContainerEl.removeEventListener("pointerdown", onUserTouch);
        chartContainerEl.removeEventListener("mousedown", onUserTouch);
        chartContainerEl.removeEventListener("touchstart", onUserTouch);
      }
      window.removeEventListener("wheel", onUserTouch);
      window.removeEventListener("pointerdown", onUserTouch);
      window.removeEventListener("mousedown", onUserTouch);
      window.removeEventListener("touchstart", onUserTouch);
      if (saveRangeTimer) clearTimeout(saveRangeTimer);
      resizeObserver.disconnect();
      isStreamDisposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      eventSource?.close();
      chart.remove();
    };
  }, [timeframe]);

  // Fetch initial windowed candles when timeframe changes
  useEffect(() => {
    let isCancelled = false;
    isReadyRef.current = false;
    hasMoreHistoryRef.current = true;
    setIsLoading(true);
    timeframeRef.current = timeframe;

    const loadPrediction = async () => {
      try {
        let res = await fetch("/api/market/macro-sentiment", {
          cache: "no-store",
          signal: AbortSignal.timeout(5000),
        }).catch(() => null);

        if (!res || !res.ok) {
          res = await fetch("http://localhost:4000/api/v1/analytics/macro-sentiment/latest", {
            cache: "no-store",
            signal: AbortSignal.timeout(5000),
          }).catch(() => null);
        }

        if (res && res.ok) {
          const json = await res.json();
          const snapshot: PredictionSnapshot = {
            status: json.status ?? "unavailable",
            signal: json.signal ?? null,
            confidence_pct: json.confidence_pct ?? null,
            predicted_target_price: json.predicted_target_price ?? null,
            predicted_pips_delta: json.predicted_pips_delta ?? null,
            sentiment_label: json.sentiment_label ?? null,
            bucket_time_utc: json.bucket_time_utc ?? null,
            timestamp_utc: json.timestamp_utc ?? null,
          };
          predictionRef.current = snapshot;
          setPrediction(snapshot);
          applyTargetLine(snapshot);
        }
      } catch {
        // Prediksi opsional: chart tetap jalan tanpa garis target.
      }
    };

    async function loadInitialWindow() {
      try {
        let candles: CandleItem[] = [];
        setDataSource("unknown");

        // 1. Candle dari apps/api: DB (Deriv via worker) -> CSV historis.
        //    Provenance jujur: deriv-cfd / csv-historical / simulated.
        let res = await fetch(`/api/market/xauusd-candles?tf=${timeframe}&limit=250`, {
          cache: "no-store",
          signal: AbortSignal.timeout(5000),
        }).catch(() => null);
        let usedCandleCache = false;

        // 2. Fallback candle-cache (CSV/estimasi H1) bila API internal mati.
        if (!res || !res.ok) {
          usedCandleCache = true;
          res = await fetch(`/api/market/candles?tf=${timeframe}&limit=250`, {
            cache: "no-store",
            signal: AbortSignal.timeout(5000),
          }).catch(() => null);
        }

        if (res && res.ok) {
          const json = await res.json();
          candles = (json.data || []).map((c: any) => ({
            time: c.timestampUtc as Time,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            volume: c.volume,
            isEstimated: c.isEstimated === true ? true : undefined,
          }));

          // Provenance resolution, most authoritative first:
          //   1. `source` reported by the API (candle-cache CandleSeriesResult).
          //   2. the per-bar `isEstimated` flag — candle-cache's subdivideCandles
          //      flags every H1-derived bar, so "any flagged bar" == estimate.
          //   3. legacy top-level `isSimulated` -> simulated.
          //   4. unflagged bars from this dataset are genuine prints -> real.
          let reportedSource = json.source as ChartDataSource;
          // candle-cache hanya berisi CSV historis (atau estimasi H1 darinya);
          // label "real"-nya dipetakan ke "csv-historical" supaya jujur.
          if (usedCandleCache && reportedSource === "real") {
            reportedSource = "csv-historical";
          }
          if (
            reportedSource === "deriv-cfd" ||
            reportedSource === "csv-historical" ||
            reportedSource === "simulated" ||
            reportedSource === "real" ||
            reportedSource === "estimated" ||
            reportedSource === "unknown"
          ) {
            setDataSource(reportedSource);
          } else if (candles.length > 0 && candles.some((c) => c.isEstimated === true)) {
            setDataSource("estimated");
          } else if (json.isSimulated === true) {
            setDataSource("simulated");
          } else if (candles.length > 0) {
            setDataSource("real");
          }
        }

        if (isCancelled || !candleSeriesRef.current || !volumeSeriesRef.current) return;

        if (candles.length > 0) {
          currentCandlesRef.current = candles;
          candleSeriesRef.current.setData(candles);

          const volumeData = candles.map((c) => ({
            time: c.time,
            value: c.volume ?? 100,
            color: c.close >= c.open ? "rgba(41, 98, 255, 0.35)" : "rgba(242, 54, 69, 0.35)",
          }));
          volumeSeriesRef.current.setData(volumeData);

          // Place economic news event markers (e.g. CPI, NFP, FOMC)
          try {
            let calRes = await fetch("/api/market/calendar").catch(() => null);
            if (!calRes || !calRes.ok) {
              calRes = await fetch("http://localhost:4000/api/v1/calendar/upcoming").catch(() => null);
            }

            if (calRes && calRes.ok) {
              const calJson = await calRes.json();
              const markers: SeriesMarker<Time>[] = [];

              if (calJson.events && calJson.events.length > 0 && candles.length > 0) {
                const minTime = candles[0]!.time as number;
                const maxTime = candles[candles.length - 1]!.time as number;

                for (const ev of calJson.events) {
                  const evTime = ev.dateUtc;
                  if (evTime >= minTime && evTime <= maxTime) {
                    const nearest = candles.reduce((prev, curr) =>
                      Math.abs((curr.time as number) - evTime) < Math.abs((prev.time as number) - evTime) ? curr : prev
                    );
                    markers.push({
                      time: nearest.time,
                      position: "belowBar",
                      color: ev.eventCode === "CPI" ? "#F23645" : "#FFD000",
                      shape: "circle",
                      text: `III ${ev.eventCode}`,
                    });
                  }
                }
              }

              if (markers.length > 0) {
                candleSeriesRef.current.setMarkers(markers);
              }
            }
          } catch {
            // Quiet calendar marker failure
          }

          const latest = candles[candles.length - 1];
          if (latest) {
            const change = Number((((latest.close - latest.open) / latest.open) * 100).toFixed(2));
            const val = {
              open: latest.open,
              high: latest.high,
              low: latest.low,
              close: latest.close,
              change,
            };
            setHoveredCandle(val);
            onPriceUpdateRef.current?.(val);
          }

          // Restore user's customized chart zoom and position if saved
          let restored = false;
          try {
            const savedRangeStr = localStorage.getItem(`xau_chart_range_${timeframe}`);
            if (savedRangeStr) {
              const saved = JSON.parse(savedRangeStr);
              if (
                typeof saved.from === "number" &&
                typeof saved.to === "number" &&
                saved.to > saved.from
              ) {
                requestAnimationFrame(() => {
                  chartRef.current?.timeScale().setVisibleLogicalRange({
                    from: saved.from,
                    to: saved.to,
                  });
                });
                restored = true;
              }
            }
          } catch {}

          if (!restored) {
            // Institutional comfortable default: nice readable candles, 15 bars margin on right
            chartRef.current?.timeScale().applyOptions({
              barSpacing: 12,
              rightOffset: 15,
            });
            chartRef.current?.timeScale().scrollToRealTime();
          }
        }

        lastPriceRef.current = candles[candles.length - 1]?.close ?? lastPriceRef.current;
        loadPrediction();
      } catch {
        // Handle error gracefully
      } finally {
        if (!isCancelled) {
          setIsLoading(false);
          setTimeout(() => {
            if (!isCancelled) {
              isReadyRef.current = true;
            }
          }, 350);
        }
      }
    }

    loadInitialWindow();

    return () => {
      isCancelled = true;
      isReadyRef.current = false;
      userHasInteractedRef.current = false;
    };
  }, [timeframe]);

  // Garis target prediksi: horizontal di harga target, membentang di atas
  // rentang candle yang tampil. Warna mengikuti sinyal.
  const applyTargetLine = (pred: PredictionSnapshot | null) => {
    const series = targetLineRef.current;
    if (!series) return;

    const price = pred?.predicted_target_price;
    const bars = currentCandlesRef.current;
    if (!price || !Number.isFinite(price) || bars.length === 0) {
      series.setData([]);
      return;
    }

    const from = bars[0]!.time as number;
    const to =
      (bars[bars.length - 1]!.time as number) + getTimeframeSeconds(timeframeRef.current);
    series.applyOptions({ color: SIGNAL_COLOR[signalTone(pred?.signal ?? null)] });
    series.setData([
      { time: from as Time, value: price },
      { time: to as Time, value: price },
    ]);
  };

  // Provenance badge: always shown for intraday timeframes (where "real" vs
  // "H1 estimate" matters), otherwise only when the API reports a source.
  const showSourceBadge =
    dataSource !== "unknown" || timeframe === "5m" || timeframe === "15m" || timeframe === "1m";

  const sourceBadgeClasses: Record<string, string> = {
    emerald: "border-emerald-500/40 text-emerald-400",
    amber: "border-amber-500/40 text-amber-400",
    red: "border-red-500/40 text-red-400",
    neutral: "border-[#2A3441] text-[#788292]",
  };
  const sourceDotClasses: Record<string, string> = {
    emerald: "bg-emerald-400",
    amber: "bg-amber-400",
    red: "bg-red-400",
    neutral: "bg-[#788292]",
  };

  const predToneValue = signalTone(prediction?.signal ?? null);
  const predBadgeClasses: Record<string, string> = {
    bullish: "border-[#2962FF]/50 text-[#8FB0FF]",
    bearish: "border-[#F23645]/50 text-[#FF8A93]",
    neutral: "border-[#FFD000]/40 text-[#FFD000]",
  };
  const targetPrice = prediction?.predicted_target_price ?? null;
  const predictionOk = prediction?.status === "ok" || prediction?.status === "success";
  const livePrice = hoveredCandle?.close ?? null;
  const targetDelta =
    targetPrice !== null && livePrice !== null ? targetPrice - livePrice : null;

  return (
    <div className="relative w-full h-full flex bg-[#0E131A] overflow-hidden select-none">
      {/* 1. Authentic Vertical Drawing Toolbar (Lucide SVG Vector Icons) */}
      <aside className="w-10 border-r border-[#1E2633] bg-[#141A22] flex flex-col items-center py-2 space-y-1 z-20 shrink-0 select-none">
        {/* Drawing & Cursor Tools */}
        <button
          type="button"
          onClick={() => handleSelectTool("crosshair")}
          title="Crosshair (Pointer)"
          className={`p-1.5 rounded transition-colors ${
            activeTool === "crosshair"
              ? "text-[#E0E3EB] bg-[#1E2633]"
              : "text-[#788292] hover:text-[#E0E3EB] hover:bg-[#1E2633]"
          }`}
        >
          <Crosshair className="w-4 h-4" />
        </button>

        <button
          type="button"
          onClick={() => handleSelectTool("trendline")}
          title="Trend Line"
          className={`p-1.5 rounded transition-colors ${
            activeTool === "trendline"
              ? "text-[#E0E3EB] bg-[#1E2633]"
              : "text-[#788292] hover:text-[#E0E3EB] hover:bg-[#1E2633]"
          }`}
        >
          <TrendingUp className="w-4 h-4" />
        </button>

        <button
          type="button"
          onClick={() => handleSelectTool("spline")}
          title="Spline & Fibonacci"
          className={`p-1.5 rounded transition-colors ${
            activeTool === "spline"
              ? "text-[#E0E3EB] bg-[#1E2633]"
              : "text-[#788292] hover:text-[#E0E3EB] hover:bg-[#1E2633]"
          }`}
        >
          <Spline className="w-4 h-4" />
        </button>

        <button
          type="button"
          onClick={() => handleSelectTool("brush")}
          title="Paintbrush & Highlighter"
          className={`p-1.5 rounded transition-colors ${
            activeTool === "brush"
              ? "text-[#E0E3EB] bg-[#1E2633]"
              : "text-[#788292] hover:text-[#E0E3EB] hover:bg-[#1E2633]"
          }`}
        >
          <Paintbrush className="w-4 h-4" />
        </button>

        <button
          type="button"
          onClick={() => handleSelectTool("text")}
          title="Text Annotation"
          className={`p-1.5 rounded transition-colors ${
            activeTool === "text"
              ? "text-[#E0E3EB] bg-[#1E2633]"
              : "text-[#788292] hover:text-[#E0E3EB] hover:bg-[#1E2633]"
          }`}
        >
          <Type className="w-4 h-4" />
        </button>

        <button
          type="button"
          onClick={() => handleSelectTool("smile")}
          title="Markers & Stickers"
          className={`p-1.5 rounded transition-colors ${
            activeTool === "smile"
              ? "text-[#E0E3EB] bg-[#1E2633]"
              : "text-[#788292] hover:text-[#E0E3EB] hover:bg-[#1E2633]"
          }`}
        >
          <Smile className="w-4 h-4" />
        </button>

        <button
          type="button"
          onClick={() => handleSelectTool("ruler")}
          title="Price & Time Measure"
          className={`p-1.5 rounded transition-colors ${
            activeTool === "ruler"
              ? "text-[#E0E3EB] bg-[#1E2633]"
              : "text-[#788292] hover:text-[#E0E3EB] hover:bg-[#1E2633]"
          }`}
        >
          <Ruler className="w-4 h-4" />
        </button>

        <div className="w-5 h-[1px] bg-[#1E2633] my-1"></div>

        {/* Utilities & Management */}
        <button
          type="button"
          onClick={() => chartRef.current?.timeScale().fitContent()}
          title="Zoom Fit Content"
          className="p-1.5 rounded text-[#788292] hover:text-[#E0E3EB] hover:bg-[#1E2633] transition-colors"
        >
          <ZoomIn className="w-4 h-4" />
        </button>

        <button
          type="button"
          onClick={handleToggleMagnet}
          title={isMagnet ? "Magnet Mode: ON" : "Magnet Mode: OFF"}
          className={`p-1.5 rounded transition-colors ${
            isMagnet ? "text-[#2962FF] bg-[#1E2633]" : "text-[#788292] hover:text-[#E0E3EB] hover:bg-[#1E2633]"
          }`}
        >
          <Magnet className="w-4 h-4" />
        </button>

        <button
          type="button"
          onClick={handleToggleLock}
          title={isLocked ? "Drawings: Locked" : "Lock All Drawings"}
          className={`p-1.5 rounded transition-colors ${
            isLocked ? "text-ex-yellow bg-[#1E2633]" : "text-[#788292] hover:text-[#E0E3EB] hover:bg-[#1E2633]"
          }`}
        >
          <Lock className="w-4 h-4" />
        </button>

        <button
          type="button"
          onClick={handleToggleDrawings}
          title={showDrawings ? "Drawings: Visible" : "Drawings: Hidden"}
          className={`p-1.5 rounded transition-colors ${
            !showDrawings ? "text-ex-red bg-[#1E2633]" : "text-[#788292] hover:text-[#E0E3EB] hover:bg-[#1E2633]"
          }`}
        >
          <Eye className="w-4 h-4" />
        </button>

        <button
          type="button"
          onClick={() => handleSelectTool("crosshair")}
          title="Clear Chart Objects"
          className="p-1.5 rounded text-[#788292] hover:text-ex-red hover:bg-[#1E2633] transition-colors"
        >
          <Trash2 className="w-4 h-4" />
        </button>

        <button
          type="button"
          title="Indicators & Layers"
          className="p-1.5 rounded text-[#788292] hover:text-[#E0E3EB] hover:bg-[#1E2633] transition-colors"
        >
          <Layers className="w-4 h-4" />
        </button>
      </aside>

      {/* 2. Chart Canvas Area */}
      <div className="relative flex-1 h-full min-w-0 flex flex-col">
        {/* Terminal Chart Header Overlay: Gold vs US Dollar · Timeframe · O H L C */}
        <div className="absolute top-2.5 left-4 z-10 flex items-center space-x-3 text-[11px] font-mono text-ex-muted pointer-events-none select-none">
          <div className="flex items-center space-x-1.5 font-sans text-ex-text font-bold">
            <span className="w-2.5 h-2.5 rounded-full bg-ex-yellow inline-block"></span>
            <span>Gold vs US Dollar</span>
            <span className="text-ex-muted font-normal">· {timeframe.toUpperCase()} ·</span>
          </div>
          {showSourceBadge && (
            <span
              title={sourceTitle(dataSource)}
              className={`pointer-events-auto flex items-center space-x-1 px-1.5 py-0.5 rounded border font-mono text-[10px] ${sourceBadgeClasses[sourceTone(dataSource)]}`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${sourceDotClasses[sourceTone(dataSource)]}`}
              />
              <span>{sourceLabel(dataSource)}</span>
            </span>
          )}
          {predictionOk && targetPrice !== null ? (
            <span
              title={`Prediksi 4H bucket ${prediction.bucket_time_utc ?? "-"}. Harga chart: Deriv CFD, bukan spot interbank.`}
              className={`pointer-events-auto flex items-center space-x-1 px-1.5 py-0.5 rounded border font-mono text-[10px] ${predBadgeClasses[predToneValue]}`}
            >
              <span>Prediksi {prediction.signal ?? "-"}</span>
              <span>· target {targetPrice.toFixed(2)}</span>
              {targetDelta !== null && Number.isFinite(targetDelta) ? (
                <span>
                  · {targetDelta >= 0 ? "+" : ""}
                  {targetDelta.toFixed(2)}
                </span>
              ) : null}
              {prediction.confidence_pct !== null ? (
                <span>· {prediction.confidence_pct}%</span>
              ) : null}
            </span>
          ) : null}
          {hoveredCandle ? (
            <div className="flex items-center space-x-2.5">
              <span>
                O <span className="text-ex-text font-semibold">{hoveredCandle.open.toFixed(3)}</span>
              </span>
              <span>
                H <span className="text-ex-text font-semibold">{hoveredCandle.high.toFixed(3)}</span>
              </span>
              <span>
                L <span className="text-ex-text font-semibold">{hoveredCandle.low.toFixed(3)}</span>
              </span>
              <span>
                C{" "}
                <span
                  className={
                    hoveredCandle.close >= hoveredCandle.open
                      ? "text-ex-blue font-semibold"
                      : "text-ex-red font-semibold"
                  }
                >
                  {hoveredCandle.close.toFixed(3)}
                </span>
              </span>
              <span
                className={
                  hoveredCandle.change >= 0 ? "text-ex-blue font-semibold" : "text-ex-red font-semibold"
                }
              >
                {hoveredCandle.change >= 0 ? `+${hoveredCandle.change}%` : `${hoveredCandle.change}%`}
              </span>
            </div>
          ) : null}
        </div>

        {/* Loading state indicator */}
        {isLoading && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-[#0E131A]/80 text-ex-muted text-xs font-mono">
            <span>Memuat data XAUUSD...</span>
            <span className="text-[10px] opacity-70">
              {timeframe === "5m" || timeframe === "15m" || timeframe === "1m"
                ? "Menyiapkan data intraday (data nyata atau estimasi H1)"
                : "Menyiapkan data XAUUSD"}
            </span>
          </div>
        )}

        {/* Canvas DOM container */}
        <div ref={chartContainerRef} className="w-full flex-1 min-h-[350px]" />
      </div>
    </div>
  );
}

export default MarketChart;
