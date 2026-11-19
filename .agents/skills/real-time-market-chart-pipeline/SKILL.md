---
name: real-time-market-chart-pipeline
description: "Use when streaming real-time market charts & pipelines."
version: 1.1.0
author: Hermes Agent
license: MIT
dependencies: []
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [financial, realtime, streaming, sse, websocket, tradingview, lightweight-charts, architecture]
---

# Real-Time Market Chart Pipeline & Persistence Skill

Guidelines and architectural patterns for ingesting high-frequency market tick feeds (50–100+ ticks/s), broadcasting low-latency updates to financial chart terminals, and persisting aggregated candles to database without write-amplification lockups.

## 1. Dual-Path Architecture (Hot Path vs Warm Path)

**Feed Provenance Gate (do this first):** before wiring a chart to a "live" endpoint, read the stream handler and confirm the payload comes from a real broker/provider feed. Server-side `Math.random()` walks labelled `isSimulated: true` are common in scaffolds and look identical to real ticks on the wire. Grep the ingestion handler for `Math.random`/`simulated`, and check the chart's data-source flag. Report the gap instead of building on top of it.

- **Timeframe support is provider-derived, not UI-derived:** expose only timeframes the live provider actually serves. Verify each granularity empirically — request `ticks_history` with `style: "candles"` and assert consecutive `epoch` diffs equal the requested granularity — before adding it to a chart switcher. Docs alone are not evidence. If the provider does not serve it, drop it from the UI; synthesizing it from another timeframe is allowed only as a labelled fallback (`estimated`), never presented as `real`.
- **Fallback sources keep their own label:** a candle API that reads DB-first and falls back to CSV must return the `source` of the path actually used. The chart must not re-map a CSV fallback onto a live/`real` label. Distinct provenance labels (`deriv-cfd` vs `csv-historical` vs `simulated` vs `estimated`) are a correctness requirement, not decoration.
- **Backfill deep history into the DB store, or "load previous data" silently fails.** A DB-first candles endpoint that falls back to CSV only when the DB returns ZERO rows for the requested window serves just the shallow live-provider window on initial load if the deep archive was never backfilled. The live worker persists only a recent provider window (`ticks_history` is bounded); the full history stays in CSV and is re-read slowly per scroll window — the opposite of "store in DB to speed up load". Seed the full historical archive into the candle table once, keep the worker appending live bars, and add a per-row `source` column so backfilled historical rows are not mislabeled as live (a DB-first handler that hardcodes `source: deriv-cfd` will lie about CSV-origin rows). Diagnose by querying the endpoint with and without `to`: initial load must span deep history, not just the provider's recent days; an older `to` window falling back to `csv-historical` proves the DB lacks that history.

Never execute database `INSERT` operations per individual tick; high-frequency ticks choke SQL connection pools and disk I/O. Decouple into two separate paths:

1. **Hot Path (Broadcast & Ephemeral Update < 10ms):**
   - Ingestion worker pushes incoming tick `{ symbol, bid, ask, last, volume, timestamp }` directly to an in-memory ring buffer (e.g., circular buffer of last 1,000 ticks).
   - Fastify/Express SSE or WebSocket gateway streams the delta tick payload immediately to connected clients.
   - Client canvas (e.g. Lightweight Charts) calls `candleSeries.update()`, updating only the single active forming candle bar at 60 FPS. Zero database read/write queries.

2. **Warm Path (Time-Bucket Rollup & Batch Persistence):**
   - In-memory time-bucket aggregator groups ticks into standard timeframes (M1, M5, H1, D1), maintaining current Open, High, Low, Close, Volume.
   - When a bar closes (or on a fixed 5–10 second throttle window), enqueue the completed candle into a write-behind buffer.
   - Flush batch updates via a single bulk `INSERT ... ON CONFLICT (symbol, timeframe, timestamp_utc) DO UPDATE` query. Reduces DB load by 99%.

3. **Cold Path (Windowed Pagination & Infinite Scroll):**
   - Initial load requests only the latest 200–250 bars (~35 KB), keeping initial render latency under 50ms and browser memory minimal.
   - Scrolling/panning into historical bars triggers lazy fetch `?to=<earliest_ts>&limit=200`, prepending older bars without resetting zoom.

