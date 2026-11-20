import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BATCH_SIZE,
  dedupeRows,
  ingestNewsCorpus,
  parseArticleLine,
  parseTopics,
  toBatches,
  toWatermark,
  topicsToJson,
  type NewsRow,
} from "../src/news-db.js";

// Guard hermetik: arahkan cwd/REPO_ROOT ke direktori kosong supaya bila ports
// diabaikan (kode lama), ingest TIDAK membaca corpus asli atau menyentuh TiDB.
let prevCwd = "";
let prevRepoRoot: string | undefined;
let emptyDir = "";
beforeAll(() => {
  prevCwd = process.cwd();
  prevRepoRoot = process.env.REPO_ROOT;
  emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "news-db-test-"));
  process.env.REPO_ROOT = emptyDir;
  process.chdir(emptyDir);
});
afterAll(() => {
  process.chdir(prevCwd);
  if (prevRepoRoot === undefined) delete process.env.REPO_ROOT;
  else process.env.REPO_ROOT = prevRepoRoot;
  fs.rmSync(emptyDir, { recursive: true, force: true });
});

/** Factory row minimal untuk tes seam pure (field wajib saja, sisanya null). */
function makeRow(id: string, url: string, published = "2025-06-01T12:00:00Z"): NewsRow {
  return {
    id,
    url,
    title: `Judul ${id}`,
    summary: null,
    publisher: null,
    sourceFeed: null,
    timePublishedUtc: new Date(published),
    sentimentScore: null,
    sentimentLabel: null,
    sentimentLm: null,
    topics: null,
  };
}

// Kontrak bersama: kolom topics = JSON string. Worker menulis (topicsToJson),
// API membaca (parseTopics). Round-trip dites di sini supaya kontrak tidak
// dibelah manual lagi saat integrasi.
describe("topics encode/decode (kontrak JSON string worker <-> api)", () => {
  it("round-trip: array topics -> JSON string -> array utuh", () => {
    const topics = ["commodities", "forex", "gold"];
    expect(parseTopics(topicsToJson(topics))).toEqual(topics);
  });

  it("round-trip: array kosong tetap array kosong (bukan null)", () => {
    expect(parseTopics(topicsToJson([]))).toEqual([]);
  });

  it("topicsToJson: string non-kosong diteruskan apa adanya (sudah JSON)", () => {
    expect(topicsToJson('["forex"]')).toBe('["forex"]');
  });

  it("topicsToJson: bukan array/string non-kosong -> null", () => {
    expect(topicsToJson(null)).toBeNull();
    expect(topicsToJson(undefined)).toBeNull();
    expect(topicsToJson("")).toBeNull();
    expect(topicsToJson(42)).toBeNull();
    expect(topicsToJson({ a: 1 })).toBeNull();
  });

  it("parseTopics: null/empty -> null (kolom kosong)", () => {
    expect(parseTopics(null)).toBeNull();
    expect(parseTopics("")).toBeNull();
  });

  it("parseTopics: JSON rusak -> null, bukan lempar error", () => {
    expect(parseTopics("[rusak")).toBeNull();
  });

  it("parseTopics: JSON valid tapi bukan array -> null", () => {
    expect(parseTopics('{"a":1}')).toBeNull();
    expect(parseTopics('"forex"')).toBeNull();
  });
});

