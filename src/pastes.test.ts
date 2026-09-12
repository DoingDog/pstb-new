import { describe, expect, it } from "vitest";
import {
  contentKey,
  metaKey,
  normalizeExpiration,
  PasteService,
  revisionKey,
  validateContent,
  validateId,
  validatePassword,
  validateTitle,
} from "./pastes";

const now = new Date("2026-09-13T00:00:00.000Z");
const maxContentBytes = 10_485_760;

type Entry = { value: string; metadata: unknown; expiration: number | undefined };
type Operation = {
  type: "get" | "getWithMetadata" | "put" | "delete";
  key: string;
  value?: string;
  expiration?: number | undefined;
};

class RecordingKV {
  readonly entries = new Map<string, Entry>();
  readonly operations: Operation[] = [];
  private failAt: number | undefined;
  private stale: Map<string, Entry> | undefined;

  injectFailure(operation: number): void {
    this.failAt = operation;
  }

  useStaleSnapshot(): void {
    this.stale = new Map(
      [...this.entries].map(([key, entry]) => [key, { ...entry, metadata: structuredClone(entry.metadata) }]),
    );
  }

  clearStaleSnapshot(): void {
    this.stale = undefined;
  }

  seed(key: string, value: string, metadata: unknown = null, expiration?: number): void {
    this.entries.set(key, { value, metadata, expiration });
  }

  async get(key: string): Promise<string | null> {
    this.record({ type: "get", key });
    return (this.stale ?? this.entries).get(key)?.value ?? null;
  }

  async getWithMetadata(key: string): Promise<{ value: string | null; metadata: unknown }> {
    this.record({ type: "getWithMetadata", key });
    const entry = (this.stale ?? this.entries).get(key);
    return { value: entry?.value ?? null, metadata: entry?.metadata ?? null };
  }

  async put(key: string, value: string, options?: { metadata?: unknown; expiration?: number }): Promise<void> {
    this.record({ type: "put", key, value, expiration: options?.expiration });
    this.entries.set(key, { value, metadata: structuredClone(options?.metadata ?? null), expiration: options?.expiration });
  }

  async delete(key: string): Promise<void> {
    this.record({ type: "delete", key });
    this.entries.delete(key);
  }

  private record(operation: Operation): void {
    this.operations.push(operation);
    if (this.operations.length === this.failAt) throw new Error(`injected failure at ${this.failAt}`);
  }
}

function service(kv = new RecordingKV(), uuid = () => "00000000-0000-4000-8000-000000000001"): PasteService {
  return new PasteService(kv as unknown as KVNamespace, () => new Date(now), uuid);
}

function fiveKeys(id: string): string[] {
  return [contentKey(id), metaKey(id), revisionKey(id, 0), revisionKey(id, 1), revisionKey(id, 2)];
}

