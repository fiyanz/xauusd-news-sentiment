"use client";

import React, { useState, useEffect } from "react";
import dynamic from "next/dynamic";
import {
  Clock,
  Copy,
  Check,
  ChevronDown,
  ShieldAlert,
  Download,
  FileSpreadsheet,
  FileText,
} from "lucide-react";

// Dynamically import chart canvas with SSR disabled
const MarketChart = dynamic(
  () => import("../components/market-chart").then((mod) => mod.MarketChart),
  {
    ssr: false,
    loading: () => (
      <div className="flex-1 flex items-center justify-center text-ex-muted font-mono text-xs bg-[#0E131A]">
        Loading Market Canvas Engine...
      </div>
    ),
  }
);

export default function MarketTradingTerminal() {
  const [mounted, setMounted] = useState(false);
  const [activeBottomTab, setActiveBottomTab] = useState<"ai-intel" | "event-study" | "calendar" | "daily-digest">("ai-intel");
  const [activeTf, setActiveTf] = useState("1h");
  const [copied, setCopied] = useState(false);
  const [currentTimeUtc, setCurrentTimeUtc] = useState("");

  // Live API States
  const [livePrice, setLivePrice] = useState<{
    bid: number;
    ask: number;
    isSimulated: boolean;
  } | null>(null);
  const [calendarEvents, setCalendarEvents] = useState<any[]>([]);
  const [selectedEventCode, setSelectedEventCode] = useState<"cpi" | "nfp" | "fomc" | "pce">("cpi");
  const [eventStudyData, setEventStudyData] = useState<any>(null);
  const [dailyDigestContent, setDailyDigestContent] = useState<string>("");
  const [cotData, setCotData] = useState<any>(null);
  const [macroPrediction, setMacroPrediction] = useState<any>(null);
  const [significance, setSignificance] = useState<any>(null);

  // File download helper
  const handleDownloadFile = (filename: string, content: string, mimeType: string) => {
    try {
      const blob = new Blob([content], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {}
  };

  const handleDownloadEventStudyCsv = () => {
    if (!eventStudyData || !eventStudyData.historicalLogs) return;
    const headers = "Date,Event,Actual,Forecast,Surprise,ReactionPips,Direction\n";
    const rows = eventStudyData.historicalLogs
      .map(
        (log: any) =>
          `"${log.date}","${eventStudyData.eventName ?? eventStudyData.eventCode}","${
            log.actual ?? ""
          }","${log.forecast ?? ""}","${log.surprise ?? ""}","${
            log.pips ?? ""
          }","${log.direction ?? ""}"`
      )
      .join("\n");
    handleDownloadFile(
      `event_study_${selectedEventCode}_reactions.csv`,
      headers + rows,
      "text/csv;charset=utf-8;"
    );
  };

  const handleDownloadDigestMd = () => {
    handleDownloadFile(
      `daily_market_digest_${new Date().toISOString().slice(0, 10)}.md`,
      dailyDigestContent || "# Ringkasan Harian Pasar Emas\n",
      "text/markdown;charset=utf-8;"
    );
  };

  const handleDownloadCotCsv = () => {
    if (!cotData) return;
    const content = `ReportDate,NonCommercialLong,NonCommercialShort,NetPosition,WeeklyChange\n${cotData.reportDate},${cotData.nonCommercialLong},${cotData.nonCommercialShort},${cotData.netPosition},${cotData.changeNet}\n`;
    handleDownloadFile("cftc_cot_gold_report.csv", content, "text/csv;charset=utf-8;");
  };

  useEffect(() => {
    setMounted(true);

    // Restore user UI preferences from localStorage
    try {
      const savedTf = localStorage.getItem("xau_terminal_tf");
      if (savedTf) setActiveTf(savedTf);
      const savedTab = localStorage.getItem("xau_terminal_bottom_tab");
      if (savedTab) setActiveBottomTab(savedTab as any);
    } catch {}

    // Live clock ticker
    const clockInterval = setInterval(() => {
      const now = new Date();
      const timeStr = now.toISOString().split("T")[1]?.split(".")[0] || "08:35:56";
      setCurrentTimeUtc(`${timeStr} UTC`);
    }, 1000);

    // Live SSE ticker for instant real-time header price updates
    let sse: EventSource | null = null;
    try {
      sse = new EventSource("/api/market/stream");
      sse.onmessage = (event) => {
        try {
          const tick = JSON.parse(event.data);
          if (tick.status === "unavailable") return;
          if (tick.bid && tick.ask) {
            setLivePrice({
              bid: tick.bid,
              ask: tick.ask,
              isSimulated: tick.isSimulated === true,
            });
          }
        } catch {}
      };
    } catch {}

    // Fetch initial API data
    async function fetchApiData() {
      try {
        // 1. Ticker price fallback (API analitik, timeout 2 detik)
        const priceRes = await fetch("http://localhost:4000/api/v1/market/xauusd/latest", {
          signal: AbortSignal.timeout(2000),
        }).catch(() => null);
        if (priceRes && priceRes.ok) {
          const p = await priceRes.json();
          // Bid/ask hanya dipakai bila sumber menyediakannya; API mengembalikan
          // null (spread nyata tidak tersedia) — jangan mengarang pengganti.
          if (p.bid !== null && p.bid !== undefined && p.ask !== null && p.ask !== undefined) {
            setLivePrice({ bid: p.bid, ask: p.ask, isSimulated: p.isSimulated === true });
          }
        }

        // 2. Upcoming Economic Calendar (internal route with external fallback)
        let calRes = await fetch("/api/market/calendar").catch(() => null);
        if (!calRes || !calRes.ok) {
          calRes = await fetch("http://localhost:4000/api/v1/calendar/upcoming", {
            signal: AbortSignal.timeout(2000),
          }).catch(() => null);
        }
        if (calRes && calRes.ok) {
          const c = await calRes.json();
          setCalendarEvents(c.events || []);
        }

        // 3. Event study analysis
        const studyRes = await fetch("http://localhost:4000/api/v1/analytics/event-study/cpi", {
          signal: AbortSignal.timeout(2000),
        }).catch(() => null);
        if (studyRes && studyRes.ok) {
          const s = await studyRes.json();
          setEventStudyData(s.status === "unavailable" ? null : s);
        }

        // 4. Daily digest
        const digestRes = await fetch("http://localhost:4000/api/v1/reports/daily/latest", {
          signal: AbortSignal.timeout(2000),
        }).catch(() => null);
        if (digestRes && digestRes.ok) {
          const d = await digestRes.json();
          setDailyDigestContent(d.markdownContent || "");
        }

        // 5. COT report
        const cotRes = await fetch("http://localhost:4000/api/v1/reports/cot/latest", {
          signal: AbortSignal.timeout(2000),
        }).catch(() => null);
        if (cotRes && cotRes.ok) {
          const cot = await cotRes.json();
          setCotData(cot.status === "ok" && cot.report ? cot.report : null);
        }

        // 6. AI Macro-Sentiment Prediction
        let macroRes = await fetch("/api/market/macro-sentiment").catch(() => null);
        if (!macroRes || !macroRes.ok) {
          macroRes = await fetch("http://localhost:4000/api/v1/analytics/macro-sentiment/latest", {
            signal: AbortSignal.timeout(2000),
          }).catch(() => null);
        }
        if (macroRes && macroRes.ok) {
          const m = await macroRes.json();
          setMacroPrediction(m.status === "unavailable" ? null : m);
        }

        // 7. Signifikansi statistik model (reports/significance.json)
        const sigRes = await fetch("/api/market/significance").catch(() => null);
        if (sigRes && sigRes.ok) {
          const s = await sigRes.json();
          setSignificance(s.status === "ok" ? s.significance : null);
        }
      } catch {
        // Quiet network retry
      }
    }

    fetchApiData();
    const interval = setInterval(fetchApiData, 10000); // 10s poll

    return () => {
      sse?.close();
      clearInterval(interval);
      clearInterval(clockInterval);
    };
  }, []);

  // Fetch Event Study whenever selected event code changes
  useEffect(() => {
    async function loadEventStudy() {
      try {
        let res = await fetch(`/api/market/event-study?code=${selectedEventCode}`).catch(() => null);
        if (!res || !res.ok) {
          res = await fetch(
            `http://localhost:4000/api/v1/analytics/event-study/${selectedEventCode}`,
            { signal: AbortSignal.timeout(2000) }
          ).catch(() => null);
        }
        if (res && res.ok) {
          const json = await res.json();
          setEventStudyData(json.status === "unavailable" ? null : json);
        }
      } catch {}
    }
    loadEventStudy();
  }, [selectedEventCode]);

  const handleCopy = () => {
    navigator.clipboard?.writeText(dailyDigestContent || "Ringkasan Pasar Emas XAUUSD");
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!mounted) {
    return <div className="h-screen bg-[#0E131A]" suppressHydrationWarning />;
  }

  const bidPrice = livePrice ? livePrice.bid : null;
  const askPrice = livePrice ? livePrice.ask : null;
  const spreadValue =
    bidPrice !== null && askPrice !== null ? (askPrice - bidPrice).toFixed(2) : "--";

  // Derived event-study helpers (bentuk response API analitik).
  const reactionFor = (minutes: number) =>
    eventStudyData?.reactions?.find?.((r: any) => r.windowMinutes === minutes) ?? null;
  const reaction5 = reactionFor(5);
  const reaction15 = reactionFor(15);
  const reaction60 = reactionFor(60);
  const reactionPips = (reaction: any) =>
    reaction?.deltaPips !== undefined && reaction?.deltaPips !== null
      ? `${reaction.deltaPips > 0 ? "+" : ""}${reaction.deltaPips}p`
      : "--";
  const reactionDir = (reaction: any) => {
    if (!reaction || reaction.deltaPips === undefined || reaction.deltaPips === null) return null;
    return reaction.deltaPips > 0 ? "bullish" : reaction.deltaPips < 0 ? "bearish" : "neutral";
  };
  const latestLog =
    eventStudyData?.historicalLogs?.find(
      (log: any) => log.actual !== null && log.actual !== undefined
    ) ??
    eventStudyData?.historicalLogs?.[0] ??
    null;

  return (
    <div className="flex flex-col h-screen select-none bg-[#0E131A] text-ex-text font-sans overflow-hidden" suppressHydrationWarning>
      {/* 1. TOP BRAND & TRADE BAR (h-12 / 48px) */}
      <header className="h-12 border-b border-ex-border bg-[#141A22] flex items-center justify-between px-4 text-xs z-30">
        {/* Left: Brand Identity, Account Pill, Balance */}
        <div className="flex items-center space-x-4">
          <div className="flex items-center space-x-2 cursor-pointer">
            <span className="w-2.5 h-2.5 rounded-full bg-ex-yellow inline-block animate-pulse"></span>
            <span className="text-white font-extrabold tracking-wider font-sans text-sm flex items-center gap-1.5">
              <span>XAU/USD INTELLIGENCE</span>
              <span className="bg-ex-yellow/20 text-ex-yellow border border-ex-yellow/30 text-[9px] font-bold px-1.5 py-0.5 rounded tracking-widest uppercase">
                TERMINAL
              </span>
            </span>
          </div>

          <div className="h-4 w-[1px] bg-ex-border"></div>

          <div className="flex items-center space-x-2 bg-ex-panel px-2.5 py-1 rounded border border-ex-border">
            <span className="text-[10px] font-bold bg-[#13322B] text-[#26A69A] px-1.5 py-0.5 rounded">Demo</span>
            <span className="font-mono text-xs text-ex-text font-semibold">#416556561</span>
            <ChevronDown className="w-3.5 h-3.5 text-ex-muted" />
          </div>

          <div
            className="flex items-center space-x-2 font-mono text-xs pl-1"
            title="Akun demo — bukan dana nyata"
          >
            <span className="text-ex-muted">Balance:</span>
            <span className="font-bold text-white tracking-wide">Demo (bukan dana nyata)</span>
          </div>
        </div>

        {/* Center/Right: Buy/Sell Execution Box & AI Forecast Badge */}
        <div className="flex items-center space-x-4">
          {/* AI 4H Macro Intelligence Badge */}
          <div className="flex items-center space-x-2 bg-ex-panel px-3 py-1 rounded border border-ex-border">
            <span className="text-[10px] text-ex-muted font-bold tracking-wider">AI 4H FORECAST:</span>
            {macroPrediction ? (
              <span
                className={`text-xs font-bold font-mono ${
                  macroPrediction.signal === "BULLISH"
                    ? "text-ex-blue"
                    : macroPrediction.signal === "BEARISH"
                    ? "text-ex-red"
                    : "text-ex-yellow"
                }`}
              >
                {macroPrediction.signal} ({macroPrediction.predicted_pips_delta})
              </span>
            ) : (
              <span className="text-xs font-bold font-mono text-ex-muted">Data tidak tersedia</span>
            )}
          </div>

          {/* Clean Order Execution Box */}
          <div className="flex items-center shadow-lg">
            <div className="bg-ex-red text-white font-mono font-bold px-3 py-1.5 rounded-l text-xs flex items-center space-x-2">
              <span className="text-[10px] opacity-80 uppercase">Sell</span>
              <span className="text-sm tracking-wide">
                {bidPrice !== null ? bidPrice.toFixed(3) : "--"}
              </span>
            </div>

            <div className="bg-[#181F2A] border-y border-ex-border px-2.5 py-1 flex items-center justify-center text-[11px] font-mono text-ex-muted">
              <span>{spreadValue}</span>
            </div>

            <div className="bg-ex-blue text-white font-mono font-bold px-3 py-1.5 rounded-r text-xs flex items-center space-x-2">
              <span className="text-[10px] opacity-80 uppercase">Buy</span>
              <span className="text-sm tracking-wide">
                {askPrice !== null ? askPrice.toFixed(3) : "--"}
              </span>
            </div>
            {livePrice?.isSimulated && (
              <span
                className="ml-1 text-[9px] font-bold text-ex-yellow border border-ex-yellow/40 rounded px-1 py-0.5"
                title="Tick merupakan simulasi mikro di sekitar harga nyata terakhir."
              >
                SIM
              </span>
            )}
          </div>

          <div className="h-4 w-[1px] bg-ex-border"></div>

          {/* Time & Connection status */}
          <div className="flex items-center space-x-2 text-[11px] font-mono text-ex-muted">
            <div className="flex items-center space-x-0.5" title="Connection: Live">
              <span className="w-1 h-1.5 bg-[#26A69A] rounded-xs inline-block"></span>
              <span className="w-1 h-2.5 bg-[#26A69A] rounded-xs inline-block"></span>
              <span className="w-1 h-3.5 bg-[#26A69A] rounded-xs inline-block"></span>
            </div>
            <span>{currentTimeUtc || "08:35:56 UTC"}</span>
          </div>
        </div>
      </header>

      {/* 2. INSTRUMENT & TIMEFRAME STRIP (h-10 / 40px) */}
      <div className="h-10 border-b border-ex-border bg-[#10151D] flex items-center justify-between px-4 text-xs z-20">
        <div className="flex items-center space-x-3">
          {/* Active Dedicated Instrument */}
          <div className="flex items-center space-x-2 bg-[#1E2633] px-3 py-1 rounded border border-ex-border">
            <span className="w-2.5 h-2.5 rounded-full bg-ex-yellow inline-block"></span>
            <span className="font-bold text-white tracking-wide">XAU/USD</span>
            <span className="text-[10px] text-ex-muted font-mono">SPOT GOLD</span>
          </div>

          <div className="h-4 w-[1px] bg-ex-border"></div>

          {/* Timeframe Selector Pills */}
          <div className="flex items-center space-x-1">
            {["15m", "30m", "1h", "4h"].map((tf) => (
              <button
                key={tf}
                onClick={() => {
                  setActiveTf(tf);
                  try {
                    localStorage.setItem("xau_terminal_tf", tf);
                  } catch {}
                }}
                className={`px-2.5 py-0.5 rounded text-xs font-medium transition-colors ${
                  activeTf === tf
                    ? "bg-[#2962FF] text-white font-bold"
                    : "text-ex-muted hover:bg-ex-panel hover:text-white"
                }`}
              >
                {tf}
              </button>
            ))}
          </div>
        </div>

        {/* FR-10 Compliance Banner */}
        <div className="flex items-center space-x-1.5 text-[10px] text-ex-muted font-mono">
          <ShieldAlert className="w-3.5 h-3.5 text-ex-yellow" />
          <span>FR-10: Research Analytics Only • Non-Advisory</span>
        </div>
      </div>

      {/* 3. MAIN WORKSPACE: CLEAN EDGE-TO-EDGE CHART */}
      <div className="flex-1 flex flex-col min-w-0 bg-[#0E131A] relative overflow-hidden">
        {/* Real Dynamic Lightweight Chart */}
        <div className="flex-1 relative">
          <MarketChart timeframe={activeTf} />
        </div>

        {/* 4. BOTTOM TERMINAL DOCK */}
        <div className="h-48 border-t border-ex-border bg-[#141A22] flex flex-col z-20">
          {/* Dock Navigation Tabs */}
          <div className="h-8 border-b border-ex-border flex items-center justify-between px-4 text-xs bg-[#10151D]">
            <div className="flex items-center space-x-5">
              <button
                onClick={() => {
                  setActiveBottomTab("ai-intel");
                  try {
                    localStorage.setItem("xau_terminal_bottom_tab", "ai-intel");
                  } catch {}
                }}
                className={`py-1.5 font-semibold text-xs border-b-2 transition-all ${
                  activeBottomTab === "ai-intel"
                    ? "text-white border-white"
                    : "text-ex-muted border-transparent hover:text-white"
                }`}
              >
                Live AI Intelligence
              </button>
              <button
                onClick={() => {
                  setActiveBottomTab("event-study");
                  try {
                    localStorage.setItem("xau_terminal_bottom_tab", "event-study");
                  } catch {}
                }}
                className={`py-1.5 font-semibold text-xs border-b-2 transition-all ${
                  activeBottomTab === "event-study"
                    ? "text-white border-white"
                    : "text-ex-muted border-transparent hover:text-white"
                }`}
              >
                Event Study Explorer
              </button>
              <button
                onClick={() => {
                  setActiveBottomTab("calendar");
                  try {
                    localStorage.setItem("xau_terminal_bottom_tab", "calendar");
                  } catch {}
                }}
                className={`py-1.5 font-semibold text-xs border-b-2 transition-all ${
                  activeBottomTab === "calendar"
                    ? "text-white border-white"
                    : "text-ex-muted border-transparent hover:text-white"
                }`}
              >
                Economic Calendar
              </button>
              <button
                onClick={() => {
                  setActiveBottomTab("daily-digest");
                  try {
                    localStorage.setItem("xau_terminal_bottom_tab", "daily-digest");
                  } catch {}
                }}
                className={`py-1.5 font-semibold text-xs border-b-2 transition-all ${
                  activeBottomTab === "daily-digest"
                    ? "text-white border-white"
                    : "text-ex-muted border-transparent hover:text-white"
                }`}
              >
                Daily Digest & COT
              </button>
            </div>

            <div className="flex items-center space-x-3 text-[11px] text-ex-muted font-mono">
              <span>
                Model Champion:{" "}
                <b className="text-white">{significance?.champion_name || "unavailable"}</b>
              </span>
              <span>
                • Directional Hit Ratio:{" "}
                <b className="text-ex-blue">
                  {significance
                    ? `${(significance.hit_ratio_sig * 100).toFixed(2)}% (p=${
                        significance.hit_ratio_pvalue
                      }, CI95 [${significance.hit_ratio_ci95?.[0]}, ${
                        significance.hit_ratio_ci95?.[1]
                      }])`
                    : "unavailable"}
                </b>
              </span>
            </div>
          </div>

          {/* TAB 1: LIVE AI INTELLIGENCE */}
          {activeBottomTab === "ai-intel" && (
            <div className="flex-1 p-3 flex space-x-3 overflow-x-auto bg-[#0E131A]">
              {/* Forecast Card */}
              <div className="bg-[#141A22] border border-ex-border rounded p-3 flex-1 flex flex-col justify-between">
                <div className="flex justify-between items-center">
                  <span className="text-xs font-bold text-white">Quantitative 4H Forecast</span>
                  <span className="text-[10px] font-mono text-ex-yellow bg-ex-panel px-2 py-0.5 rounded">
                    {macroPrediction?.confidence_pct !== undefined &&
                    macroPrediction?.confidence_pct !== null
                      ? `Confidence: ${macroPrediction.confidence_pct}%`
                      : "Confidence: n/a"}
                  </span>
                </div>
                <div className="flex items-baseline space-x-3 my-1">
                  <span
                    className={`text-2xl font-black font-mono ${
                      macroPrediction?.signal === "BULLISH"
                        ? "text-ex-blue"
                        : macroPrediction?.signal === "BEARISH"
                        ? "text-ex-red"
                        : "text-ex-yellow"
                    }`}
                  >
                    {macroPrediction?.signal || "TIDAK TERSEDIA"}
                  </span>
                  {macroPrediction?.predicted_target_price !== undefined &&
                  macroPrediction?.predicted_target_price !== null ? (
                    <>
                      <span className="text-sm font-mono text-ex-muted">
                        Target: <b className="text-white">${macroPrediction.predicted_target_price}</b>
                      </span>
                      <span className="text-xs font-mono text-ex-blue font-bold">
                        ({macroPrediction.predicted_pips_delta})
                      </span>
                    </>
                  ) : (
                    <span className="text-sm font-mono text-ex-muted">
                      Prediksi belum tersedia — pipeline sentiment-analysis belum dijalankan.
                    </span>
                  )}
                </div>
                <span className="text-[10px] text-ex-muted">
                  *Prediksi persentase return 4 jam berbasis transmisi makro & model champion.
                </span>
              </div>

              {/* Macro Factor Drivers */}
              <div className="bg-[#141A22] border border-ex-border rounded p-3 flex-1 flex flex-col justify-between">
                <span className="text-xs font-bold text-white mb-1">Top Macroeconomic Drivers (Point-in-Time Lag)</span>
                <div className="space-y-1 text-[11px] font-mono">
                  {macroPrediction?.macro_drivers && macroPrediction.macro_drivers.length > 0 ? (
                    macroPrediction.macro_drivers.map((d: any, idx: number) => (
                      <div key={idx} className="flex justify-between items-center">
                        <span className="text-ex-muted">{d.driver}:</span>
                        <span
                          className={`font-bold ${
                            d.value.includes("-")
                              ? "text-ex-yellow"
                              : d.impact_on_gold.includes("Bearish")
                              ? "text-ex-red"
                              : "text-white"
                          }`}
                        >
                          {d.value} ({d.impact_on_gold})
                        </span>
                      </div>
                    ))
                  ) : (
                    <div className="text-ex-muted">
                      Driver makro belum tersedia — latest_prediction.json belum ada.
                    </div>
                  )}
                </div>
                <span className="text-[9px] text-ex-muted">Bebas look-ahead bias: Fitur makro disinkronkan lag T-1.</span>
              </div>

              {/* Model Significance Card */}
              <div className="bg-[#141A22] border border-ex-border rounded p-3 w-72 flex flex-col justify-between shrink-0">
                <span className="text-xs font-bold text-white mb-1">Signifikansi Model</span>
                <div className="space-y-1 text-[11px] font-mono">
                  {significance ? (
                    <>
                      <div className="flex justify-between">
                        <span className="text-ex-muted">Rank IC:</span>
                        <span className="text-white">
                          {significance.rank_ic} (p={significance.rank_ic_pvalue})
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-ex-muted">Hit ratio:</span>
                        <span className="text-white">
                          {(significance.hit_ratio_sig * 100).toFixed(2)}% (p=
                          {significance.hit_ratio_pvalue})
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-ex-muted">CI95 hit ratio:</span>
                        <span className="text-white">
                          [{significance.hit_ratio_ci95?.[0]}, {significance.hit_ratio_ci95?.[1]}]
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-ex-muted">Sentimen adds value:</span>
                        <span
                          className={
                            significance.sentiment_adds_value ? "text-ex-blue" : "text-ex-red"
                          }
                        >
                          {String(significance.sentiment_adds_value)}
                        </span>
                      </div>
                    </>
                  ) : (
                    <span className="text-ex-muted">
                      reports/significance.json belum tersedia.
                    </span>
                  )}
                </div>
                <span className="text-[9px] text-ex-muted">
                  Uji statistik: binomial test + Wilson CI + Spearman rank IC.
                </span>
              </div>

              {/* Quick Copy Daily Digest */}
              <div className="bg-[#141A22] border border-ex-border rounded p-3 w-64 flex flex-col justify-between">
                <div className="text-xs font-bold text-white">Daily Market Digest</div>
                <p className="text-[11px] text-ex-muted leading-tight">
                  Rangkuman pasar terstruktur siap salin untuk tim analis.
                </p>
                <button
                  onClick={handleCopy}
                  className="bg-ex-blue hover:bg-[#1e4bd8] text-white font-bold py-1.5 px-3 rounded text-xs flex items-center justify-center space-x-1.5 transition-colors"
                >
                  {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copied ? "Copied!" : "Copy Report"}</span>
                </button>
              </div>
            </div>
          )}

          {/* TAB 2: EVENT STUDY EXPLORER */}
          {activeBottomTab === "event-study" && (
            <div className="flex-1 p-3 flex flex-col bg-[#0E131A] text-xs overflow-hidden">
              {/* Event Switcher Bar & Export */}
              <div className="flex items-center justify-between pb-2 mb-2 border-b border-ex-border shrink-0">
                <div className="flex items-center space-x-2">
                  <span className="text-[11px] text-ex-muted font-bold mr-1">MACRO EVENT:</span>
                  {[
                    { code: "cpi", label: "US CPI" },
                    { code: "nfp", label: "NFP Payrolls" },
                    { code: "fomc", label: "FOMC Rate" },
                    { code: "pce", label: "Core PCE" },
                  ].map((ev) => (
                    <button
                      key={ev.code}
                      onClick={() => setSelectedEventCode(ev.code as any)}
                      className={`px-2.5 py-0.5 rounded text-xs font-semibold transition-colors ${
                        selectedEventCode === ev.code
                          ? "bg-ex-blue text-white"
                          : "bg-ex-panel text-ex-muted hover:text-white"
                      }`}
                    >
                      {ev.label}
                    </button>
                  ))}
                  <span className="text-[10px] text-ex-muted font-mono ml-2">
                    {eventStudyData?.eventName || "US Macro Release"}
                  </span>
                </div>

                <button
                  onClick={handleDownloadEventStudyCsv}
                  className="bg-ex-panel hover:bg-[#253041] border border-ex-border text-white px-2.5 py-1 rounded text-[11px] font-semibold flex items-center space-x-1.5 transition-colors"
                  title="Export Event Study Data to CSV"
                >
                  <FileSpreadsheet className="w-3.5 h-3.5 text-ex-yellow" />
                  <span>Download CSV</span>
                </button>
              </div>

              {/* Event Study Cards Grid */}
              <div className="flex-1 flex space-x-3 overflow-x-auto min-h-0">
                {/* Card 1: Empirical Reaction Windows */}
                <div className="bg-[#141A22] border border-ex-border rounded p-3 w-80 flex flex-col justify-between shrink-0">
                  <div className="font-bold text-white flex justify-between items-center">
                    <span>
                      Reaction Windows (
                      {eventStudyData?.eventCode || selectedEventCode.toUpperCase()})
                    </span>
                    <span className="text-[10px] text-ex-yellow font-mono font-bold">
                      {eventStudyData?.aggregatedStats
                        ? `${eventStudyData.aggregatedStats.directionalConsistency}% Consistency`
                        : "Consistency n/a"}
                    </span>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-center font-mono my-2">
                    {[
                      { label: "+5 MIN", reaction: reaction5 },
                      { label: "+15 MIN", reaction: reaction15 },
                      { label: "+60 MIN", reaction: reaction60 },
                    ].map(({ label, reaction }) => (
                      <div
                        key={label}
                        className="bg-[#0E131A] p-1.5 rounded border border-ex-border"
                      >
                        <div className="text-[9px] text-ex-muted">{label}</div>
                        <div
                          className={`text-sm font-bold ${
                            reactionDir(reaction) === "bullish"
                              ? "text-ex-blue"
                              : reactionDir(reaction) === "bearish"
                              ? "text-ex-red"
                              : "text-ex-muted"
                          }`}
                        >
                          {reactionPips(reaction)}
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="text-[10px] text-ex-muted flex justify-between font-mono">
                    <span>
                      Median Retrace:{" "}
                      <b className="text-white">
                        {eventStudyData?.aggregatedStats?.avgRetraceMinutes !== undefined &&
                        eventStudyData?.aggregatedStats?.avgRetraceMinutes !== null
                          ? `${eventStudyData.aggregatedStats.avgRetraceMinutes} Mins`
                          : "n/a"}
                      </b>
                    </span>
                    <span>
                      Sample:{" "}
                      <b>
                        {eventStudyData?.aggregatedStats
                          ? `${eventStudyData.aggregatedStats.totalReleases} Releases`
                          : "n/a"}
                      </b>
                    </span>
                  </div>
                </div>

                {/* Card 2: Surprise Score & Econometric IC */}
                <div className="bg-[#141A22] border border-ex-border rounded p-3 w-80 flex flex-col justify-between shrink-0">
                  <div className="font-bold text-white">Statistical Surprise Index</div>
                  <div className="space-y-1 font-mono text-[11px] my-1">
                    <div className="flex justify-between">
                      <span className="text-ex-muted">Latest Release:</span>
                      <span className="text-white">{latestLog?.date || "n/a"}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-ex-muted">Actual vs Forecast:</span>
                      <span className="text-white">
                        <b>{latestLog?.actual ?? "n/a"}</b> vs {latestLog?.forecast ?? "n/a"}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-ex-muted">Standardized Z-Score:</span>
                      <span className="text-ex-yellow font-bold">
                        {eventStudyData?.surprise
                          ? `${eventStudyData.surprise.zScore > 0 ? "+" : ""}${
                              eventStudyData.surprise.zScore
                            }σ`
                          : "n/a"}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-ex-muted">Rank IC model:</span>
                      <span className="text-ex-blue font-bold">
                        {significance
                          ? `${significance.rank_ic} (p=${significance.rank_ic_pvalue})`
                          : "n/a"}
                      </span>
                    </div>
                  </div>
                  <span className="text-[9px] text-ex-muted italic">
                    *Surprise = actual − forecast (fallback actual − previous), dibagi σ historis.
                  </span>
                </div>

                {/* Card 3: Historical Releases Reaction Table */}
                <div className="bg-[#141A22] border border-ex-border rounded p-2.5 flex-1 flex flex-col min-w-[340px] overflow-hidden">
                  <div className="font-bold text-white text-[11px] mb-1.5 flex justify-between">
                    <span>
                      Historical {eventStudyData?.eventCode || selectedEventCode.toUpperCase()}{" "}
                      Releases Reaction Log
                    </span>
                    <span className="text-[9px] text-ex-muted font-mono">Point-in-Time Data</span>
                  </div>
                  <div className="flex-1 overflow-y-auto space-y-1 font-mono text-[10px]">
                    <div className="grid grid-cols-5 text-ex-muted font-bold pb-1 border-b border-ex-border">
                      <span>Date</span>
                      <span>Actual</span>
                      <span>Forecast</span>
                      <span>Surprise</span>
                      <span className="text-right">Reaction</span>
                    </div>
                    {eventStudyData?.historicalLogs && eventStudyData.historicalLogs.length > 0 ? (
                      eventStudyData.historicalLogs.map((log: any, i: number) => (
                        <div key={i} className="grid grid-cols-5 py-0.5 border-b border-ex-border/40 hover:bg-[#1E2633] px-0.5 rounded">
                          <span className="text-white">{log.date}</span>
                          <span className="text-ex-muted">{log.actual ?? "n/a"}</span>
                          <span className="text-ex-muted">{log.forecast ?? "n/a"}</span>
                          <span className="text-ex-yellow">{log.surprise ?? "n/a"}</span>
                          <span
                            className={`text-right font-bold ${
                              log.direction === "bullish"
                                ? "text-ex-blue"
                                : log.direction === "bearish"
                                ? "text-ex-red"
                                : "text-ex-muted"
                            }`}
                          >
                            {log.pips !== null && log.pips !== undefined
                              ? `${log.pips > 0 ? "+" : ""}${log.pips}p`
                              : "n/a"}
                          </span>
                        </div>
                      ))
                    ) : (
                      <div className="text-ex-muted p-2">
                        Data event study tidak tersedia untuk event ini.
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 3: ECONOMIC CALENDAR */}
          {activeBottomTab === "calendar" && (
            <div className="flex-1 p-2 overflow-y-auto bg-[#0E131A] space-y-1.5 text-xs">
              {calendarEvents.length > 0 ? (
                calendarEvents.slice(0, 8).map((ev, i) => (
                  <div key={i} className="flex items-center justify-between bg-[#141A22] px-3 py-1.5 rounded border border-ex-border">
                    <div className="flex items-center space-x-2">
                      <span className="bg-[#2D1619] text-ex-red font-bold text-[9px] px-1.5 py-0.5 rounded">HIGH</span>
                      <span className="font-bold text-white">{ev.eventName}</span>
                      <span className="text-[10px] text-ex-muted font-mono">{ev.dateStr || "USD Release"}</span>
                    </div>
                    <div className="flex items-center space-x-4 font-mono text-[11px]">
                      <span className="text-ex-red font-bold">Act: {ev.actual ?? "--"}</span>
                      <span className="text-ex-muted">Fcst: {ev.forecast ?? "--"}</span>
                      <span className="text-ex-muted">Prev: {ev.previous ?? "--"}</span>
                    </div>
                  </div>
                ))
              ) : (
                <div className="text-ex-muted p-3">Loading economic calendar feed...</div>
              )}
            </div>
          )}

          {/* TAB 4: DAILY DIGEST & COT */}
          {activeBottomTab === "daily-digest" && (
            <div className="flex-1 p-3 flex space-x-3 overflow-hidden bg-[#0E131A]">
              <div className="w-80 bg-[#141A22] p-3 rounded border border-ex-border flex flex-col justify-between shrink-0">
                <div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-white">CFTC COT Institutional Position</span>
                    <span className="text-[10px] font-mono text-ex-yellow bg-ex-panel px-1.5 py-0.5 rounded">
                      {cotData ? "CFTC" : "n/a"}
                    </span>
                  </div>
                  <div className="my-2.5 space-y-1.5 text-xs font-mono">
                    <div className="flex justify-between">
                      <span className="text-ex-muted">Non-commercial Net:</span>
                      <span className="text-ex-blue font-bold">
                        {cotData
                          ? `${cotData.netPosition > 0 ? "+" : ""}${cotData.netPosition.toLocaleString()} Longs`
                          : "Data tidak tersedia"}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-ex-muted">Weekly Change:</span>
                      <span className="text-ex-blue font-bold">
                        {cotData
                          ? `${cotData.changeNet > 0 ? "+" : ""}${cotData.changeNet.toLocaleString()}`
                          : "n/a"}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-ex-muted">Report Date:</span>
                      <span className="text-white">{cotData?.reportDate || "n/a"}</span>
                    </div>
                  </div>
                  <p className="text-[10px] text-ex-muted leading-tight">
                    {cotData
                      ? "Posisi non-commercial emas dari laporan mingguan CFTC (Commitments of Traders — Futures Only)."
                      : "Laporan CFTC tidak bisa diakses saat ini; angka tidak ditampilkan."}
                  </p>
                </div>

                <button
                  onClick={handleDownloadCotCsv}
                  disabled={!cotData}
                  className="bg-ex-panel hover:bg-[#253041] border border-ex-border text-white py-1.5 px-3 rounded text-[11px] font-semibold flex items-center justify-center space-x-1.5 transition-colors mt-2 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <FileSpreadsheet className="w-3.5 h-3.5 text-ex-yellow" />
                  <span>Download COT CSV</span>
                </button>
              </div>

              {/* Right Panel: Daily Digest with Copy and Download Markdown */}
              <div className="flex-1 bg-[#141A22] p-3 rounded border border-ex-border flex flex-col overflow-hidden">
                <div className="flex items-center justify-between pb-2 mb-2 border-b border-ex-border shrink-0">
                  <div className="flex items-center space-x-2">
                    <FileText className="w-4 h-4 text-ex-yellow" />
                    <span className="text-xs font-bold text-white">Quantitative Daily Market Digest</span>
                    <span className="text-[9px] text-ex-muted font-mono bg-ex-panel px-1.5 py-0.5 rounded">FR-10 Compliant</span>
                  </div>

                  <div className="flex items-center space-x-2">
                    <button
                      onClick={handleCopy}
                      className="bg-ex-panel hover:bg-[#253041] border border-ex-border text-white font-semibold py-1 px-2.5 rounded text-[11px] flex items-center space-x-1.5 transition-colors"
                    >
                      {copied ? <Check className="w-3 h-3 text-[#26A69A]" /> : <Copy className="w-3 h-3" />}
                      <span>{copied ? "Copied!" : "Copy MD"}</span>
                    </button>
                    <button
                      onClick={handleDownloadDigestMd}
                      className="bg-ex-blue hover:bg-[#1e4bd8] text-white font-semibold py-1 px-2.5 rounded text-[11px] flex items-center space-x-1.5 transition-colors"
                    >
                      <Download className="w-3 h-3" />
                      <span>Download .md</span>
                    </button>
                  </div>
                </div>

                <div className="flex-1 overflow-y-auto text-xs font-mono whitespace-pre-wrap leading-relaxed text-ex-text pr-1">
                  {dailyDigestContent || `# Ringkasan Harian Pasar Emas\nMemuat laporan pasar otomatis...`}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 5. BOTTOM STATUS STRIP (h-7 / 28px) */}
      <footer className="h-7 border-t border-ex-border bg-[#0E131A] flex items-center justify-between px-4 text-[11px] font-mono text-ex-muted z-30 select-none">
        <div className="flex items-center space-x-5">
          <div>
            <span>Equity: </span>
            <span className="text-white font-bold">Demo</span>
          </div>
          <div>
            <span>Free Margin: </span>
            <span className="text-white font-bold">Demo</span>
          </div>
          <div>
            <span>Balance: </span>
            <span className="text-white font-bold">Demo</span>
          </div>
          <div>
            <span>Margin: </span>
            <span className="text-white">0.00 USD</span>
          </div>
          <div>
            <span>Margin level: </span>
            <span className="text-white">-</span>
          </div>
        </div>

        <div className="flex items-center space-x-3">
          <span className="text-white">{currentTimeUtc || "08:35:56 UTC"}</span>
          <span className="text-[10px] opacity-70">v6.12.0 [TE 1.3.3]</span>
        </div>
      </footer>
    </div>
  );
}