// Seam pure: baris JSONL corpus -> row siap insert (validasi field wajib).
// Tanpa I/O — bisa dites langsung tanpa TiDB.
describe("parseArticleLine (baris corpus -> row)", () => {
  const validLine = JSON.stringify({
    id: "hf:abc123",
    url: "https://contoh.test/berita-1",
    title: "Emas naik",
    summary: "Ringkasan",
    publisher: "webmaster",
    source_feed: "hf_financial_news",
    time_published_utc: "2025-06-01 12:00:00+00:00",
    overall_sentiment_score: 0.25,
    overall_sentiment_label: "Positive",
    sentiment_lm: 0.5,
    topics: ["commodities", "gold"],
  });

  it("baris valid -> row camelCase dengan Date dan topics JSON string", () => {
    const row = parseArticleLine(validLine);
    expect(row).toEqual({
      id: "hf:abc123",
      url: "https://contoh.test/berita-1",
      title: "Emas naik",
      summary: "Ringkasan",
      publisher: "webmaster",
      sourceFeed: "hf_financial_news",
      timePublishedUtc: new Date("2025-06-01T12:00:00+00:00"),
      sentimentScore: 0.25,
      sentimentLabel: "Positive",
      sentimentLm: 0.5,
      topics: '["commodities","gold"]',
    });
  });

  it("waktu format ISO 8601 (dengan T) juga diterima", () => {
    const line = JSON.stringify({
      id: "x1",
      url: "https://contoh.test/x1",
      title: "Judul",
      time_published_utc: "2025-06-01T12:00:00Z",
    });
    expect(parseArticleLine(line)?.timePublishedUtc).toEqual(new Date("2025-06-01T12:00:00Z"));
  });

  it("field wajib kurang (id/url/title/waktu) -> null", () => {
    for (const field of ["id", "url", "title", "time_published_utc"]) {
      const article = JSON.parse(validLine) as Record<string, unknown>;
      delete article[field];
      expect(parseArticleLine(JSON.stringify(article))).toBeNull();
    }
  });

  it("waktu tidak valid -> null (bukan waktu karangan)", () => {
    const article = JSON.parse(validLine) as Record<string, unknown>;
    article.time_published_utc = "bukan-tanggal";
    expect(parseArticleLine(JSON.stringify(article))).toBeNull();
  });

  it("JSON rusak -> null, bukan lempar error", () => {
    expect(parseArticleLine("{rusak")).toBeNull();
  });

  it("field opsional kosong/invalid -> null di row, baris tetap valid", () => {
    const line = JSON.stringify({
      id: "x2",
      url: "https://contoh.test/x2",
      title: "Judul",
      time_published_utc: "2025-06-01 12:00:00+00:00",
      summary: "",
      overall_sentiment_score: "bukan-angka",
      topics: null,
    });
    const row = parseArticleLine(line);
    expect(row).not.toBeNull();
    expect(row?.summary).toBeNull();
    expect(row?.publisher).toBeNull();
    expect(row?.sentimentScore).toBeNull();
    expect(row?.topics).toBeNull();
  });
});

// Seam pure: normalisasi watermark. Quirk postgres-js: aggregate max() lewat
// sql`` kembali sebagai STRING, bukan Date — wajib dikonversi sebelum getTime().
describe("toWatermark (normalisasi max(time_published_utc))", () => {
  it("string dari postgres-js -> Date valid (tidak crash saat re-run)", () => {
    const wm = toWatermark("2025-06-01 12:00:00+00");
    expect(wm).toBeInstanceOf(Date);
    expect(wm?.getTime()).toBe(new Date("2025-06-01T12:00:00Z").getTime());
  });

  it("Date diteruskan sebagai Date setara", () => {
    const d = new Date("2025-06-01T12:00:00Z");
    expect(toWatermark(d)?.getTime()).toBe(d.getTime());
  });

  it("null/undefined (DB kosong) -> null = ingest penuh", () => {
    expect(toWatermark(null)).toBeNull();
    expect(toWatermark(undefined)).toBeNull();
  });

  it("string tidak valid -> null, bukan Date Invalid", () => {
    expect(toWatermark("bukan-tanggal")).toBeNull();
    expect(toWatermark("")).toBeNull();
  });
});

