"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import dynamic from "next/dynamic";
import {
  Copy,
  Check,
  ChevronDown,
  ShieldAlert,
  Download,
  FileSpreadsheet,
  FileText,
} from "lucide-react";
import {
  MicroLabel,
  Badge,
  TabToolbar,
  DockBody,
  Section,
  DataRow,
  Stat,
  EmptyNote,
  Footnote,
  ActionButton,
  ProvenanceTag,
  toneText,
  type Tone,
} from "../components/dock-ui";

// Dynamically import chart canvas with SSR disabled
const MarketChart = dynamic(
  () => import("../components/market-chart").then((mod) => mod.MarketChart),
  {
    ssr: false,
    loading: () => (
      <div className="flex-1 flex items-center justify-center text-ex-muted font-mono text-xs bg-ex-bg">
        Loading Market Canvas Engine...
      </div>
    ),
  }
);

const DOCK_MIN = 150;
const DOCK_DEFAULT = 320;
const DOCK_STORAGE_KEY = "xau_terminal_dock_height";
// Tinggi minimum chart + chrome atas (header h-12=48 + strip h-10=40). Dock
// tidak boleh mendesak chart di bawah CHART_MIN supaya tidak "terpotong"/squashed.
const CHART_MIN = 280;
const CHROME_H = 88;

function clampDock(h: number, max: number) {
  return Math.min(Math.max(Math.round(h), DOCK_MIN), Math.max(DOCK_MIN, max));
}