function expectPasteError(action: () => unknown, code: string): void {
  try {
    action();
  } catch (error) {
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected ${code}`);
}

describe("validation", () => {
  it.each(["a", "A", "a_1-2", "x".repeat(64)])("accepts valid custom IDs: %s", (id) => {
    expect(validateId(id)).toBe(id);
  });

  it.each(["", "_a", "a!", "x".repeat(65), "raw", "RAW", "Api", "__cfpb_meta"])
    ("rejects invalid or reserved custom IDs: %s", (id) => {
      expectPasteError(() => validateId(id), "VALIDATION_FAILED");
    });

  it.each([
    ["", "VALIDATION_FAILED"],
    ["x", undefined],
    ["x".repeat(maxContentBytes), undefined],
    ["x".repeat(maxContentBytes + 1), "CONTENT_TOO_LARGE"],
    ["\ud800", "VALIDATION_FAILED"],
  ])("validates content bytes and Unicode scalars", (content, code) => {
    if (code === undefined) {
      expect(validateContent(content)).toBe(content);
    } else {
      expectPasteError(() => validateContent(content), code);
    }
  });

  it("preserves valid Unicode content without normalization or line-ending conversion", () => {
    expect(validateContent("é\r\n🙂")).toBe("é\r\n🙂");
  });

  it.each([
    ["", true],
    ["🙂".repeat(200), true],
    ["🙂".repeat(201), false],
    ["line\nfeed", false],
    ["\udfff", false],
  ])("validates title scalars and controls", (title, valid) => {
    if (valid) expect(validateTitle(title)).toBe(title);
    else expectPasteError(() => validateTitle(title), "VALIDATION_FAILED");
  });

  it.each([
    ["", true],
    [" ", true],
    ["~", true],
    ["a".repeat(128), true],
    ["a".repeat(129), false],
    ["", false],
    ["é", false],
  ])("validates password boundaries", (password, valid) => {
    if (valid) expect(validatePassword(password)).toBe(password);
    else expectPasteError(() => validatePassword(password), "VALIDATION_FAILED");
  });

  it("normalizes permanent, relative, and offset timestamp expiration inputs from one clock value", () => {
    expect(normalizeExpiration(null, now)).toMatchObject({ expiration: { kind: "permanent" }, expiresAt: null });
    expect(normalizeExpiration("permanent", now)).toMatchObject({ expiration: { kind: "permanent" }, expiresAt: null });
    expect(normalizeExpiration(60, now)).toMatchObject({
      expiration: { kind: "relative", seconds: 60 },
      expiresAt: "2026-09-13T00:01:00.000Z",
      physicalExpiration: 1_789_257_660,
    });
    expect(normalizeExpiration("2026-09-13T01:01:00+01:00", now)).toMatchObject({
      expiration: { kind: "absolute" },
      expiresAt: "2026-09-13T00:01:00.000Z",
    });
  });

  it.each([59, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, "Permanent", "2026-09-13T00:01:00", "2026-02-30T00:01:00Z", "2026-09-13T00:00:59.999Z"])
    ("rejects invalid expiration input: %s", (expiration) => {
      expectPasteError(() => normalizeExpiration(expiration, now), "VALIDATION_FAILED");
    });
});

describe("create", () => {
  it("writes exact plaintext content after metadata in the frozen order", async () => {
    const kv = new RecordingKV();
    const pasteService = service(kv);

    const summary = await pasteService.create({ content: "exact\r\ntext", expiration: 60 }, { country: "US" });

    expect(await kv.get(summary.id)).toBe("exact\r\ntext");
    expect(JSON.parse((await kv.get(metaKey(summary.id))) as string)).toMatchObject({
      schemaVersion: 2,
      id: summary.id,
      versionCounter: 1,
      contentRevision: 1,
      createdCountry: "US",
      history: { nextSlot: 0, entries: [] },
    });
    expect(kv.operations.filter((operation) => operation.type === "put").map((operation) => operation.key)).toEqual([
      metaKey(summary.id),
      summary.id,
    ]);
    expect(kv.entries.get(summary.id)?.expiration).toBe(kv.entries.get(metaKey(summary.id))?.expiration);
  });

  it("checks every key before accepting a custom ID", async () => {
    for (const occupied of fiveKeys("taken")) {
      const kv = new RecordingKV();
      kv.seed(occupied, "occupied");

      await expect(service(kv).create({ content: "content", customId: "taken", expiration: 60 }, {})).rejects.toMatchObject({
        code: "ID_CONFLICT",
        status: 409,
        details: { id: "taken" },
      });
    }
  });

  it("checks five vacant keys in main, metadata, and slot order", async () => {
    const kv = new RecordingKV();
    await service(kv).create({ content: "content", customId: "ordered", expiration: 60 }, {});

    expect(kv.operations.slice(0, 5).map((operation) => operation.key)).toEqual(fiveKeys("ordered"));
    expect(kv.operations.slice(0, 5).map((operation) => operation.type)).toEqual(["get", "get", "get", "get", "get"]);
  });

  it("retries automatic IDs deterministically no more than five times", async () => {
    const ids = Array.from({ length: 5 }, (_, index) => `00000000-0000-4000-8000-00000000000${index + 1}`);
    const kv = new RecordingKV();
    for (const id of ids) kv.seed(id, "occupied");
    let calls = 0;

    await expect(service(kv, () => ids[calls++]!).create({ content: "content", expiration: 60 }, {})).rejects.toMatchObject({
      code: "ID_GENERATION_FAILED",
      status: 503,
    });
    expect(calls).toBe(5);
    expect(kv.operations.filter((operation) => operation.type === "get")).toHaveLength(5);
  });

  it("uses the first available automatic ID after collision checks", async () => {
    const ids = [
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
      "00000000-0000-4000-8000-000000000003",
      "00000000-0000-4000-8000-000000000004",
    ];
    const kv = new RecordingKV();
    kv.seed(ids[0]!, "occupied");
    kv.seed(ids[1]!, "occupied");
    let calls = 0;

    const summary = await service(kv, () => ids[calls++]!).create({ content: "content", expiration: 60 }, {});

    expect(summary.id).toBe(ids[2]);
    expect(calls).toBe(4);
  });

  it("removes metadata and revision siblings when the main write fails", async () => {
    const kv = new RecordingKV();
    kv.injectFailure(7);

    await expect(service(kv).create({ content: "content", customId: "failure", expiration: 60 }, {})).rejects.toMatchObject({
      code: "STORAGE_WRITE_FAILED",
      status: 503,
    });
    expect(kv.operations.filter((operation) => operation.type === "delete").map((operation) => operation.key)).toEqual([
      metaKey("failure"),
      revisionKey("failure", 0),
      revisionKey("failure", 1),
      revisionKey("failure", 2),
    ]);
  });

  it("never exposes the plaintext password in a create summary", async () => {
    const summary = await service().create(
      { content: "content", customId: "secret", password: "leading space ", expiration: "permanent" },
      {},
    );

    expect(summary).not.toHaveProperty("password");
    expect(JSON.stringify(summary)).not.toContain("leading space ");
  });
});

describe("read", () => {
  async function createdV2(kv = new RecordingKV(), input: Partial<Parameters<PasteService["create"]>[0]> = {}) {
    const pasteService = service(kv);
    const paste = await pasteService.create(
      { content: "exact\r\ntext", customId: "coherent", expiration: 60, ...input },
      { country: "US" },
    );
    return { kv, pasteService, paste };
  }

  it("loads coherent schema 2 content only after matching its marker, metadata, bytes, and password", async () => {
    const { pasteService } = await createdV2(undefined, { password: "correct password" });

    await expect(pasteService.loadContent("coherent", undefined)).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    await expect(pasteService.loadContent("coherent", "wrong")).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    const loaded = await pasteService.loadContent("coherent", "correct password");

    expect(loaded).toMatchObject({ content: "exact\r\ntext", legacy: false });
    expect(loaded.summary).toMatchObject({ id: "coherent", protected: true, version: expect.stringContaining(".1") });
    expect(loaded.marker).toMatchObject({ kind: "cfpb/content", schemaVersion: 2, commit: null });
  });

  it("returns settings from coherent authorized state without returning content", async () => {
    const { pasteService } = await createdV2(undefined, { password: "correct password" });

    const settings = await pasteService.getSettings("coherent", "correct password");

    expect(settings).toMatchObject({ id: "coherent", protected: true });
    expect(settings).not.toHaveProperty("content");
  });

  it("cleans all five keys before reporting a logically expired paste as missing", async () => {
    const { kv } = await createdV2();
    const expiredService = new PasteService(
      kv as unknown as KVNamespace,
      () => new Date("2026-09-13T00:01:00.000Z"),
      () => "00000000-0000-4000-8000-000000000001",
    );

    await expect(expiredService.loadContent("coherent", undefined)).rejects.toMatchObject({ code: "PASTE_NOT_FOUND", status: 404 });
    expect(kv.operations.filter((operation) => operation.type === "delete").map((operation) => operation.key).sort()).toEqual(
      fiveKeys("coherent").sort(),
    );
    expect(kv.entries.size).toBe(0);
  });

  it("treats a metadata-only orphan as missing without deleting it", async () => {
    const { kv, pasteService } = await createdV2();
    kv.entries.delete("coherent");
    const operationCount = kv.operations.length;

    await expect(pasteService.loadContent("coherent", undefined)).rejects.toMatchObject({ code: "PASTE_NOT_FOUND", status: 404 });
    expect(kv.entries.has(metaKey("coherent"))).toBe(true);
    expect(kv.operations.slice(operationCount).some((operation) => operation.type === "delete")).toBe(false);
  });

  it.each([
    ["incomplete marker", (kv: RecordingKV) => ({ kind: "cfpb/content" })],
    ["unrelated marker field", (kv: RecordingKV) => ({ title: "legacy", byteLength: 10 })],
    ["generation mismatch", (kv: RecordingKV) => ({ ...(kv.entries.get("coherent")!.metadata as object), generation: "00000000-0000-4000-8000-000000000099" })],
    ["byte mismatch", (kv: RecordingKV) => ({ ...(kv.entries.get("coherent")!.metadata as object), byteLength: 1 })],
  ])("fails closed for %s", async (_name, marker) => {
    const { kv, pasteService } = await createdV2();
    kv.entries.get("coherent")!.metadata = marker(kv);

    await expect(pasteService.loadContent("coherent", undefined)).rejects.toMatchObject({
      code: "STORAGE_INCONSISTENT",
      status: 503,
    });
  });

  it.each([
    ["malformed metadata", "{"],
    ["oversized metadata", `{"padding":"${"x".repeat(16_384)}"}`],
  ])("fails closed for %s", async (_name, metadata) => {
    const { kv, pasteService } = await createdV2();
    kv.entries.get(metaKey("coherent"))!.value = metadata;

    await expect(pasteService.loadContent("coherent", undefined)).rejects.toMatchObject({
      code: "STORAGE_INCONSISTENT",
      status: 503,
    });
  });

  it("fails closed for an unmarked main value beside a schema 2 sibling", async () => {
    const { kv, pasteService } = await createdV2();
    kv.entries.get("coherent")!.metadata = { title: "old attached metadata" };

    await expect(pasteService.loadContent("coherent", undefined)).rejects.toMatchObject({
      code: "STORAGE_INCONSISTENT",
      status: 503,
    });
  });

  it("projects valid legacy attached metadata without writing schema 2 keys", async () => {
    const kv = new RecordingKV();
    kv.seed("legacy", "legacy\r\nsource", {
      title: "Legacy title",
      country: "US",
      ip: "198.51.100.8",
      createdAt: Date.parse("2026-09-13T00:00:00.000Z"),
      expiration: 60,
    });
    const pasteService = service(kv);

    const loaded = await pasteService.loadContent("legacy", undefined);

    expect(loaded).toMatchObject({ content: "legacy\r\nsource", legacy: true, marker: null });
    expect(loaded.summary).toMatchObject({
      title: "Legacy title",
      createdCountry: "US",
      createdAt: "2026-09-13T00:00:00.000Z",
      expiresAt: "2026-09-13T00:01:00.000Z",
      version: "legacy",
      protected: false,
    });
    expect(kv.operations.filter((operation) => operation.type === "put" || operation.type === "delete")).toHaveLength(0);
  });

  it("computes legacy expiry from createdAt plus expiration seconds", async () => {
    const kv = new RecordingKV();
    kv.seed("legacy-expiry", "legacy", { createdAt: 1_789_257_600_000, expiration: 86_400 });

    const loaded = await service(kv).loadContent("legacy-expiry", undefined);

    expect(loaded.summary.expiresAt).toBe("2026-09-14T00:00:00.000Z");
  });

  it("does not consume a stale snapshot or use it to write during a coherent read", async () => {
    const { kv, pasteService } = await createdV2();
    kv.useStaleSnapshot();
    kv.entries.get("coherent")!.value = "newer but not read";
    const writesBefore = kv.operations.filter((operation) => operation.type === "put" || operation.type === "delete").length;

    const loaded = await pasteService.loadContent("coherent", undefined);

    expect(loaded.content).toBe("exact\r\ntext");
    expect(kv.operations.filter((operation) => operation.type === "put" || operation.type === "delete")).toHaveLength(writesBefore);
  });
});

describe("consume", () => {
  it("deletes main, all three slots, then metadata before resolving", async () => {
    const { kv, pasteService } = await (async () => {
      const kv = new RecordingKV();
      const pasteService = service(kv);
      await pasteService.create({ content: "once", customId: "once", expiration: 60, viewOnce: true }, {});
      return { kv, pasteService };
    })();
    const loaded = await pasteService.loadContent("once", undefined);

    await pasteService.consume(loaded);

    expect(kv.operations.filter((operation) => operation.type === "delete").map((operation) => operation.key)).toEqual([
      contentKey("once"),
      revisionKey("once", 0),
      revisionKey("once", 1),
      revisionKey("once", 2),
      metaKey("once"),
    ]);
    expect(kv.entries.size).toBe(0);
  });

  it("attempts every delete and reports a consume failure when deletion is partial", async () => {
    const kv = new RecordingKV();
    const pasteService = service(kv);
    await pasteService.create({ content: "once", customId: "partial", expiration: 60, viewOnce: true }, {});
    const loaded = await pasteService.loadContent("partial", undefined);
    kv.injectFailure(kv.operations.length + 3);

    await expect(pasteService.consume(loaded)).rejects.toMatchObject({
      code: "CONSUME_FAILED",
      status: 503,
      details: { mutationMayHaveApplied: true },
    });
    expect(kv.operations.filter((operation) => operation.type === "delete").map((operation) => operation.key)).toEqual([
      contentKey("partial"),
      revisionKey("partial", 0),
      revisionKey("partial", 1),
      revisionKey("partial", 2),
      metaKey("partial"),
    ]);
  });
});
