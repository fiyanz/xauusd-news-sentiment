/**
 * candle-store — modul deep jalur tulis price_candles (satu tempat untuk
 * konvensi id, batching, kebijakan konflik, dan guard provenance).
 *
 * Sebelumnya tiga jalur tulis (worker step-1, gap-service, backfill-csv)
 * masing-masing merakit id `XAUUSD_<tf>_<ts>` + kebijakan konflik sendiri,
 * dan CSV/sintetis bisa menimpa baris Deriv recent. Modul ini menyembunyikan
 * semua itu di belakang interface kecil:
 *
 *   upsertPriceCandles(rows, conflictPolicy) + getMaxTimestamp(tf, source?)
 *
 * Caller (gap-service/backfill/worker) tidak perlu tahu konvensi id, ukuran
 * batch, maupun aturan prioritas provenance — cukup pilih kebijakan konflik.
 *
 * Seam: CandleStorePort. Produksi = adapter drizzle/TiDB (candle-gap-service),
 * tes = adapter in-memory (test/candle-store.test.ts). Modul ini murni tanpa
 * I/O supaya teruji lewat interface yang sama dengan yang dipakai produksi.
 */
import type { StoredCandleRow, CandleProvenance } from "@repo/financial-clients";

/**
 * Kebijakan konflik pada id yang sama:
 * - "refresh": perbarui OHLCV+source baris yang sudah ada (hanya untuk baris
 *   deriv-cfd; lihat guard provenance di bawah).
 * - "skip-existing": lewati baris yang sudah ada (backfill CSV idempotent;
 *   baris Deriv recent MENANG, tidak ditimpa).
 */
export type CandleConflictPolicy = "refresh" | "skip-existing";

/** Baris tersimpan lengkap dengan id primary key (konvensi modul). */
export type StoredCandleWithId = StoredCandleRow & { id: string };

/**
 * Port DB (seam). insertBatch menjalankan SATU batch insert dengan semantik
 * konflik SQL mentah sesuai policy; maxTimestamp = MAX(timestamp_utc) per tf,
 * opsional difilter satu source provenance (null = semua source).
 */
export interface CandleStorePort {
  insertBatch(rows: StoredCandleWithId[], policy: CandleConflictPolicy): Promise<void>;
  maxTimestamp(tf: string, source: CandleProvenance | null): Promise<number | null>;
}

export interface CandleStore {
  /**
   * Upsert baris candle (tanpa id — modul yang membangun id). Mengembalikan
   * jumlah baris yang dikirim. Baris kosong = noop.
   */
  upsertPriceCandles(rows: StoredCandleRow[], policy: CandleConflictPolicy): Promise<number>;
  /**
   * MAX(timestamp_utc) untuk satu timeframe; null bila belum ada baris.
   * `source` memfilter provenance — gap-healing Deriv wajib memakai
   * "deriv-cfd" supaya baris CSV/sintetis tidak menciptakan "no-gap" palsu.
   */
  getMaxTimestamp(tf: string, source?: CandleProvenance): Promise<number | null>;
}

/** Bangun id primary key kanonik price_candles dari isi baris. */
function candleId(r: StoredCandleRow): string {
  return `${r.symbol}_${r.timeframe}_${r.timestampUtc}`;
}

/** Ukuran batch insert aman untuk gateway TiDB (1000 memicu CONNECTION_CLOSED). */
const BATCH_SIZE = 500;

export function createCandleStore(port: CandleStorePort): CandleStore {
  /** Kirim satu kelompok kebijakan dalam potongan <= BATCH_SIZE baris. */
  async function flush(rows: StoredCandleWithId[], policy: CandleConflictPolicy): Promise<void> {
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      await port.insertBatch(rows.slice(i, i + BATCH_SIZE), policy);
    }
  }

  return {
    async upsertPriceCandles(rows, policy) {
      if (rows.length === 0) return 0;
      const withId = rows.map((r) => ({ ...r, id: candleId(r) }));
      // Guard provenance: hanya deriv-cfd yang boleh menimpa baris lama
      // (refresh). CSV/sintetis SELALU skip-existing — 15m/30m Deriv-only,
      // baris Deriv recent tidak boleh di-downgrade sumber lain.
      const refreshRows =
        policy === "refresh" ? withId.filter((r) => r.source === "deriv-cfd") : [];
      const skipRows =
        policy === "refresh" ? withId.filter((r) => r.source !== "deriv-cfd") : withId;
      await flush(refreshRows, "refresh");
      await flush(skipRows, "skip-existing");
      return rows.length;
    },
    async getMaxTimestamp(tf, source) {
      return port.maxTimestamp(tf, source ?? null);
    },
  };
}