import { describe, it, expect } from "vitest";
import {
  calculateSurprise,
  calculateReactionWindows,
  aggregateEventStats,
} from "../src/index.js";
import type { OHLCV, EventReaction } from "@repo/types";

describe("Core Analytics: calculateSurprise", () => {
  it("calculates standardized surprise Z-score when forecast exists", () => {
    // CPI: Actual 0.4%, Forecast 0.3%, Historical stdDev 0.1
    const result = calculateSurprise(0.4, 0.3, 0.3, 0.1);
    expect(result.surpriseVal).toBe(0.1);
    expect(result.zScore).toBe(1.0);
    expect(result.isFallback).toBe(false);
  });

  it("uses fallback to previous when forecast is null", () => {
    // Actual 2.5%, Forecast null, Previous 2.0%, StdDev 0.5
    const result = calculateSurprise(2.5, null, 2.0, 0.5);
    expect(result.surpriseVal).toBe(0.5);
    expect(result.zScore).toBe(1.0);
    expect(result.isFallback).toBe(true);
  });
});

describe("Core Analytics: calculateReactionWindows", () => {
  const releaseTime = 1700000000;
  const mockCandles: OHLCV[] = [
    {
      symbol: "XAUUSD",
      timeframe: "1m",
      timestampUtc: releaseTime - 60,
      open: 2730,
      high: 2732,
      low: 2729,
      close: 2730,
      volume: 100,
    },
    {
      symbol: "XAUUSD",
      timeframe: "1m",
      timestampUtc: releaseTime,
      open: 2730,
      high: 2731,
      low: 2724,
      close: 2725,
      volume: 500,
    },
    {
      symbol: "XAUUSD",
      timeframe: "1m",
      timestampUtc: releaseTime + 300, // +5m
      open: 2725,
      high: 2727,
      low: 2722,
      close: 2723,
      volume: 300,
    },
    {
      symbol: "XAUUSD",
      timeframe: "1m",
      timestampUtc: releaseTime + 900, // +15m
      open: 2723,
      high: 2725,
      low: 2720,
      close: 2721,
      volume: 250,
    },
    {
      symbol: "XAUUSD",
      timeframe: "1m",
      timestampUtc: releaseTime + 1800, // +30m (retrace back to 2730)
      open: 2728,
      high: 2731,
      low: 2727,
      close: 2730.5,
      volume: 200,
    },
    {
      symbol: "XAUUSD",
      timeframe: "1m",
      timestampUtc: releaseTime + 3600, // +60m
      open: 2730.5,
      high: 2734,
      low: 2729,
      close: 2733,
      volume: 150,
    },
  ];

  it("calculates delta pips and detects retrace timing", () => {
    const reactions = calculateReactionWindows("test-rel-1", releaseTime, mockCandles, [5, 15, 60]);

    expect(reactions).toHaveLength(3);

    // +5m window: Base is 2730, end is 2723 -> -7 USD = -70 pips
    const r5m = reactions.find((r) => r.windowMinutes === 5);
    expect(r5m?.deltaPips).toBe(-70);
    expect(r5m?.basePrice).toBe(2730);

    // +15m window: Base 2730, end 2721 -> -9 USD = -90 pips
    const r15m = reactions.find((r) => r.windowMinutes === 15);
    expect(r15m?.deltaPips).toBe(-90);

    // Retrace check: touched 2730 at +30m
    expect(r5m?.isRetraced).toBe(true);
    expect(r5m?.retraceMinutes).toBe(30);
  });

  it("returns empty array when candles array is empty or null", () => {
    expect(calculateReactionWindows("test-empty", releaseTime, [])).toEqual([]);
    expect(calculateReactionWindows("test-null", releaseTime, null as any)).toEqual([]);
  });
});

describe("Core Analytics: aggregateEventStats", () => {
  const mockReactions: EventReaction[] = [
    {
      id: "1",
      releaseId: "r1",
      windowMinutes: 15,
      basePrice: 2700,
      endPrice: 2695,
      deltaPips: -50,
      maxSpikePips: 10,
      maxDrawdownPips: 55,
      isRetraced: true,
      retraceMinutes: 40,
    },
    {
      id: "2",
      releaseId: "r2",
      windowMinutes: 15,
      basePrice: 2710,
      endPrice: 2702,
      deltaPips: -80,
      maxSpikePips: 5,
      maxDrawdownPips: 85,
      isRetraced: false,
      retraceMinutes: null,
    },
    {
      id: "3",
      releaseId: "r3",
      windowMinutes: 15,
      basePrice: 2705,
      endPrice: 2703,
      deltaPips: -20,
      maxSpikePips: 12,
      maxDrawdownPips: 25,
      isRetraced: true,
      retraceMinutes: 30,
    },
  ];

  it("computes directional consistency and mean pips", () => {
    const stats = aggregateEventStats(mockReactions);
    expect(stats.totalReleases).toBe(3);
    expect(stats.meanDeltaPips).toBe(-50);
    expect(stats.medianDeltaPips).toBe(-50);
    expect(stats.directionalConsistency).toBe(100); // All 3 dropped
    expect(stats.negativeReactionsPct).toBe(100);
    expect(stats.avgRetraceMinutes).toBe(35); // (40 + 30) / 2
  });
});