export default function MarketTradingTerminal() {
  const [mounted, setMounted] = useState(false);
  const [activeBottomTab, setActiveBottomTab] = useState<
    "ai-intel" | "event-study" | "calendar" | "daily-digest"
  >("ai-intel");
  const [dockCollapsed, setDockCollapsed] = useState(false);
  const [activeTf, setActiveTf] = useState("1h");
  const [copied, setCopied] = useState(false);
  const [currentTimeUtc, setCurrentTimeUtc] = useState("");

  // Dock resizable (drag-to-resize seam di border atas dock).
  const [dockHeight, setDockHeight] = useState(DOCK_DEFAULT);
  const [isDragging, setIsDragging] = useState(false);
  const dockHeightRef = useRef(DOCK_DEFAULT);
  const dragStateRef = useRef<{ startY: number; startH: number } | null>(null);
  dockHeightRef.current = dockHeight;

  const dockMax = useCallback(
    () =>
      Math.max(
        DOCK_MIN,
        (typeof window !== "undefined" ? window.innerHeight : 900) - CHROME_H - CHART_MIN
      ),
    []
  );

  // Live API States
  const [livePrice, setLivePrice] = useState<{
    bid: number;
    ask: number;
    isSimulated: boolean;
  } | null>(null);
  const [calendarEvents, setCalendarEvents] = useState<any[]>([]);
  const [selectedEventCode, setSelectedEventCode] = useState<
    "cpi" | "nfp" | "fomc" | "pce"
  >("cpi");
  const [eventStudyData, setEventStudyData] = useState<any>(null);
  const [dailyDigestContent, setDailyDigestContent] = useState<string>("");
  const [cotData, setCotData] = useState<any>(null);
  const [macroPrediction, setMacroPrediction] = useState<any>(null);
  const [significance, setSignificance] = useState<any>(null);

  // File download helper
  const handleDownloadFile = (
    filename: string,
    content: string,
    mimeType: string
  ) => {
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
    const headers =
      "Date,Event,Actual,Forecast,Surprise,ReactionPips,Direction,IsSimulated\n";
    const rows = eventStudyData.historicalLogs
      .map(
        (log: any) =>
          `"${log.date}","${eventStudyData.eventName ?? eventStudyData.eventCode}","${
            log.actual ?? ""
          }","${log.forecast ?? ""}","${log.surprise ?? ""}","${
            log.pips ?? ""
          }","${log.direction ?? ""}","${log.isSimulated === true ? "true" : "false"}"`
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
      const savedDock = localStorage.getItem("xau_terminal_dock_collapsed");
      if (savedDock !== null) {
        setDockCollapsed(savedDock === "true");
      } else if (window.matchMedia("(max-width: 767px)").matches) {
        // Default mobile: dock tertutup supaya chart dominan; user bisa buka
        // via chevron. Preferensi eksplisit user (di atas) selalu menang.
        setDockCollapsed(true);
      }
      const savedHeight = localStorage.getItem(DOCK_STORAGE_KEY);
      if (savedHeight) {
        const parsed = Number(savedHeight);
        if (Number.isFinite(parsed)) {
          const max = Math.max(DOCK_MIN, window.innerHeight - CHROME_H - CHART_MIN);
          setDockHeight(clampDock(parsed, max));
        }
      }
    } catch {}

    // Live clock ticker
    const clockInterval = setInterval(() => {
      const now = new Date();
      const timeStr = now.toISOString().split("T")[1]?.split(".")[0] || "";
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
        const priceRes = await fetch(
          "http://localhost:4000/api/v1/market/xauusd/latest",
          { signal: AbortSignal.timeout(2000) }
        ).catch(() => null);
        if (priceRes && priceRes.ok) {
          const p = await priceRes.json();
          // Bid/ask hanya dipakai bila sumber menyediakannya; API mengembalikan
          // null (spread nyata tidak tersedia) — jangan mengarang pengganti.
          if (
            p.bid !== null &&
            p.bid !== undefined &&
            p.ask !== null &&
            p.ask !== undefined
          ) {
            setLivePrice({
              bid: p.bid,
              ask: p.ask,
              isSimulated: p.isSimulated === true,
            });
          }
        }

        // 2. Upcoming Economic Calendar (internal route with external fallback)
        let calRes = await fetch("/api/market/calendar").catch(() => null);
        if (!calRes || !calRes.ok) {
          calRes = await fetch(
            "http://localhost:4000/api/v1/calendar/upcoming",
            { signal: AbortSignal.timeout(2000) }
          ).catch(() => null);
        }
        if (calRes && calRes.ok) {
          const c = await calRes.json();
          setCalendarEvents(c.events || []);
        }

        // 3. Event study analysis
        const studyRes = await fetch(
          "http://localhost:4000/api/v1/analytics/event-study/cpi",
          { signal: AbortSignal.timeout(2000) }
        ).catch(() => null);
        if (studyRes && studyRes.ok) {
          const s = await studyRes.json();
          setEventStudyData(s.status === "unavailable" ? null : s);
        }

        // 4. Daily digest
        const digestRes = await fetch(
          "http://localhost:4000/api/v1/reports/daily/latest",
          { signal: AbortSignal.timeout(2000) }
        ).catch(() => null);
        if (digestRes && digestRes.ok) {
          const d = await digestRes.json();
          setDailyDigestContent(d.markdownContent || "");
        }

        // 5. COT report
        const cotRes = await fetch(
          "http://localhost:4000/api/v1/reports/cot/latest",
          { signal: AbortSignal.timeout(2000) }
        ).catch(() => null);
        if (cotRes && cotRes.ok) {
          const cot = await cotRes.json();
          setCotData(cot.status === "ok" && cot.report ? cot.report : null);
        }

        // 6. AI Macro-Sentiment Prediction
        let macroRes = await fetch("/api/market/macro-sentiment").catch(
          () => null
        );
        if (!macroRes || !macroRes.ok) {
          macroRes = await fetch(
            "http://localhost:4000/api/v1/analytics/macro-sentiment/latest",
            { signal: AbortSignal.timeout(2000) }
          ).catch(() => null);
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
        let res = await fetch(
          `/api/market/event-study?code=${selectedEventCode}`
        ).catch(() => null);
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

  // Clamp dock height bila viewport berubah (jangan sampai chart habis).
  useEffect(() => {
    const onResize = () =>
      setDockHeight((h) => clampDock(h, dockMax()));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [dockMax]);

  // Drag-to-resize: pointermove/up di window selama dragging.
  useEffect(() => {
    if (!isDragging) return;
    const onMove = (e: PointerEvent) => {
      const st = dragStateRef.current;
      if (!st) return;
      const delta = st.startY - e.clientY;
      setDockHeight(clampDock(st.startH + delta, dockMax()));
    };
    const onUp = () => {
      setIsDragging(false);
      dragStateRef.current = null;
      try {
        localStorage.setItem(DOCK_STORAGE_KEY, String(dockHeightRef.current));
      } catch {}
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [isDragging, dockMax]);

  const onResizePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dockCollapsed) return;
    e.preventDefault();
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {}
    dragStateRef.current = { startY: e.clientY, startH: dockHeightRef.current };
    setIsDragging(true);
  };

  const handleCopy = () => {
    navigator.clipboard?.writeText(
      dailyDigestContent || "Ringkasan Pasar Emas XAUUSD"
    );
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const selectTab = (tab: typeof activeBottomTab) => {
    setActiveBottomTab(tab);
    try {
      localStorage.setItem("xau_terminal_bottom_tab", tab);
    } catch {}
  };

  if (!mounted) {
    return <div className="h-screen bg-ex-bg" suppressHydrationWarning />;
  }

  // Derived event-study helpers (bentuk response API analitik).
  const reactionFor = (minutes: number) =>
    eventStudyData?.reactions?.find?.(
      (r: any) => r.windowMinutes === minutes
    ) ?? null;
  const reaction5 = reactionFor(5);
  const reaction15 = reactionFor(15);
  const reaction60 = reactionFor(60);
  const reactionPips = (reaction: any) =>
    reaction?.deltaPips !== undefined && reaction?.deltaPips !== null
      ? `${reaction.deltaPips > 0 ? "+" : ""}${reaction.deltaPips}p`
      : "--";
  const reactionDir = (reaction: any): Tone => {
    if (
      !reaction ||
      reaction.deltaPips === undefined ||
      reaction.deltaPips === null
    )
      return "muted";
    return reaction.deltaPips > 0
      ? "blue"
      : reaction.deltaPips < 0
      ? "red"
      : "muted";
  };
  const latestLog =
    eventStudyData?.historicalLogs?.find(
      (log: any) => log.actual !== null && log.actual !== undefined
    ) ??
    eventStudyData?.historicalLogs?.[0] ??
    null;

  const signalTone: Tone =
    macroPrediction?.signal === "BULLISH"
      ? "blue"
      : macroPrediction?.signal === "BEARISH"
      ? "red"
      : "yellow";

  const tabs: { id: typeof activeBottomTab; full: string; short: string }[] = [
    { id: "ai-intel", full: "Live AI Intelligence", short: "AI Intel" },
    { id: "event-study", full: "Event Study Explorer", short: "Event Study" },
    { id: "calendar", full: "Economic Calendar", short: "Calendar" },
    { id: "daily-digest", full: "Daily Digest & COT", short: "Digest & COT" },
  ];

  const simCount = calendarEvents.filter(
    (e) => e.isSimulated === true || e.source === "simulated"
  ).length;

  return (
    <div
      className={`flex flex-col h-screen select-none bg-ex-bg text-ex-text font-sans overflow-hidden ${
        isDragging ? "cursor-row-resize" : ""
      }`}
      suppressHydrationWarning
    >
      {/* 1. TOP INSTITUTIONAL BAR — identitas + forecast real + jam UTC.
          Chrome akun trading palsu (nomor akun, balance, sell/buy) DIHAPUS:
          ini tool riset FR-10, bukan akun trading. */}
      <header className="h-12 shrink-0 border-b border-ex-border bg-[#141A22] flex items-center justify-between gap-2 px-3 sm:px-4 text-xs z-30">
        <div className="flex items-center gap-2 sm:gap-4 min-w-0">
          <div className="flex items-center gap-2 shrink-0">
            <span className="w-2.5 h-2.5 bg-ex-yellow inline-block animate-pulse" />
            <span className="text-white font-extrabold tracking-wider font-sans text-sm flex items-center gap-1.5">
              <span className="whitespace-nowrap">
                XAU/USD<span className="hidden md:inline"> INTELLIGENCE</span>
              </span>
              <span className="hidden sm:inline-block border border-ex-yellow/40 text-ex-yellow text-[9px] font-bold px-1.5 py-0.5 tracking-widest uppercase">
                Terminal
              </span>
            </span>
          </div>

          <div className="h-4 w-[1px] bg-ex-border hidden lg:block" />

          <div className="hidden lg:flex items-center gap-2 min-w-0">
            <MicroLabel>Spot Gold · Research</MicroLabel>
            <Badge tone="blue" title="Pipeline harga: Deriv CFD (live) + CSV historis.">
              Deriv CFD · CSV
            </Badge>
          </div>
        </div>

        <div className="flex items-center gap-2 sm:gap-4 shrink-0">
          {/* AI 4H Macro Intelligence — data REAL dari API sentiment. */}
          <div className="hidden md:flex items-center gap-2 border border-ex-border bg-ex-panel px-3 py-1">
            <MicroLabel>AI 4H Forecast</MicroLabel>
            {macroPrediction ? (
              <span className={`text-xs font-bold font-mono ${toneText[signalTone]}`}>
                {macroPrediction.signal} ({macroPrediction.predicted_pips_delta})
              </span>
            ) : (
              <span className="text-xs font-bold font-mono text-ex-muted">
                n/a
              </span>
            )}
          </div>

          <div className="h-4 w-[1px] bg-ex-border hidden sm:block" />

          {/* Connection + jam UTC real. */}
          <div className="flex items-center gap-2 text-[10px] sm:text-[11px] font-mono text-ex-muted">
            <div
              className="hidden sm:flex items-center gap-0.5"
              title={livePrice ? "Feed tersambung" : "Menunggu feed"}
            >
              <span className="w-1 h-1.5 bg-ex-blue inline-block" />
              <span className="w-1 h-2.5 bg-ex-blue inline-block" />
              <span className="w-1 h-3.5 bg-ex-blue inline-block" />
            </div>
            {livePrice?.isSimulated && (
              <Badge tone="red" title="Tick simulasi mikro di sekitar harga nyata terakhir.">
                SIM
              </Badge>
            )}
            <span className="whitespace-nowrap text-ex-text">
              {currentTimeUtc || "--:--:-- UTC"}
            </span>
          </div>
        </div>
      </header>

      {/* 2. INSTRUMENT & TIMEFRAME STRIP */}
      <div className="h-10 shrink-0 border-b border-ex-border bg-[#10151D] flex items-center justify-between gap-2 px-3 sm:px-4 text-xs z-20">
        <div className="flex items-center gap-2 sm:gap-3 min-w-0">
          <div className="flex items-center gap-2 bg-ex-panel px-2 sm:px-3 py-1 border border-ex-border shrink-0">
            <span className="w-2.5 h-2.5 bg-ex-yellow inline-block" />
            <span className="font-bold text-white tracking-wide whitespace-nowrap">
              XAU/USD
            </span>
            <span className="hidden md:inline text-[10px] text-ex-muted font-mono">
              SPOT GOLD
            </span>
          </div>

          <div className="h-4 w-[1px] bg-ex-border hidden sm:block" />

          <div className="flex items-center gap-1">
            {["15m", "30m", "1h", "4h"].map((tf) => (
              <button
                key={tf}
                onClick={() => {
                  setActiveTf(tf);
                  try {
                    localStorage.setItem("xau_terminal_tf", tf);
                  } catch {}
                }}
                className={`px-2.5 py-0.5 text-xs font-medium transition-colors ${
                  activeTf === tf
                    ? "bg-ex-blue text-white font-bold"
                    : "text-ex-muted hover:bg-ex-panel hover:text-white"
                }`}
              >
                {tf}
              </button>
            ))}
          </div>
        </div>

        <div
          className="flex items-center gap-1.5 text-[10px] text-ex-muted font-mono shrink-0"
          title="FR-10: Research Analytics Only • Non-Advisory"
        >
          <ShieldAlert className="w-3.5 h-3.5 text-ex-yellow" />
          <span className="hidden lg:inline whitespace-nowrap">
            FR-10: Research Analytics Only • Non-Advisory
          </span>
        </div>
      </div>

      {/* 3. MAIN WORKSPACE: chart flex di atas, dock resizable di bawah. */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0 bg-ex-bg relative overflow-hidden">
        <div className="flex-1 relative min-h-0">
          <MarketChart timeframe={activeTf} />
        </div>

        {/* 4. BOTTOM DOCK — tinggi user-controlled (drag seam), persist
            localStorage. Chevron collapse tetap ada. */}
        <div
          className="relative shrink-0 min-h-0 border-t border-ex-border bg-[#141A22] flex flex-col z-20"
          style={{ height: dockCollapsed ? undefined : dockHeight }}
        >
          {/* Resize seam: hairline yang bisa di-drag (cursor row-resize).
            Menggantikan pendekatan max-h fixed. */}
          {!dockCollapsed && (
            <div
              onPointerDown={onResizePointerDown}
              role="separator"
              aria-orientation="horizontal"
              aria-label="Resize dock"
              aria-valuenow={dockHeight}
              aria-valuemin={DOCK_MIN}
              title="Drag untuk memperbesar / memperkecil dock"
              className="absolute -top-[3px] left-0 right-0 h-[7px] cursor-row-resize z-30 group flex items-center justify-center touch-none"
            >
              <div
                className={`h-[2px] w-full transition-colors ${
                  isDragging ? "bg-ex-blue" : "bg-transparent group-hover:bg-ex-blue/60"
                }`}
              />
              <div
                className={`absolute h-[3px] w-10 transition-colors ${
                  isDragging ? "bg-ex-blue" : "bg-ex-border group-hover:bg-ex-blue"
                }`}
              />
            </div>
          )}

          {/* Dock Navigation Tabs — pola underline konsisten (referensi terminal). */}
          <div className="min-h-9 shrink-0 border-b border-ex-border flex flex-wrap items-center gap-x-4 gap-y-0.5 px-3 sm:px-4 py-1 text-xs bg-[#10151D]">
            <div className="flex items-center gap-3 sm:gap-5 order-1">
              {tabs.map((t) => (
                <button
                  key={t.id}
                  onClick={() => selectTab(t.id)}
                  className={`py-1 font-semibold text-xs border-b-2 transition-all whitespace-nowrap ${
                    activeBottomTab === t.id
                      ? "text-white border-ex-yellow"
                      : "text-ex-muted border-transparent hover:text-white"
                  }`}
                >
                  <span className="hidden xl:inline">{t.full}</span>
                  <span className="xl:hidden">{t.short}</span>
                </button>
              ))}
            </div>

            <button
              onClick={() =>
                setDockCollapsed((prev) => {
                  const next = !prev;
                  try {
                    localStorage.setItem(
                      "xau_terminal_dock_collapsed",
                      String(next)
                    );
                  } catch {}
                  return next;
                })
              }
              title={dockCollapsed ? "Tampilkan dock" : "Sembunyikan dock"}
              aria-expanded={!dockCollapsed}
              className="order-2 md:order-3 ml-auto md:ml-0 p-1 text-ex-muted hover:text-white transition-colors"
            >
              <ChevronDown
                className={`w-4 h-4 transition-transform ${
                  dockCollapsed ? "rotate-180" : ""
                }`}
              />
            </button>

            <div className="order-3 md:order-2 w-full md:w-auto md:ml-auto flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] md:text-[11px] text-ex-muted font-mono">
              <span className="whitespace-nowrap">
                <span className="hidden xl:inline">Model Champion:</span>
                <span className="xl:hidden">Champion:</span>{" "}
                <b className="text-white">
                  {significance?.champion_name || "unavailable"}
                </b>
              </span>
              <span>
                • <span className="hidden xl:inline">Directional Hit Ratio:</span>
                <span className="xl:hidden">Hit Ratio:</span>{" "}
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

          {/* Dock content: TETAP scroll (overflow-y-auto), scrollbar visual
            disembunyikan via .dock-scroll. Satu shell untuk semua tab. */}
          {!dockCollapsed && (
            <div className="flex-1 min-h-0 overflow-y-auto dock-scroll">
              {/* TAB 1: LIVE AI INTELLIGENCE */}
              {activeBottomTab === "ai-intel" && (
                <>
                  <TabToolbar
                    title="Live AI Intelligence"
                    meta={
                      macroPrediction ? (
                        <Badge tone={signalTone}>
                          {macroPrediction.prediction_horizon || "4H"}
                        </Badge>
                      ) : null
                    }
                    actions={
                      macroPrediction?.timestamp_utc ? (
                        <span className="text-[10px] font-mono text-ex-muted hidden sm:inline">
                          {macroPrediction.timestamp_utc}
                        </span>
                      ) : null
                    }
                  />
                  <DockBody>
                    {macroPrediction ? (
                      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-4">
                        {/* Forecast hero — display besar, type-scale kontras. */}
                        <Section first label="Quantitative 4H Forecast">
                          <Stat
                            label="Signal"
                            value={macroPrediction.signal || "N/A"}
                            tone={signalTone}
                            size="3xl"
                            sub={
                              <>
                                Target{" "}
                                <b className="text-ex-text">
                                  ${macroPrediction.predicted_target_price ?? "--"}
                                </b>{" "}
                                · {macroPrediction.predicted_pips_delta ?? "--"} ·
                                Confidence {macroPrediction.confidence_pct ?? "n/a"}%
                              </>
                            }
                          />
                          <Footnote>
                            *Prediksi persentase return 4 jam berbasis transmisi
                            makro &amp; model champion. Bukan sinyal trading (FR-10).
                          </Footnote>
                        </Section>

                        <div className="min-w-0">
                          {/* Macro drivers — data REAL point-in-time. */}
                          <Section first label="Top Macroeconomic Drivers">
                            {macroPrediction.macro_drivers?.length > 0 ? (
                              <div>
                                {macroPrediction.macro_drivers.map(
                                  (d: any, idx: number) => (
                                    <DataRow
                                      key={idx}
                                      label={d.driver}
                                      tone={
                                        d.value.includes("-")
                                          ? "yellow"
                                          : d.impact_on_gold.includes("Bearish")
                                          ? "red"
                                          : "text"
                                      }
                                      bold
                                    >
                                      {d.value}{" "}
                                      <span className="text-ex-muted font-normal">
                                        ({d.impact_on_gold})
                                      </span>
                                    </DataRow>
                                  )
                                )}
                              </div>
                            ) : (
                              <EmptyNote>
                                Driver makro belum tersedia — latest_prediction.json
                                belum ada.
                              </EmptyNote>
                            )}
                            <Footnote>
                              Bebas look-ahead bias: fitur makro disinkronkan lag T-1.
                            </Footnote>
                          </Section>

                          {/* Model significance — data REAL reports/significance.json. */}
                          <Section label="Model Significance">
                            {significance ? (
                              <div>
                                <DataRow label="Rank IC">
                                  {significance.rank_ic} (p={significance.rank_ic_pvalue})
                                </DataRow>
                                <DataRow label="Hit ratio">
                                  {(significance.hit_ratio_sig * 100).toFixed(2)}% (p=
                                  {significance.hit_ratio_pvalue})
                                </DataRow>
                                <DataRow label="CI95 hit ratio">
                                  [{significance.hit_ratio_ci95?.[0]},{" "}
                                  {significance.hit_ratio_ci95?.[1]}]
                                </DataRow>
                                <DataRow
                                  label="Sentimen adds value"
                                  tone={
                                    significance.sentiment_adds_value ? "blue" : "red"
                                  }
                                  bold
                                >
                                  {String(significance.sentiment_adds_value)}
                                </DataRow>
                              </div>
                            ) : (
                              <EmptyNote>
                                reports/significance.json belum tersedia.
                              </EmptyNote>
                            )}
                            <Footnote>
                              Uji statistik: binomial test + Wilson CI + Spearman rank IC.
                            </Footnote>
                          </Section>
                        </div>
                      </div>
                    ) : (
                      <EmptyNote>
                        Prediksi belum tersedia — pipeline sentiment-analysis belum
                        dijalankan. Tidak ada angka yang ditampilkan sampai data real ada.
                      </EmptyNote>
                    )}
                  </DockBody>
                </>
              )}

              {/* TAB 2: EVENT STUDY EXPLORER */}
              {activeBottomTab === "event-study" && (
                <>
                  <TabToolbar
                    title="Event Study Explorer"
                    meta={
                      <div className="flex flex-wrap items-center gap-1">
                        {[
                          { code: "cpi", label: "CPI" },
                          { code: "nfp", label: "NFP" },
                          { code: "fomc", label: "FOMC" },
                          { code: "pce", label: "PCE" },
                        ].map((ev) => (
                          <button
                            key={ev.code}
                            onClick={() => setSelectedEventCode(ev.code as any)}
                            className={`px-2 py-0.5 text-[11px] font-semibold border transition-colors ${
                              selectedEventCode === ev.code
                                ? "bg-ex-blue border-ex-blue text-white"
                                : "bg-ex-panel border-ex-border text-ex-muted hover:text-white"
                            }`}
                          >
                            {ev.label}
                          </button>
                        ))}
                      </div>
                    }
                    actions={
                      <ActionButton
                        onClick={handleDownloadEventStudyCsv}
                        title="Export Event Study Data to CSV"
                      >
                        <FileSpreadsheet className="w-3.5 h-3.5 text-ex-yellow" />
                        <span className="hidden sm:inline">CSV</span>
                      </ActionButton>
                    }
                  />
                  <DockBody>
                    {/* Reaction windows — strip stat horizontal. */}
                    <Section
                      first
                      label={`Reaction Windows · ${
                        eventStudyData?.eventCode || selectedEventCode.toUpperCase()
                      }`}
                      aside={
                        eventStudyData?.aggregatedStats ? (
                          <Badge tone="yellow">
                            {eventStudyData.aggregatedStats.directionalConsistency}%
                            consistency
                          </Badge>
                        ) : null
                      }
                    >
                      <div className="grid grid-cols-3 gap-3">
                        {[
                          { label: "+5 MIN", reaction: reaction5 },
                          { label: "+15 MIN", reaction: reaction15 },
                          { label: "+60 MIN", reaction: reaction60 },
                        ].map(({ label, reaction }) => (
                          <Stat
                            key={label}
                            label={label}
                            value={reactionPips(reaction)}
                            tone={reactionDir(reaction)}
                            size="xl"
                          />
                        ))}
                      </div>
                      <div className="flex flex-wrap gap-x-5 gap-y-1 mt-3 text-[10px] font-mono text-ex-muted">
                        <span>
                          Median retrace:{" "}
                          <b className="text-ex-text">
                            {eventStudyData?.aggregatedStats?.avgRetraceMinutes ??
                              "n/a"}{" "}
                            min
                          </b>
                        </span>
                        <span>
                          Sample (n):{" "}
                          <b className="text-ex-text">
                            {eventStudyData?.aggregatedStats?.totalReleases ?? "n/a"}{" "}
                            releases
                          </b>
                        </span>
                      </div>
                    </Section>

                    {/* Surprise index. */}
                    <Section label="Statistical Surprise Index">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6">
                        <DataRow label="Latest release">
                          {latestLog?.date || "n/a"}
                        </DataRow>
                        <DataRow label="Actual vs forecast">
                          <b>{latestLog?.actual ?? "n/a"}</b> vs{" "}
                          {latestLog?.forecast ?? "n/a"}
                        </DataRow>
                        <DataRow label="Standardized Z-score" tone="yellow" bold>
                          {eventStudyData?.surprise
                            ? `${eventStudyData.surprise.zScore > 0 ? "+" : ""}${
                                eventStudyData.surprise.zScore
                              }σ`
                            : "n/a"}
                        </DataRow>
                        <DataRow label="Rank IC model" tone="blue" bold>
                          {significance
                            ? `${significance.rank_ic} (p=${significance.rank_ic_pvalue})`
                            : "n/a"}
                        </DataRow>
                      </div>
                      <Footnote>
                        *Surprise = actual − forecast (fallback actual − previous),
                        dibagi σ historis.
                      </Footnote>
                    </Section>

                    {/* Historical releases table — row rhythm konsisten. */}
                    <Section
                      label={`Historical ${
                        eventStudyData?.eventCode || selectedEventCode.toUpperCase()
                      } Releases`}
                      aside={
                        <span className="text-[9px] font-mono text-ex-muted">
                          Point-in-Time
                        </span>
                      }
                    >
                      <div className="font-mono text-[10px]">
                        <div className="grid grid-cols-[1.1fr_0.8fr_0.8fr_1.3fr_0.8fr_auto] gap-2 text-ex-muted font-bold pb-1 border-b border-ex-border">
                          <span>Date</span>
                          <span>Actual</span>
                          <span>Forecast</span>
                          <span>Surprise</span>
                          <span className="text-right">Reaction</span>
                          <span className="text-right">Src</span>
                        </div>
                        {eventStudyData?.historicalLogs?.length > 0 ? (
                          eventStudyData.historicalLogs.map((log: any, i: number) => (
                            <div
                              key={i}
                              className="grid grid-cols-[1.1fr_0.8fr_0.8fr_1.3fr_0.8fr_auto] gap-2 py-[3px] border-b border-ex-border/40 hover:bg-ex-panel/60 items-center"
                            >
                              <span className="text-ex-text">{log.date}</span>
                              <span className="text-ex-muted">
                                {log.actual ?? "n/a"}
                              </span>
                              <span className="text-ex-muted">
                                {log.forecast ?? "n/a"}
                              </span>
                              <span className="text-ex-yellow">
                                {log.surprise ?? "n/a"}
                              </span>
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
                              <span className="text-right">
                                <ProvenanceTag
                                  source={log.source}
                                  isSimulated={log.isSimulated}
                                />
                              </span>
                            </div>
                          ))
                        ) : (
                          <EmptyNote>
                            Data event study tidak tersedia untuk event ini.
                          </EmptyNote>
                        )}
                      </div>
                      <Footnote>
                        Baris bertanda SIM = rilis terjadwal dengan data simulasi
                        (actual/forecast belum tersedia) — placeholder, bukan cetakan nyata.
                      </Footnote>
                    </Section>
                  </DockBody>
                </>
              )}

              {/* TAB 3: ECONOMIC CALENDAR */}
              {activeBottomTab === "calendar" && (
                <>
                  <TabToolbar
                    title="Economic Calendar"
                    meta={
                      <Badge tone="muted">
                        {calendarEvents.length} upcoming
                      </Badge>
                    }
                    actions={
                      simCount > 0 ? (
                        <Badge tone="red" title="Sebagian rilis memakai data simulasi.">
                          {simCount} simulated
                        </Badge>
                      ) : null
                    }
                  />
                  <DockBody>
                    {calendarEvents.length > 0 ? (
                      <div className="font-mono text-[11px]">
                        <div className="grid grid-cols-[auto_minmax(0,1.6fr)_auto_auto_auto_auto_auto] gap-3 text-ex-muted font-bold pb-1 border-b border-ex-border text-[10px]">
                          <span>Impact</span>
                          <span>Event</span>
                          <span>Date</span>
                          <span className="text-right">Actual</span>
                          <span className="text-right">Forecast</span>
                          <span className="text-right">Previous</span>
                          <span className="text-right">Src</span>
                        </div>
                        {calendarEvents.slice(0, 12).map((ev, i) => (
                          <div
                            key={i}
                            className="grid grid-cols-[auto_minmax(0,1.6fr)_auto_auto_auto_auto_auto] gap-3 py-[5px] border-b border-ex-border/40 hover:bg-ex-panel/60 items-center"
                          >
                            <Badge tone="red">{ev.impact || "HIGH"}</Badge>
                            <span className="font-sans font-bold text-ex-text truncate">
                              {ev.eventName}
                            </span>
                            <span className="text-ex-muted whitespace-nowrap">
                              {ev.dateStr || "USD"}
                            </span>
                            <span className="text-right text-ex-red font-bold">
                              {ev.actual ?? "--"}
                            </span>
                            <span className="text-right text-ex-muted">
                              {ev.forecast ?? "--"}
                            </span>
                            <span className="text-right text-ex-muted hidden sm:inline">
                              {ev.previous ?? "--"}
                            </span>
                            <span className="text-right">
                              <ProvenanceTag
                                source={ev.source}
                                isSimulated={ev.isSimulated}
                              />
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <EmptyNote>Memuat feed kalender ekonomi…</EmptyNote>
                    )}
                    <Footnote>
                      Impact HIGH bersumber dari kalender. Rilis bertanda SIM memakai
                      data simulasi (placeholder); FRED/CSV berasal dari dataset historis.
                    </Footnote>
                  </DockBody>
                </>
              )}

              {/* TAB 4: DAILY DIGEST & COT */}
              {activeBottomTab === "daily-digest" && (
                <>
                  <TabToolbar
                    title="Daily Digest & COT"
                    meta={<Badge tone="yellow">FR-10</Badge>}
                    actions={
                      <>
                        <ActionButton onClick={handleCopy} title="Copy markdown">
                          {copied ? (
                            <Check className="w-3 h-3 text-ex-blue" />
                          ) : (
                            <Copy className="w-3 h-3" />
                          )}
                          <span className="hidden sm:inline">
                            {copied ? "Copied" : "Copy MD"}
                          </span>
                        </ActionButton>
                        <ActionButton
                          onClick={handleDownloadDigestMd}
                          variant="primary"
                          title="Download markdown"
                        >
                          <Download className="w-3 h-3" />
                          <span className="hidden sm:inline">.md</span>
                        </ActionButton>
                      </>
                    }
                  />
                  <DockBody>
                    <div className="grid grid-cols-1 md:grid-cols-[minmax(0,18rem)_minmax(0,1fr)] gap-4">
                      {/* CFTC COT — data REAL. */}
                      <Section first label="CFTC COT Institutional Position">
                        {cotData ? (
                          <div>
                            <DataRow label="Non-commercial net" tone="blue" bold>
                              {cotData.netPosition > 0 ? "+" : ""}
                              {cotData.netPosition.toLocaleString()} longs
                            </DataRow>
                            <DataRow label="Weekly change" tone="blue" bold>
                              {cotData.changeNet > 0 ? "+" : ""}
                              {cotData.changeNet.toLocaleString()}
                            </DataRow>
                            <DataRow label="Report date">
                              {cotData.reportDate || "n/a"}
                            </DataRow>
                            <Footnote>
                              Posisi non-commercial emas dari laporan mingguan CFTC
                              (Commitments of Traders — Futures Only).
                            </Footnote>
                            <div className="mt-3">
                              <ActionButton
                                onClick={handleDownloadCotCsv}
                                title="Download COT CSV"
                              >
                                <FileSpreadsheet className="w-3.5 h-3.5 text-ex-yellow" />
                                COT CSV
                              </ActionButton>
                            </div>
                          </div>
                        ) : (
                          <EmptyNote>
                            Laporan CFTC tidak bisa diakses saat ini; angka tidak
                            ditampilkan.
                          </EmptyNote>
                        )}
                      </Section>

                      {/* Daily digest — markdown REAL dari API. */}
                      <Section
                        first
                        label="Quantitative Daily Market Digest"
                        className="md:border-t-0 md:mt-0 md:pt-0 md:border-l md:border-ex-border md:pl-4"
                        aside={
                          <FileText className="w-3.5 h-3.5 text-ex-yellow" />
                        }
                      >
                        {dailyDigestContent ? (
                          <div className="text-[11px] sm:text-xs font-mono whitespace-pre-wrap break-words leading-snug text-ex-text md:columns-2 md:gap-6">
                            {dailyDigestContent}
                          </div>
                        ) : (
                          <EmptyNote>
                            Menyiapkan laporan harian otomatis… (placeholder — belum
                            ada konten real sampai API reports/daily/latest merespons).
                          </EmptyNote>
                        )}
                      </Section>
                    </div>
                  </DockBody>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 5. BOTTOM STATUS STRIP — info institusional REAL, bukan equity/margin palsu. */}
      <footer className="h-7 shrink-0 border-t border-ex-border bg-ex-bg flex items-center justify-between gap-2 px-3 sm:px-4 text-[11px] font-mono text-ex-muted z-30 select-none">
        <div className="flex items-center gap-3 sm:gap-5 min-w-0">
          <span className="whitespace-nowrap text-ex-text">
            XAU/USD · {activeTf.toUpperCase()}
          </span>
          <span className="hidden md:inline whitespace-nowrap">
            Sumber: Deriv CFD · CSV historis
          </span>
          <span className="hidden lg:inline whitespace-nowrap text-ex-yellow">
            FR-10 · Riset Non-Advisory
          </span>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <span className="hidden sm:inline whitespace-nowrap">
            Model: {significance?.champion_name || "n/a"}
          </span>
          <span className="text-ex-text whitespace-nowrap">
            {currentTimeUtc || "--:--:-- UTC"}
          </span>
        </div>
      </footer>
    </div>
  );
}