// Seam pure: dedup url + id (corpus nyata punya 582 id kembar dengan url
// berbeda). First-wins: kemunculan pertama dipertahankan, urutan terjaga.
describe("dedupeRows (url + id, first-wins)", () => {
  it("id kembar dengan url berbeda -> hanya yang pertama (kasus 582 id hf)", () => {
    const rows = [
      makeRow("hf:dup", "https://contoh.test/a"),
      makeRow("hf:dup", "https://contoh.test/b"),
      makeRow("hf:unik", "https://contoh.test/c"),
    ];
    expect(dedupeRows(rows)).toEqual([rows[0], rows[2]]);
  });

  it("url kembar dengan id berbeda -> hanya yang pertama", () => {
    const rows = [
      makeRow("id-1", "https://contoh.test/sama"),
      makeRow("id-2", "https://contoh.test/sama"),
    ];
    expect(dedupeRows(rows)).toEqual([rows[0]]);
  });

  it("tanpa duplikat -> semua row, urutan asli terjaga", () => {
    const rows = [
      makeRow("a", "https://contoh.test/a"),
      makeRow("b", "https://contoh.test/b"),
      makeRow("c", "https://contoh.test/c"),
    ];
    expect(dedupeRows(rows)).toEqual(rows);
  });

  it("array kosong -> array kosong", () => {
    expect(dedupeRows([])).toEqual([]);
  });

  it("tidak memutasi array input", () => {
    const rows = [makeRow("x", "https://contoh.test/x"), makeRow("x", "https://contoh.test/y")];
    dedupeRows(rows);
    expect(rows).toHaveLength(2);
  });
});

// Seam pure: pecah row menjadi batch insert. TiDB Cloud menutup koneksi bila
// statement multi-row terlalu besar — 200 baris aman, 1000 terlalu besar.
describe("toBatches (batch insert aman untuk gateway TiDB)", () => {
  it("BATCH_SIZE kontrak = 200", () => {
    expect(BATCH_SIZE).toBe(200);
  });

  it("450 row -> batch [200, 200, 50], urutan terjaga", () => {
    const rows = Array.from({ length: 450 }, (_, i) => makeRow(`id-${i}`, `https://contoh.test/${i}`));
    const batches = toBatches(rows);
    expect(batches.map((b) => b.length)).toEqual([200, 200, 50]);
    expect(batches.flat()).toEqual(rows);
  });

  it("tepat 200 row -> satu batch utuh", () => {
    const rows = Array.from({ length: 200 }, (_, i) => makeRow(`id-${i}`, `https://contoh.test/${i}`));
    expect(toBatches(rows).map((b) => b.length)).toEqual([200]);
  });

  it("0 row -> tidak ada batch (insert tidak dipanggil)", () => {
    expect(toBatches([])).toEqual([]);
  });

  it("ukuran batch bisa dioverride untuk tes adapter", () => {
    const rows = Array.from({ length: 5 }, (_, i) => makeRow(`id-${i}`, `https://contoh.test/${i}`));
    expect(toBatches(rows, 2).map((b) => b.length)).toEqual([2, 2, 1]);
  });
});

/** Adapter in-memory untuk seam reader: corpus JSONL dari string, tanpa fs. */
function memoryReader(content: string | null) {
  return { readCorpus: () => content };
}

/** Adapter in-memory untuk seam store: meniru kontrak TiDB —
 * ON CONFLICT DO NOTHING mencakup unique url DAN primary key id,
 * dan max() watermark dikembalikan sebagai STRING (quirk postgres-js). */
function memoryStore(initialWatermark: string | Date | null = null) {
  const byId = new Map<string, NewsRow>();
  const urls = new Set<string>();
  const batches: NewsRow[][] = [];
  let watermark: string | Date | null = initialWatermark;
  let watermarkReads = 0;
  return {
    batches,
    byId,
    get watermarkReads() {
      return watermarkReads;
    },
    store: {
      readWatermark: async () => {
        watermarkReads++;
        return watermark;
      },
      insertBatch: async (rows: NewsRow[]) => {
        batches.push(rows);
        let inserted = 0;
        for (const row of rows) {
          if (byId.has(row.id) || urls.has(row.url)) continue; // conflict id/url
          byId.set(row.id, row);
          urls.add(row.url);
          inserted++;
        }
        if (byId.size > 0) {
          const maxMs = Math.max(...[...byId.values()].map((r) => r.timePublishedUtc.getTime()));
          // Format teks timestamptz postgres: "YYYY-MM-DD HH:MM:SS+00".
          watermark = new Date(maxMs).toISOString().replace("T", " ").replace("Z", "+00");
        }
        return inserted;
      },
    },
  };
}