4. **Crash Recovery & Gap Healing:**
   - Ingestion worker queries `SELECT MAX(timestamp_utc) FROM candles`.
   - On startup or reconnect after network interruption, fetch gap candles from the broker/market REST API between `MAX(timestamp_utc)` and current UTC before opening the live stream.

## 2. Memory-Safe Timeframe Subdivision & Windowing

- **Windowing Before Subdivision (Preventing Memory & CPU DoS):**
  - When interpolating or subdividing larger timeframe candles into smaller intraday bars (e.g. H1 to 15m or 5m), **never** run the subdivision algorithm across the entire historical archive (e.g., 97,000 H1 bars creating 1.17 million objects per request).
  - Compute the required parent window first: `requiredParentBars = Math.ceil(limit / subCount) + 5`.
  - Slice the parent series to the exact needed window *before* calling subdivision:
    `const windowedParent = rawH1.slice(-requiredParentBars); const targetSeries = subdivide(windowedParent);`
  - When paginating with a historical cutoff (`to`), locate the target index in the parent series via binary search first, slice the window, and only then subdivide.

## 3. Real-Time Candle Rollover & Streaming Mechanics

- **Timeframe Bucket Rollover:**
  - Streaming ticks must not indefinitely expand the high/low of an old bar. Calculate the active timeframe bucket timestamp:
    `currentBucketTime = Math.floor(tickTs / tfSec) * tfSec`.
  - If `currentBucketTime > lastCandleTs`, instantiate a **new candle bar**:
    `{ time: currentBucketTime, open: tick.price, high: tick.price, low: tick.price, close: tick.price, volume: 1 }`, push it to the dataset, and call `candleSeries.update()`.
  - If `currentBucketTime === lastCandleTs`, update the active bar's high, low, close, and volume.

## 4. Front-End Chart State & User Interaction Rules

- **User State Preservation vs Default Reset (Lightweight Charts & TradingView Canvas):**
  - **Capture Phase Is Mandatory**: TradingView / Lightweight Charts canvas elements call `event.stopPropagation()` on mouse and touch events. Standard bubbling listeners (`window.addEventListener('pointerdown', ...)` without capture) NEVER receive events, causing interaction tracking flags (`isUserTouched`) to remain false forever. Always attach listeners on the chart container and window with `{ capture: true, passive: true }` for `wheel`, `pointerdown`, `mousedown`, and `touchstart`.
  - **Lock Visible Range on Resize**: By default, Lightweight Charts recalculates and auto-fits time scales when the container element resizes or when DOM layout finishes. Always configure `timeScale: { lockVisibleTimeRangeOnResize: true, ... }` in chart options to prevent layout passes from resetting user zoom.
- **Flex min-height pinning (root cause of "chart sering kepotong")**: Lightweight Charts writes an inline `width/height` px onto its wrapper. In a `flex-col` layout, every ancestor flex item defaults to `min-height:auto` (= content min-size), so the chart's own inline height pins the container and the container can never shrink — the ResizeObserver never fires, the chart keeps the largest size it ever had, and shorter windows clip the price/time scale or squash header/footer. Fix: `min-h-0` on EVERY flex ancestor of the canvas container (workspace, chart wrapper, chart area) and on the canvas container itself; never use a fixed `min-h-[350px]` there. Header/toolbar/footer get `shrink-0` so only the chart absorbs shrinking. Use `chart.resize(Math.round(w), Math.round(h))` in the ResizeObserver and guard `w>0 && h>0`.
- **Overlay series must not steal autoscale**: a prediction/target line series on the right price scale participates in autoscale by default; a target far from the running price squashes candles into a thin band with dead space. Set `autoscaleInfoProvider: () => null` on overlay line series so candles autoscale to their own range.
- **Headless verification quirk**: in headless Chrome driven over CDP, ResizeObserver callbacks and rAF only run when a frame is produced — a viewport change alone may leave the chart at its old size. Force a frame (screenshot / `HeadlessExperimental.beginFrame`) after every resize before probing canvas bounds, or you will misread a stale canvas as a layout bug. Synthetic touch pan tests must dispatch touchstart/touchmove/touchend asynchronously (~40ms apart, moves on `document.documentElement`); a synchronous burst is ignored by Lightweight Charts' touch tracking.
  - **Decoupled Ready Gate & Frame Scheduling**: Initial programmatic calls (`setData()`, `fitContent()`) emit timescale range change events that overwrite saved positions in `localStorage` with unconfigured defaults if saved blindly. Guard the persistence listener with both user interaction and an `isReadyRef` gate that activates 300ms after initial candles settle.
  - **Asynchronous Range Restoration**: When restoring saved views (`{ from, to }`) on page refresh, wrap `setVisibleLogicalRange` in `requestAnimationFrame(() => ...)` to ensure the series layout coordinates have fully settled following `setData()`.
  - **Independent Timeframe State**: Persist and restore zoom/pan independently per timeframe key (e.g., `chart_range_1h`, `chart_range_15m`). Never combine `setVisibleLogicalRange` with `applyOptions({ barSpacing })` in the same tick as they conflict internally.

