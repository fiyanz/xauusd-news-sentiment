/**
 * chart-viewport — module deep untuk geometri viewport chart.
 *
 * Interface kecil (VIEWPORT_CONFIG + 3 fungsi pure) menyembunyikan seluruh
 * aturan viewport: clamp saved-range ke data tersedia, preservasi lebar zoom,
 * ambang prepend history, dan konstanta debounce. Semua angka viewport hidup
 * di SATU sumber (VIEWPORT_CONFIG) — fix rightOffset 15->3 terlipat ke sini,
 * tidak diduplikasi di adapter render.
 *
 * Seam internal pure: tanpa DOM/network, teruji lewat interface yang sama
 * dengan pemanggil produksi (market-chart.tsx sebagai adapter render tipis).
 */

/** Konfigurasi viewport satu sumber untuk seluruh chart. */
export interface ViewportConfig {
  /** Margin kanan dalam bar setelah candle terakhir (fix gep: 3, bukan 15). */
  rightOffset: number;
  /** Lebar default satu bar (px) saat view default di-set. */
  barSpacing: number;
  /** Batas minimum zoom-out per bar (px). */
  minBarSpacing: number;
  /** Margin skala harga kanan saat pane volume tampil. */
  priceScaleMargins: { top: number; bottom: number };
  /** Margin skala harga kanan saat volume nihil (Deriv: semua 0). */
  priceScaleMarginsNoVolume: { top: number; bottom: number };
  /** Margin pane volume histogram (overlay bawah). */
  volumeScaleMargins: { top: number; bottom: number };
  /** Prepend history lama saat visibleRange.from < threshold (bar). */
  prependThreshold: number;
  /** Debounce persist view user ke localStorage (ms). */
  saveRangeDebounceMs: number;
  /** Jeda sebelum gate isReady aktif pasca data awal settle (ms). */
  readyDelayMs: number;
}

export const VIEWPORT_CONFIG: ViewportConfig = {
  rightOffset: 3,
  barSpacing: 12,
  minBarSpacing: 2,
  priceScaleMargins: { top: 0.1, bottom: 0.2 },
  priceScaleMarginsNoVolume: { top: 0.1, bottom: 0.05 },
  volumeScaleMargins: { top: 0.82, bottom: 0 },
  prependThreshold: 15,
  saveRangeDebounceMs: 120,
  readyDelayMs: 350,
};

/** Rentang logis lightweight-charts (index bar, boleh pecahan). */
export interface LogicalRange {
  from: number;
  to: number;
}

/**
 * Clamp rentang logis ke data yang tersedia dengan mempertahankan lebar zoom
 * (span). Tep kanan maxTo = candleCount - 1 + cfg.rightOffset — disamakan
 * dengan rightOffset supaya view tidak menyisakan "gep" margin kanan
 * berlebihan setelah candle terakhir. Bila span lebih lebar dari seluruh
 * data, from dilantai-kan ke 0 dan to dipotong maxTo.
 *
 * Null bila data kosong atau range degenerate/non-finite.
 */
export function clampRange(
  range: LogicalRange,
  candleCount: number,
  cfg: ViewportConfig = VIEWPORT_CONFIG
): LogicalRange | null {
  if (
    !Number.isFinite(range.from) ||
    !Number.isFinite(range.to) ||
    range.to <= range.from ||
    candleCount <= 0
  ) {
    return null;
  }

  const span = range.to - range.from;
  const maxTo = candleCount - 1 + cfg.rightOffset;
  const to = Math.min(range.to, maxTo);
  const from = to - span;
  if (from < 0) {
    return { from: 0, to: Math.min(span, maxTo) };
  }
  return { from, to };
}

/**
 * Restore view tersimpan (null-safe): validasi bentuk saved lalu clamp ke
 * data tersedia lewat clampRange. Null bila tidak ada yang bisa di-restore:
 * saved null/rusak, atau data kosong — pemanggil jatuh ke view default.
 */
export function restoreRange(
  saved: LogicalRange | null,
  candleCount: number,
  cfg: ViewportConfig = VIEWPORT_CONFIG
): LogicalRange | null {
  if (saved === null) return null;
  return clampRange(saved, candleCount, cfg);
}

/**
 * Apakah perlu fetch history lama: user scroll mendekati batas kiri
 * (visibleRange.from < threshold, strict). Range null -> false.
 * Guard efek samping (sedang fetch / history habis / data kosong) tetap
 * di adapter render — fungsi ini pure geometri.
 */
export function shouldPrepend(
  visibleRange: LogicalRange | null,
  threshold: number = VIEWPORT_CONFIG.prependThreshold
): boolean {
  if (visibleRange === null) return false;
  return visibleRange.from < threshold;
}