/** Satu baris corpus valid untuk tes interface. */
function corpusLine(id: string, url: string, published: string): string {
  return JSON.stringify({
    id,
    url,
    title: `Judul ${id}`,
    time_published_utc: published,
    topics: ["gold"],
  });
}

// Interface ingestCorpus dengan adapter in-memory — TANPA TiDB, tanpa fs.
// Call no-arg tetap memakai adapter produksi (fs + drizzle); di sini ports
// opsional disuntik supaya seluruh perilaku bisa dites lewat interface yang sama.
describe("ingestNewsCorpus lewat ports in-memory", () => {
  it("corpus valid masuk semua lewat store, skipped 0", async () => {
    const content = [
      corpusLine("a", "https://contoh.test/a", "2025-06-01 10:00:00+00:00"),
      "", // baris kosong dilewati tanpa dihitung skipped
      corpusLine("b", "https://contoh.test/b", "2025-06-02 10:00:00+00:00"),
    ].join("\n");
    const mem = memoryStore();
    const result = await ingestNewsCorpus({ reader: memoryReader(content), store: mem.store });
    expect(result).toEqual({ inserted: 2, skipped: 0 });
    expect(mem.byId.size).toBe(2);
    expect(mem.batches).toHaveLength(1);
    expect(mem.byId.get("a")?.topics).toBe('["gold"]');
  });

  it("re-run idempotent: 0 artikel baru, watermark maju sebagai string", async () => {
    const content = [
      corpusLine("a", "https://contoh.test/a", "2025-06-01 10:00:00+00:00"),
      corpusLine("b", "https://contoh.test/b", "2025-06-02 10:00:00+00:00"),
    ].join("\n");
    const mem = memoryStore();
    const ports = { reader: memoryReader(content), store: mem.store };

    const first = await ingestNewsCorpus(ports);
    expect(first.inserted).toBe(2);
    // Watermark maju dan bertipe string (quirk postgres-js) — tidak crash saat re-run.
    const wm = await mem.store.readWatermark();
    expect(typeof wm).toBe("string");

    const second = await ingestNewsCorpus(ports);
    expect(second.inserted).toBe(0);
    expect(mem.byId.size).toBe(2); // tidak ada baris ganda
  });
});