- **De-Cloning & Visual Anti-Slop:**
  - When taking inspiration from reference trading UIs (e.g., Exness, TradingView), never clone vendor brand names, trademarks, or attribution logos into the customer-facing interface. Hide library attribution badges (e.g. `#tv-attr-logo`) via CSS.
  - Use clean, neutral institutional branding (e.g., `XAU/USD INTELLIGENCE TERMINAL`).
  - Discard raw emoji text symbols (┼, ╱, ∿, 🖌, T, ☺, 📏) on toolbars; replace them with theme-consistent SVG vector icons (e.g. `lucide-react`).

## 5. Security & Concurrency Controls for Market Daemons

- **Atomic Mutex for Heavy Ingestion / Training Pipelines:**
  - Heavy background pipelines (e.g. `/api/v1/pipeline/sync`) that download external feeds or train ML models must enforce an atomic concurrency lock (`let isSyncRunning = false;`).
  - Return HTTP 409 Conflict immediately if a sync request is already executing. Reset the lock only on process `exit` or `error`.
  - Do NOT invoke scheduled scraping at high frequencies (<1 minute) with `setInterval`. Use self-scheduling `setTimeout` chains with a minimum 5-minute cooldown to prevent stacking parallel jobs and getting IP-banned by market data providers (e.g. Yahoo Finance HTTP 429).

- **Defensive Numeric & Array Edge Cases:**
  - In `/latest` candle endpoints, always guard with `if (!candles || candles.length === 0)` before indexing `candles[candles.length - 1]`. Never use non-null assertion (`!`) that triggers unhandled `TypeError`.
  - In volatility-relative confidence calculations, always append an epsilon (`vol_pre * 1.5 + 1e-8`) to prevent `ZeroDivisionError` on flat holiday candles.
  - In quantitative reaction window calculations, return an empty array immediately when price candles are missing. Never hardcode an arbitrary static fallback price (e.g., 2700), as market regime changes will calculate massive false delta pips.

## 6. Documentation & Server Lifecycle Conventions

- **Architecture Deliverables as Markdown:**
  - Deliver pipeline and architectural specifications as clean, structured Markdown (`.md`) files in `docs/` rather than standalone `.html` files, unless interactive HTML visualization is explicitly requested.
- **Background Service Persistence:**
  - In terminal tooling, always launch persistent backend daemons and dev servers with `persist_on_release: true` so they survive turn boundaries and session compression.
- **Timestamp Audit Against Current UTC:**
  - Static historical archives often end at an arbitrary cutoff (e.g., end of prior quarter/month).
  - Verify the latest candle timestamp against `now(UTC)`. If a gap exists, automatically bridge missing candles using live market APIs (`yfinance` or broker feed) before rendering charts.

## References

- `references/market-data-sources.md` — Deriv public WebSocket for XAU/USD (`frxXAUUSD`, `ticks`/`ohlc`, app_id auth) and its CFD-vs-spot caveats.
