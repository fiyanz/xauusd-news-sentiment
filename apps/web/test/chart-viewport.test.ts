/**
 * Tes chart-viewport DI INTERFACE (restoreRange / clampRange / shouldPrepend +
 * VIEWPORT_CONFIG) — seam pure yang sama dengan pemanggil produksi
 * (market-chart.tsx). Tanpa DOM/network: geometri viewport teruji lewat
 * interface, bukan lewat internal komponen.
 */
import { describe, it, expect } from "vitest";
import { restoreRange, clampRange, shouldPrepend, VIEWPORT_CONFIG } from "../src/lib/chart-viewport";

describe("restoreRange", () => {
  it("saved null -> null (tidak ada view tersimpan, jangan restore)", () => {
    expect(restoreRange(null, 250)).toBeNull();
  });

  it("saved.to melewati data -> clamp ke candleCount-1+rightOffset (3), bukan sisa gep 15 bar", () => {
    // maxTo = 250 - 1 + 3 = 252; span 1000 lebih lebar dari seluruh data
    // -> from mentok 0, to = min(span, maxTo) = 252.
    const result = restoreRange({ from: 9000, to: 10000 }, 250);
    expect(result).toEqual({ from: 0, to: 252 });
  });

  it("clamp mempertahankan lebar zoom (span) pengguna", () => {
    // saved {140, 260} span 120; maxTo 252 -> to 252, from 132 (span tetap 120).
    const result = restoreRange({ from: 140, to: 260 }, 250);
    expect(result).toEqual({ from: 132, to: 252 });
    expect(result!.to - result!.from).toBe(120);
  });

  it("saved di dalam data -> dikembalikan apa adanya", () => {
    expect(restoreRange({ from: 10, to: 110 }, 250)).toEqual({ from: 10, to: 110 });
  });

  it("from negatif setelah clamp -> lantai 0, to disesuaikan span (perilaku lama)", () => {
    // saved {-50, 50} span 100 -> to 50, from -50 < 0 -> from 0, to min(100, 252) = 100.
    expect(restoreRange({ from: -50, to: 50 }, 250)).toEqual({ from: 0, to: 100 });
  });

  it("saved rusak (to <= from) -> null, jangan restore view degenerate", () => {
    expect(restoreRange({ from: 100, to: 100 }, 250)).toBeNull();
    expect(restoreRange({ from: 120, to: 80 }, 250)).toBeNull();
  });

  it("saved non-finite (NaN/Infinity dari JSON rusak) -> null", () => {
    expect(restoreRange({ from: NaN, to: 100 }, 250)).toBeNull();
    expect(restoreRange({ from: 0, to: Infinity }, 250)).toBeNull();
  });

  it("candleCount 0 (data kosong) -> null", () => {
    expect(restoreRange({ from: 0, to: 100 }, 0)).toBeNull();
  });

  it("maxTo ikut cfg.rightOffset — satu sumber config, bukan angka ajaib duplikat", () => {
    // cfg custom rightOffset 5 -> maxTo = 100 - 1 + 5 = 104; span 100 -> from 4.
    const cfg = { ...VIEWPORT_CONFIG, rightOffset: 5 };
    expect(restoreRange({ from: 90, to: 190 }, 100, cfg)).toEqual({ from: 4, to: 104 });
    // Default repo: rightOffset 3 (fix gep 15->3 terlipat ke sini).
    expect(VIEWPORT_CONFIG.rightOffset).toBe(3);
    expect(restoreRange({ from: 90, to: 190 }, 100)).toEqual({ from: 2, to: 102 });
  });
});

describe("clampRange", () => {
  it("range melewati tepi kanan -> clamp ke candleCount-1+rightOffset, span tetap", () => {
    expect(clampRange({ from: 140, to: 260 }, 250)).toEqual({ from: 132, to: 252 });
  });

  it("range di dalam data -> tidak berubah", () => {
    expect(clampRange({ from: 10, to: 110 }, 250)).toEqual({ from: 10, to: 110 });
  });

  it("from negatif -> lantai 0, to dipotong span bila lebih lebar dari data", () => {
    expect(clampRange({ from: -50, to: 50 }, 250)).toEqual({ from: 0, to: 100 });
    expect(clampRange({ from: -900, to: 100 }, 250)).toEqual({ from: 0, to: 252 });
  });

  it("data kosong atau range degenerate/non-finite -> null", () => {
    expect(clampRange({ from: 0, to: 100 }, 0)).toBeNull();
    expect(clampRange({ from: 100, to: 100 }, 250)).toBeNull();
    expect(clampRange({ from: 0, to: NaN }, 250)).toBeNull();
  });

  it("tep kanan ikut cfg.rightOffset (leverage satu sumber config)", () => {
    const cfg = { ...VIEWPORT_CONFIG, rightOffset: 7 };
    expect(clampRange({ from: 0, to: 999 }, 100, cfg)).toEqual({ from: 0, to: 106 });
  });
});

describe("shouldPrepend", () => {
  it("from di bawah threshold -> true (user mendekati batas kiri, fetch history lama)", () => {
    expect(shouldPrepend({ from: 0, to: 100 }, 15)).toBe(true);
    expect(shouldPrepend({ from: 14.9, to: 120 }, 15)).toBe(true);
  });

  it("from tepat di threshold atau di atasnya -> false (strict <, bukan <=)", () => {
    expect(shouldPrepend({ from: 15, to: 120 }, 15)).toBe(false);
    expect(shouldPrepend({ from: 16, to: 120 }, 15)).toBe(false);
  });

  it("range null (chart belum punya view) -> false", () => {
    expect(shouldPrepend(null, 15)).toBe(false);
  });

  it("default threshold = VIEWPORT_CONFIG.prependThreshold (15)", () => {
    expect(VIEWPORT_CONFIG.prependThreshold).toBe(15);
    expect(shouldPrepend({ from: 10, to: 100 })).toBe(true);
    expect(shouldPrepend({ from: 20, to: 100 })).toBe(false);
  });
});