// Regresi refactor: perilaku lama dikunci lewat interface yang sama (ports),
// tetap tanpa TiDB. Ini mengunci kontrak, bukan menambah perilaku baru.
describe("perilaku ingest lewat interface (regresi refactor)", () => {
  it("watermark STRING postgres-js: artikel lama dilewati, >= watermark masuk", async () => {
    const content = [
      corpusLine("lama", "https://contoh.test/lama", "2025-06-01 00:00:00+00:00"),
      corpusLine("sama", "https://contoh.test/sama", "2025-06-02 00:00:00+00:00"),
      corpusLine("baru", "https://contoh.test/baru", "2025-06-03 00:00:00+00:00"),
    ].join("\n");
    const mem = memoryStore("2025-06-02 00:00:00+00"); // quirk: max() = string
    const result = await ingestNewsCorpus({ reader: memoryReader(content), store: mem.store });
    expect(result).toEqual({ inserted: 2, skipped: 1 });
    expect([...mem.byId.keys()]).toEqual(["sama", "baru"]);
  });

  it("watermark Date instance juga difilter benar", async () => {
    const content = [
      corpusLine("lama", "https://contoh.test/lama", "2025-06-01 00:00:00+00:00"),
      corpusLine("baru", "https://contoh.test/baru", "2025-06-03 00:00:00+00:00"),
    ].join("\n");
    const mem = memoryStore(new Date("2025-06-02T00:00:00Z"));
    const result = await ingestNewsCorpus({ reader: memoryReader(content), store: mem.store });
    expect(result).toEqual({ inserted: 1, skipped: 1 });
  });

  it("watermark tidak valid -> ingest penuh tanpa crash", async () => {
    const content = corpusLine("a", "https://contoh.test/a", "2025-06-01 00:00:00+00:00");
    const mem = memoryStore("bukan-tanggal");
    const result = await ingestNewsCorpus({ reader: memoryReader(content), store: mem.store });
    expect(result).toEqual({ inserted: 1, skipped: 0 });
  });

  it("id kembar url berbeda (kasus 582): first-wins, sisanya skipped", async () => {
    const content = [
      corpusLine("hf:dup", "https://contoh.test/a", "2025-06-01 00:00:00+00:00"),
      corpusLine("hf:dup", "https://contoh.test/b", "2025-06-02 00:00:00+00:00"),
      corpusLine("hf:unik", "https://contoh.test/c", "2025-06-03 00:00:00+00:00"),
    ].join("\n");
    const mem = memoryStore();
    const result = await ingestNewsCorpus({ reader: memoryReader(content), store: mem.store });
    expect(result).toEqual({ inserted: 2, skipped: 1 });
    expect(mem.byId.get("hf:dup")?.url).toBe("https://contoh.test/a");
  });

  it("url kembar id berbeda: first-wins, sisanya skipped", async () => {
    const content = [
      corpusLine("id-1", "https://contoh.test/sama", "2025-06-01 00:00:00+00:00"),
      corpusLine("id-2", "https://contoh.test/sama", "2025-06-02 00:00:00+00:00"),
    ].join("\n");
    const mem = memoryStore();
    const result = await ingestNewsCorpus({ reader: memoryReader(content), store: mem.store });
    expect(result).toEqual({ inserted: 1, skipped: 1 });
  });

  it("450 artikel unik -> store menerima batch [200, 200, 50]", async () => {
    const lines = Array.from({ length: 450 }, (_, i) =>
      corpusLine(`id-${i}`, `https://contoh.test/${i}`, "2025-06-01 00:00:00+00:00")
    );
    const mem = memoryStore();
    const result = await ingestNewsCorpus({ reader: memoryReader(lines.join("\n")), store: mem.store });
    expect(result.inserted).toBe(450);
    expect(mem.batches.map((b) => b.length)).toEqual([200, 200, 50]);
    expect(mem.batches.every((b) => b.length <= BATCH_SIZE)).toBe(true);
  });

  it("corpus tidak ditemukan (reader null) -> {0,0}, store tidak disentuh", async () => {
    const mem = memoryStore();
    const result = await ingestNewsCorpus({ reader: memoryReader(null), store: mem.store });
    expect(result).toEqual({ inserted: 0, skipped: 0 });
    expect(mem.watermarkReads).toBe(0);
    expect(mem.batches).toHaveLength(0);
  });

  it("baris rusak + field wajib kurang dihitung skipped, yang valid tetap masuk", async () => {
    const content = [
      "{json-rusak",
      JSON.stringify({ id: "tanpa-judul", url: "https://contoh.test/x", time_published_utc: "2025-06-01 00:00:00+00:00" }),
      corpusLine("valid", "https://contoh.test/valid", "2025-06-01 00:00:00+00:00"),
    ].join("\n");
    const mem = memoryStore();
    const result = await ingestNewsCorpus({ reader: memoryReader(content), store: mem.store });
    expect(result).toEqual({ inserted: 1, skipped: 2 });
  });

  it("conflict di store tidak dihitung inserted maupun skipped (semantik returning())", async () => {
    const mem = memoryStore();
    const corpus1 = [
      corpusLine("a", "https://contoh.test/a", "2025-06-01 00:00:00+00:00"),
      corpusLine("b", "https://contoh.test/b", "2025-06-02 00:00:00+00:00"),
    ].join("\n");
    await ingestNewsCorpus({ reader: memoryReader(corpus1), store: mem.store });

    // Run kedua: b == watermark (lolos filter, conflict di store), c baru.
    const corpus2 = [
      corpusLine("b", "https://contoh.test/b", "2025-06-02 00:00:00+00:00"),
      corpusLine("c", "https://contoh.test/c", "2025-06-03 00:00:00+00:00"),
    ].join("\n");
    const result = await ingestNewsCorpus({ reader: memoryReader(corpus2), store: mem.store });
    expect(result.inserted).toBe(1); // hanya c yang benar-benar masuk
    expect(mem.byId.size).toBe(3);
  });
});
