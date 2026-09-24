import { describe, expect, it } from "vitest";
import {
  contentKey,
  metaKey,
  normalizeExpiration,
  pendingKey,
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
  expirationTtl?: number | undefined;
};

class RecordingKV {
  readonly entries = new Map<string, Entry>();
  readonly operations: Operation[] = [];
  private readonly failureOperations = new Set<number>();
  private stale: Map<string, Entry> | undefined;

  injectFailure(...operations: number[]): void {
    this.failureOperations.clear();
    for (const operation of operations) this.failureOperations.add(operation);
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

  async put(key: string, value: string, options?: { metadata?: unknown; expiration?: number; expirationTtl?: number }): Promise<void> {
    this.record({ type: "put", key, value, expiration: options?.expiration, expirationTtl: options?.expirationTtl });
    this.entries.set(key, { value, metadata: structuredClone(options?.metadata ?? null), expiration: options?.expiration });
  }

  async delete(key: string): Promise<void> {
    this.record({ type: "delete", key });
    this.entries.delete(key);
  }

  private record(operation: Operation): void {
    this.operations.push(operation);
    if (this.failureOperations.has(this.operations.length)) throw new Error(`injected failure at ${this.operations.length}`);
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

  it("accepts the RFC3339 relative-expiration boundary and rejects one second beyond it", () => {
    const boundaryNow = new Date("9999-12-31T23:58:59.999Z");

    expect(normalizeExpiration(60, boundaryNow)).toMatchObject({
      expiration: { kind: "relative", seconds: 60 },
      expiresAt: "9999-12-31T23:59:59.999Z",
    });
    expectPasteError(() => normalizeExpiration(61, boundaryNow), "VALIDATION_FAILED");
  });

  it.each([
    ["9999-12-31T23:59:59.999Z", "9999-12-31T23:59:59.999Z"],
    ["9999-12-31T23:59:59.999+00:00", "9999-12-31T23:59:59.999Z"],
    ["9999-12-31T23:59:59.999-00:00", "9999-12-31T23:59:59.999Z"],
    ["9999-12-31T23:59:59.999+00:01", "9999-12-31T23:58:59.999Z"],
  ])("accepts an absolute RFC3339 timestamp at or below the maximum after offset normalization: %s", (input, expiresAt) => {
    expect(normalizeExpiration(input, now)).toMatchObject({ expiration: { kind: "absolute" }, expiresAt });
  });

  it.each(["9999-12-31T23:59:59.999-00:01", "9999-12-31T23:59:59.999-23:59"])
    ("rejects an absolute RFC3339 timestamp above the maximum after negative-offset normalization: %s", (input) => {
      expectPasteError(() => normalizeExpiration(input, now), "VALIDATION_FAILED");
    });

  it.each([59, Number.MAX_SAFE_INTEGER + 1, "Permanent", "2026-09-13T00:01:00", "2026-02-30T00:01:00Z", "2026-09-13T00:00:59.999Z"])
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

  it.each([60, "2026-09-13T00:01:00.000Z"])("creates a minimum-expiry paste after slow vacancy reads: %s", async (expiration) => {
    const kv = new RecordingKV();
    let time = now.getTime();
    const get = kv.get.bind(kv);
    kv.get = async (key) => {
      const value = await get(key);
      if (key === pendingKey("minimum")) time += 2_000;
      return value;
    };
    const put = kv.put.bind(kv);
    kv.put = async (key, value, options) => {
      if (options?.expiration !== undefined && options.expiration * 1000 - time < 60_000) {
        throw new Error("KV expiration must be at least 60 seconds from the write");
      }
      if (options?.expirationTtl !== undefined && options.expirationTtl < 60) {
        throw new Error("KV TTL must be at least 60 seconds");
      }
      await put(key, value, options);
    };
    const pasteService = new PasteService(kv as unknown as KVNamespace, () => new Date(time), () => "00000000-0000-4000-8000-000000000001");

    await expect(pasteService.create({ content: "available", customId: "minimum", expiration }, {}))
      .resolves.toMatchObject({ id: "minimum", expiresAt: "2026-09-13T00:01:00.000Z" });
    await expect(pasteService.loadContent("minimum")).resolves.toMatchObject({ content: "available" });
  });

  it("preserves the current-schema Cloudflare T1 country value through a coherent read", async () => {
    const kv = new RecordingKV();
    const pasteService = service(kv);

    const created = await pasteService.create({ content: "content", customId: "cloudflare-country", expiration: 60 }, { country: "T1" });

    expect(created.createdCountry).toBe("T1");
    expect(JSON.parse(kv.entries.get(metaKey("cloudflare-country"))!.value)).toMatchObject({ createdCountry: "T1" });
    await expect(pasteService.loadContent("cloudflare-country", undefined)).resolves.toMatchObject({
      summary: { createdCountry: "T1" },
    });
  });

  it("recreates an aged metadata-only paste without deleting its old metadata first", async () => {
    const kv = new RecordingKV();
    const oldService = new PasteService(kv as unknown as KVNamespace, () => new Date(now.getTime() - 120_001), () => "00000000-0000-4000-8000-000000000001");
    await oldService.create({ content: "old", customId: "orphan", title: "Old", expiration: "permanent" }, {});
    kv.entries.delete(contentKey("orphan"));

    const pasteService = service(kv);
    const created = await pasteService.create({ content: "new", customId: "orphan", title: "New", expiration: "permanent" }, {});

    await expect(pasteService.loadContent("orphan")).resolves.toMatchObject({
      content: "new",
      summary: { title: "New", version: created.version },
    });
  });

  it("does not reuse an aged ID while its old paste is being deleted", async () => {
    const kv = new RecordingKV();
    const oldService = new PasteService(kv as unknown as KVNamespace, () => new Date(now.getTime() - 120_001), () => "00000000-0000-4000-8000-000000000001");
    await oldService.create({ content: "old", customId: "deleting", expiration: "permanent" }, {});
    const originalDelete = kv.delete.bind(kv);
    let signalMainDeleted!: () => void;
    let resumeDelete!: () => void;
    const mainDeleted = new Promise<void>((resolve) => { signalMainDeleted = resolve; });
    const held = new Promise<void>((resolve) => { resumeDelete = resolve; });
    kv.delete = async (key) => {
      await originalDelete(key);
      if (key === contentKey("deleting")) {
        signalMainDeleted();
        await held;
      }
    };

    const pasteService = service(kv);
    const deleting = pasteService.delete("deleting");
    await mainDeleted;
    try {
      await expect(pasteService.create({ content: "new", customId: "deleting", expiration: "permanent" }, {}))
        .rejects.toMatchObject({ code: "ID_CONFLICT", status: 409 });
    } finally {
      resumeDelete();
      await deleting;
    }
  });

  it.each([119_999, 120_000])("requires an orphan to be at least 120 seconds old (%i ms)", async (age) => {
    const kv = new RecordingKV();
    const oldService = new PasteService(kv as unknown as KVNamespace, () => new Date(now.getTime() - age), () => "00000000-0000-4000-8000-000000000001");
    await oldService.create({ content: "old", customId: "boundary", expiration: "permanent" }, {});
    kv.entries.delete(contentKey("boundary"));

    const attempt = service(kv).create({ content: "new", customId: "boundary", expiration: "permanent" }, {});
    if (age < 120_000) await expect(attempt).rejects.toMatchObject({ code: "ID_CONFLICT" });
    else await expect(attempt).resolves.toMatchObject({ id: "boundary" });
  });

  it.each(["updatedAt", "currentSavedAt"])("retains an old orphan when %s is recent", async (field) => {
    const kv = new RecordingKV();
    const oldService = new PasteService(kv as unknown as KVNamespace, () => new Date(now.getTime() - 120_001), () => "00000000-0000-4000-8000-000000000001");
    await oldService.create({ content: "old", customId: "recent", expiration: "permanent" }, {});
    kv.entries.delete(contentKey("recent"));
    const entry = kv.entries.get(metaKey("recent"))!;
    entry.value = JSON.stringify({ ...JSON.parse(entry.value), [field]: now.toISOString() });

    await expect(service(kv).create({ content: "new", customId: "recent", expiration: "permanent" }, {}))
      .rejects.toMatchObject({ code: "ID_CONFLICT" });
    expect(kv.entries.get(metaKey("recent"))?.value).toBe(entry.value);
  });

  it("does not write when the pending-key read fails", async () => {
    const kv = new RecordingKV();
    kv.injectFailure(6);

    await expect(service(kv).create({ content: "new", customId: "unreadable", expiration: "permanent" }, {}))
      .rejects.toMatchObject({ code: "STORAGE_READ_FAILED", status: 503 });
    expect(kv.operations.map((operation) => `${operation.type}:${operation.key}`)).toEqual(
      [...fiveKeys("unreadable"), pendingKey("unreadable")].map((key) => `get:${key}`),
    );
  });

  it("cools a deleted ID for 120 seconds, then permits reuse after the pending key expires", async () => {
    const kv = new RecordingKV();
    const pasteService = service(kv);
    await pasteService.create({ content: "old", customId: "cooling", expiration: "permanent" }, {});
    await pasteService.delete("cooling");

    expect(kv.operations.find((operation) => operation.type === "put" && operation.key === pendingKey("cooling")))
      .toMatchObject({ expirationTtl: 120 });
    await expect(pasteService.create({ content: "new", customId: "cooling", expiration: "permanent" }, {}))
      .rejects.toMatchObject({ code: "ID_CONFLICT" });
    kv.entries.delete(pendingKey("cooling")); // 手动模拟 TTL 到期，避免扩展测试 KV 的时钟实现。
    await expect(pasteService.create({ content: "new", customId: "cooling", expiration: "permanent" }, {}))
      .resolves.toMatchObject({ id: "cooling" });
    await expect(pasteService.loadContent("cooling")).resolves.toMatchObject({ content: "new" });
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

  it("checks vacant keys in main, metadata, slot, and pending order", async () => {
    const kv = new RecordingKV();
    await service(kv).create({ content: "content", customId: "ordered", expiration: 60 }, {});

    expect(kv.operations.slice(0, 6).map((operation) => operation.key)).toEqual([...fiveKeys("ordered"), pendingKey("ordered")]);
    expect(kv.operations.slice(0, 6).map((operation) => operation.type)).toEqual(Array(6).fill("get"));
  });

  it.each(fiveKeys("collision-failure").map((key, index) => [key, index + 1] as const))(
    "returns STORAGE_READ_FAILED when collision read %s fails",
    async (_key, failureOffset) => {
      const kv = new RecordingKV();
      kv.injectFailure(failureOffset);

      await expect(service(kv).create({ content: "content", customId: "collision-failure", expiration: 60 }, {})).rejects.toMatchObject({
        code: "STORAGE_READ_FAILED",
        status: 503,
        details: { retryable: true },
      });
      expect(kv.operations.map((operation) => `${operation.type}:${operation.key}`)).toEqual(
        fiveKeys("collision-failure").slice(0, failureOffset).map((key) => `get:${key}`),
      );
      expect(kv.operations.some((operation) => operation.type === "put" || operation.type === "delete")).toBe(false);
    },
  );

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

  it.each([
    ["metadata put", [7], false],
    ["main put", [8], false],
    ["metadata compensation delete", [8, 9], true],
    ["first revision compensation delete", [8, 10], true],
    ["second revision compensation delete", [8, 11], true],
    ["third revision compensation delete", [8, 12], true],
  ])("reports create failure from %s after every later required operation", async (_name, failures, mutationMayHaveApplied) => {
    const kv = new RecordingKV();
    kv.injectFailure(...failures);

    await expect(service(kv).create({ content: "content", customId: "failure", expiration: 60 }, {})).rejects.toMatchObject({
      code: "STORAGE_WRITE_FAILED",
      status: 503,
      details: { retryable: true, mutationMayHaveApplied },
    });

    const reads = [...fiveKeys("failure"), pendingKey("failure")].map((key) => `get:${key}`);
    const operationOrder = failures[0] === 7
      ? [...reads, `put:${metaKey("failure")}`]
      : [
          ...reads,
          `put:${metaKey("failure")}`,
          "put:failure",
          `delete:${metaKey("failure")}`,
          `delete:${revisionKey("failure", 0)}`,
          `delete:${revisionKey("failure", 1)}`,
          `delete:${revisionKey("failure", 2)}`,
        ];
    expect(kv.operations.map((operation) => `${operation.type}:${operation.key}`)).toEqual(operationOrder);
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

  it.each([
    ["main", 1],
    ["metadata", 2],
  ])("returns STORAGE_READ_FAILED when coherent %s read fails after both reads start", async (_name, failureOffset) => {
    const { kv, pasteService } = await createdV2();
    const before = kv.operations.length;
    kv.injectFailure(before + failureOffset);

    await expect(pasteService.loadContent("coherent", undefined)).rejects.toMatchObject({
      code: "STORAGE_READ_FAILED",
      status: 503,
      details: { retryable: true },
    });
    expect(kv.operations.slice(before).map((operation) => `${operation.type}:${operation.key}`)).toEqual([
      "getWithMetadata:coherent",
      `get:${metaKey("coherent")}`,
    ]);
    expect(kv.operations.slice(before).every((operation) => operation.type === "get" || operation.type === "getWithMetadata")).toBe(true);
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
    expect([...kv.entries.keys()]).toEqual([pendingKey("coherent")]);
  });

  it("reports a logically expired paste without cleanup when requested", async () => {
    const { kv } = await createdV2();
    const expiredService = new PasteService(
      kv as unknown as KVNamespace,
      () => new Date("2026-09-13T00:01:00.000Z"),
      () => "00000000-0000-4000-8000-000000000001",
    );
    const before = kv.operations.length;

    await expect(expiredService.loadContent("coherent", undefined, { cleanupExpired: false })).rejects.toMatchObject({
      code: "PASTE_NOT_FOUND",
      status: 404,
    });
    expect(kv.operations.slice(before).some((operation) => operation.type === "delete")).toBe(false);
    expect(kv.entries.size).toBe(2);
  });

  it.each([
    ["main", 1],
    ["first revision", 2],
    ["second revision", 3],
    ["third revision", 4],
    ["metadata", 5],
  ])("reports a logical-expiry %s delete failure after every cleanup delete", async (_name, deleteOffset) => {
    const { kv } = await createdV2();
    const expiredService = new PasteService(
      kv as unknown as KVNamespace,
      () => new Date("2026-09-13T00:01:00.000Z"),
      () => "00000000-0000-4000-8000-000000000001",
    );
    const before = kv.operations.length;
    kv.injectFailure(before + 3 + deleteOffset);

    await expect(expiredService.loadContent("coherent", undefined)).rejects.toMatchObject({
      code: "STORAGE_WRITE_FAILED",
      status: 503,
      details: { retryable: true, mutationMayHaveApplied: true },
    });
    expect(kv.operations.slice(before).map((operation) => `${operation.type}:${operation.key}`)).toEqual([
      "getWithMetadata:coherent",
      `get:${metaKey("coherent")}`,
      `put:${pendingKey("coherent")}`,
      "delete:coherent",
      `delete:${revisionKey("coherent", 0)}`,
      `delete:${revisionKey("coherent", 1)}`,
      `delete:${revisionKey("coherent", 2)}`,
      `delete:${metaKey("coherent")}`,
    ]);
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

  it.each([
    ["US", "US"],
    ["T1", null],
    ["USA", null],
    ["", null],
  ])("retains only alphabetic two-letter legacy countries: %s", async (country, createdCountry) => {
    const kv = new RecordingKV();
    kv.seed("legacy-country", "legacy", { country });

    await expect(service(kv).loadContent("legacy-country", undefined)).resolves.toMatchObject({
      summary: { createdCountry },
    });
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
    expect([...kv.entries.keys()]).toEqual([pendingKey("once")]);
  });

  it.each([
    ["main", 1],
    ["first revision", 2],
    ["second revision", 3],
    ["third revision", 4],
    ["metadata", 5],
  ])("reports a consume %s delete failure after every delete is attempted", async (_name, deleteOffset) => {
    const kv = new RecordingKV();
    const pasteService = service(kv);
    await pasteService.create({ content: "once", customId: "partial", expiration: 60, viewOnce: true }, {});
    const loaded = await pasteService.loadContent("partial", undefined);
    const before = kv.operations.length;
    kv.injectFailure(before + 1 + deleteOffset);

    await expect(pasteService.consume(loaded)).rejects.toMatchObject({
      code: "CONSUME_FAILED",
      status: 503,
      details: { retryable: true, mutationMayHaveApplied: true },
    });
    expect(kv.operations.slice(before).map((operation) => `${operation.type}:${operation.key}`)).toEqual([
      `put:${pendingKey("partial")}`,
      "delete:partial",
      `delete:${revisionKey("partial", 0)}`,
      `delete:${revisionKey("partial", 1)}`,
      `delete:${revisionKey("partial", 2)}`,
      `delete:${metaKey("partial")}`,
    ]);
  });
});

describe("delete guard", () => {
  it.each([
    ["delete", "STORAGE_WRITE_FAILED"],
    ["consume", "CONSUME_FAILED"],
    ["expiry", "STORAGE_WRITE_FAILED"],
  ])("does not delete any paste keys when the %s pending write fails", async (reason, errorCode) => {
    const kv = new RecordingKV();
    const pasteService = service(kv);
    await pasteService.create({ content: "old", customId: "guarded", expiration: 60, viewOnce: true }, {});
    const loaded = await pasteService.loadContent("guarded");
    const before = kv.operations.length;
    kv.injectFailure(before + (reason === "consume" ? 1 : 3));
    const action = reason === "consume" ? pasteService.consume(loaded)
      : reason === "delete" ? pasteService.delete("guarded")
        : new PasteService(kv as unknown as KVNamespace, () => new Date(now.getTime() + 60_000)).loadContent("guarded");

    await expect(action).rejects.toMatchObject({ code: errorCode, status: 503 });
    expect(kv.operations.slice(before).filter((operation) => operation.type === "delete")).toEqual([]);
    expect(kv.entries.has(contentKey("guarded"))).toBe(true);
    expect(kv.entries.has(metaKey("guarded"))).toBe(true);
  });
});

describe("content save and history ring", () => {
  it("writes current values into a three-slot newest-first history ring", async () => {
    const kv = new RecordingKV();
    const pasteService = service(kv);
    const created = await pasteService.create({ content: "v1", customId: "ring", expiration: "permanent" }, {});

    for (const content of ["v2", "v3", "v4", "v5"]) {
      const before = kv.operations.length;
      const result = await pasteService.updateContent("ring", { content, version: created.version });
      created.version = result.paste.version;

      expect(result).toMatchObject({ changed: true, paste: { contentRevision: Number(content[1]), version: expect.stringMatching(new RegExp(`\\.${content[1]}$`)) } });
      expect(kv.operations.slice(before).filter((operation) => operation.type === "put").map((operation) => operation.key)).toEqual([
        revisionKey("ring", (Number(content[1]) - 2) % 3),
        contentKey("ring"),
        metaKey("ring"),
      ]);
    }

    const metadata = JSON.parse(kv.entries.get(metaKey("ring"))!.value);
    expect(metadata.history).toEqual({
      nextSlot: 1,
      entries: [
        expect.objectContaining({ revision: 4, slot: 0 }),
        expect.objectContaining({ revision: 3, slot: 2 }),
        expect.objectContaining({ revision: 2, slot: 1 }),
      ],
    });
    expect([...kv.entries.keys()].filter((key) => key.startsWith("__cfpb:rev:ring:"))).toEqual([
      revisionKey("ring", 0),
      revisionKey("ring", 1),
      revisionKey("ring", 2),
    ]);
    expect(kv.entries.get(revisionKey("ring", 0))?.value).toBe("v4");
    expect([...kv.entries.values()].some((entry) => entry.value === "v1")).toBe(false);
  });

  it("returns an exact-content no-op without writing or advancing its version", async () => {
    const kv = new RecordingKV();
    const pasteService = service(kv);
    const created = await pasteService.create({ content: "same", customId: "no-op", expiration: "permanent" }, {});
    const before = kv.operations.length;

    await expect(pasteService.updateContent("no-op", { content: "same", version: created.version })).resolves.toEqual({
      changed: false,
      paste: created,
    });
    expect(kv.operations).toHaveLength(before + 2);
    expect(kv.operations.slice(before).every((operation) => operation.type === "get" || operation.type === "getWithMetadata")).toBe(true);
  });

  it("honors a matching opaque version, rejects a stale one, and permits omitted-version LWW", async () => {
    const kv = new RecordingKV();
    const pasteService = service(kv);
    const created = await pasteService.create({ content: "v1", customId: "versions", expiration: "permanent" }, {});

    const updated = await pasteService.updateContent("versions", { content: "v2", version: created.version });
    await expect(pasteService.updateContent("versions", { content: "v3", version: created.version })).rejects.toMatchObject({
      code: "VERSION_CONFLICT",
      status: 409,
      details: { currentVersion: updated.paste.version, updatedAt: now.toISOString() },
    });
    await expect(pasteService.updateContent("versions", { content: "v3" })).resolves.toMatchObject({
      changed: true,
      paste: { version: expect.stringMatching(/\.3$/), contentRevision: 3 },
    });
  });

  it("reconciles only a provable metadata-last content save without another version increment", async () => {
    const kv = new RecordingKV();
    const pasteService = service(kv);
    const created = await pasteService.create(
      { content: "v1", customId: "reconcile", title: "Preserve", format: "markdown", password: "secret", viewOnce: true, expiration: 60 },
      {},
    );
    kv.injectFailure(kv.operations.length + 5);

    await expect(pasteService.updateContent("reconcile", { content: "v2", password: "secret", version: created.version })).rejects.toMatchObject({
      code: "STORAGE_WRITE_FAILED",
      details: { mutationMayHaveApplied: true },
    });

    const loaded = await pasteService.loadContent("reconcile", "secret");
    expect(loaded).toMatchObject({ content: "v2", summary: { version: expect.stringMatching(/\.2$/), contentRevision: 2, title: "Preserve", format: "markdown", viewOnce: true } });
    const metadata = JSON.parse(kv.entries.get(metaKey("reconcile"))!.value);
    expect(metadata).toMatchObject({
      title: "Preserve",
      format: "markdown",
      password: "secret",
      viewOnce: true,
      expiresAt: "2026-09-13T00:01:00.000Z",
      versionCounter: 2,
      contentRevision: 2,
      history: { nextSlot: 1, entries: [expect.objectContaining({ revision: 1, slot: 0 })] },
    });
  });

  it("rewrites all active values before reconciling a near-expiry interrupted save", async () => {
    const kv = new RecordingKV();
    const initial = service(kv);
    let paste = await initial.create({ content: "v1", customId: "reconcile-expiry", expiration: 3_600 }, {});
    paste = (await initial.updateContent("reconcile-expiry", { content: "v2", version: paste.version })).paste;
    const saving = new PasteService(
      kv as unknown as KVNamespace,
      () => new Date("2026-09-13T00:59:30.000Z"),
      () => "00000000-0000-4000-8000-000000000001",
    );
    kv.injectFailure(kv.operations.length + 7);

    await expect(saving.updateContent("reconcile-expiry", { content: "v3", version: paste.version })).rejects.toMatchObject({
      code: "STORAGE_WRITE_FAILED",
      details: { mutationMayHaveApplied: true },
    });
    kv.injectFailure();
    const repairing = new PasteService(
      kv as unknown as KVNamespace,
      () => new Date("2026-09-13T00:59:30.000Z"),
      () => "00000000-0000-4000-8000-000000000001",
    );
    const before = kv.operations.length;

    await expect(repairing.loadContent("reconcile-expiry", undefined)).resolves.toMatchObject({
      content: "v3",
      summary: { version: expect.stringMatching(/\.3$/), contentRevision: 3 },
    });

    expect(kv.operations.slice(before).filter((operation) => operation.type === "put").map((operation) => operation.key)).toEqual([
      contentKey("reconcile-expiry"),
      revisionKey("reconcile-expiry", 1),
      revisionKey("reconcile-expiry", 0),
      metaKey("reconcile-expiry"),
    ]);
    expect(JSON.parse(kv.entries.get(metaKey("reconcile-expiry"))!.value)).toMatchObject({ physicalExpiration: 1_789_261_230 });
    for (const key of [contentKey("reconcile-expiry"), revisionKey("reconcile-expiry", 1), revisionKey("reconcile-expiry", 0), metaKey("reconcile-expiry")]) {
      expect(kv.entries.get(key)?.expiration).toBe(1_789_261_230);
    }
  });

  it.each(["permanent", 7_200] as const)("reconciles against a concurrently changed %s sibling expiration", async (expiration) => {
    const kv = new RecordingKV();
    const initial = service(kv);
    let paste = await initial.create({ content: "v1", customId: `reconcile-concurrent-${expiration}`, expiration: 3_600 }, {});
    paste = (await initial.updateContent(`reconcile-concurrent-${expiration}`, { content: "v2", version: paste.version })).paste;
    const saving = new PasteService(
      kv as unknown as KVNamespace,
      () => new Date("2026-09-13T00:59:30.000Z"),
      () => "00000000-0000-4000-8000-000000000001",
    );
    kv.injectFailure(kv.operations.length + 7);

    await expect(saving.updateContent(`reconcile-concurrent-${expiration}`, { content: "v3", version: paste.version })).rejects.toMatchObject({
      code: "STORAGE_WRITE_FAILED",
      details: { mutationMayHaveApplied: true },
    });
    kv.injectFailure();
    const expectedPhysical = expiration === "permanent" ? undefined : 1_789_268_371;
    const sibling = kv.entries.get(metaKey(`reconcile-concurrent-${expiration}`))!;
    const metadata = JSON.parse(sibling.value);
    metadata.expiresAt = expiration === "permanent" ? null : "2026-09-13T02:59:31.000Z";
    metadata.expiration = expiration === "permanent" ? { kind: "permanent" } : { kind: "relative", seconds: expiration };
    metadata.physicalExpiration = expectedPhysical ?? null;
    metadata.updatedAt = "2026-09-13T00:59:31.000Z";
    metadata.versionCounter = 3;
    sibling.value = JSON.stringify(metadata);
    sibling.expiration = expectedPhysical;
    const repairing = new PasteService(
      kv as unknown as KVNamespace,
      () => new Date("2026-09-13T00:59:31.000Z"),
      () => "00000000-0000-4000-8000-000000000001",
    );
    const before = kv.operations.length;

    await expect(repairing.loadContent(`reconcile-concurrent-${expiration}`, undefined)).resolves.toMatchObject({
      content: "v3",
      summary: { version: expect.stringMatching(/\.3$/), contentRevision: 3, expiresAt: expiration === "permanent" ? null : "2026-09-13T02:59:31.000Z" },
    });

    expect(kv.operations.slice(before).filter((operation) => operation.type === "put").map((operation) => operation.key)).toEqual([
      contentKey(`reconcile-concurrent-${expiration}`),
      revisionKey(`reconcile-concurrent-${expiration}`, 1),
      revisionKey(`reconcile-concurrent-${expiration}`, 0),
      metaKey(`reconcile-concurrent-${expiration}`),
    ]);
    for (const key of [contentKey(`reconcile-concurrent-${expiration}`), revisionKey(`reconcile-concurrent-${expiration}`, 1), revisionKey(`reconcile-concurrent-${expiration}`, 0), metaKey(`reconcile-concurrent-${expiration}`)]) {
      expect(kv.entries.get(key)?.expiration).toBe(expectedPhysical);
    }
  });

  it("refreshes all active values before repairing a near-expiry interrupted save that has become unacceptable", async () => {
    const kv = new RecordingKV();
    const initial = service(kv);
    let paste = await initial.create({ content: "v1", customId: "repair-refresh", expiration: 3_600 }, {});
    paste = (await initial.updateContent("repair-refresh", { content: "v2", version: paste.version })).paste;
    const saving = new PasteService(
      kv as unknown as KVNamespace,
      () => new Date("2026-09-13T00:59:30.000Z"),
      () => "00000000-0000-4000-8000-000000000001",
    );
    kv.injectFailure(kv.operations.length + 7);

    await expect(saving.updateContent("repair-refresh", { content: "v3", version: paste.version })).rejects.toMatchObject({
      code: "STORAGE_WRITE_FAILED",
      details: { mutationMayHaveApplied: true },
    });
    kv.injectFailure();
    const repairing = new PasteService(
      kv as unknown as KVNamespace,
      () => new Date("2026-09-13T00:59:31.000Z"),
      () => "00000000-0000-4000-8000-000000000001",
    );
    const before = kv.operations.length;

    await expect(repairing.loadContent("repair-refresh", undefined)).resolves.toMatchObject({ content: "v3" });

    expect(kv.operations.slice(before).filter((operation) => operation.type === "put").map((operation) => operation.key)).toEqual([
      contentKey("repair-refresh"),
      revisionKey("repair-refresh", 1),
      revisionKey("repair-refresh", 0),
      metaKey("repair-refresh"),
    ]);
    expect(JSON.parse(kv.entries.get(metaKey("repair-refresh"))!.value)).toMatchObject({ physicalExpiration: 1_789_261_231 });
    for (const key of [contentKey("repair-refresh"), revisionKey("repair-refresh", 1), revisionKey("repair-refresh", 0), metaKey("repair-refresh")]) {
      expect(kv.entries.get(key)?.expiration).toBe(1_789_261_231);
    }
  });

  type InterruptedContentSave = { kv: RecordingKV; pasteService: PasteService; id: string };

  async function interruptedContentSave(): Promise<InterruptedContentSave> {
    const kv = new RecordingKV();
    const pasteService = service(kv);
    const id = "reconcile-proof";
    const created = await pasteService.create({ content: "v1", customId: id, expiration: "permanent" }, {});
    kv.injectFailure(kv.operations.length + 5);
    await expect(pasteService.updateContent(id, { content: "v2", version: created.version })).rejects.toMatchObject({
      code: "STORAGE_WRITE_FAILED",
      details: { mutationMayHaveApplied: true },
    });
    kv.injectFailure();
    return { kv, pasteService, id };
  }

  function mutateMainMarker(state: InterruptedContentSave, mutate: (marker: Record<string, unknown>) => Record<string, unknown>): void {
    const entry = state.kv.entries.get(state.id)!;
    entry.metadata = mutate(entry.metadata as Record<string, unknown>);
  }

  function mutateSiblingMetadata(state: InterruptedContentSave, mutate: (metadata: Record<string, unknown>) => void): void {
    const entry = state.kv.entries.get(metaKey(state.id))!;
    const metadata = JSON.parse(entry.value) as Record<string, unknown>;
    mutate(metadata);
    entry.value = JSON.stringify(metadata);
  }

  function mutateCommitPrevious(state: InterruptedContentSave, mutate: (previous: Record<string, unknown>) => Record<string, unknown>): void {
    mutateMainMarker(state, (marker) => {
      const commit = marker.commit as Record<string, unknown>;
      return { ...marker, commit: { ...commit, previous: mutate(commit.previous as Record<string, unknown>) } };
    });
  }

  function mutateRevisionMarker(state: InterruptedContentSave, mutate: (marker: Record<string, unknown>) => Record<string, unknown>): void {
    const entry = state.kv.entries.get(revisionKey(state.id, 0))!;
    entry.metadata = mutate(entry.metadata as Record<string, unknown>);
  }

  const reconciliationProofMutations: Array<[string, (state: InterruptedContentSave) => void]> = [
    ["a revision gap", (state) => mutateMainMarker(state, (marker) => ({ ...marker, contentRevision: 3 }))],
    ["a revision in the wrong direction", (state) => mutateSiblingMetadata(state, (metadata) => { metadata.contentRevision = 3; })],
    ["a generation mismatch", (state) => mutateMainMarker(state, (marker) => ({ ...marker, generation: "00000000-0000-4000-8000-000000000002" }))],
    ["a main byte mismatch", (state) => mutateMainMarker(state, (marker) => ({ ...marker, byteLength: 1 }))],
    ["a missing commit", (state) => mutateMainMarker(state, (marker) => ({ ...marker, commit: null }))],
    ["a commit previous revision mismatch", (state) => mutateCommitPrevious(state, (previous) => ({ ...previous, revision: 2 }))],
    ["a commit previous slot mismatch", (state) => mutateCommitPrevious(state, (previous) => ({ ...previous, slot: 1 }))],
    ["a commit previous savedAt mismatch", (state) => mutateCommitPrevious(state, (previous) => ({ ...previous, savedAt: "2026-09-12T00:00:00.000Z" }))],
    ["a commit previous supersededAt mismatch", (state) => mutateCommitPrevious(state, (previous) => ({ ...previous, supersededAt: "2026-09-14T00:00:00.000Z" }))],
    ["a commit previous byteLength mismatch", (state) => mutateCommitPrevious(state, (previous) => ({ ...previous, byteLength: 1 }))],
    ["a missing predecessor slot", (state) => { state.kv.entries.delete(revisionKey(state.id, 0)); }],
    ["a revision marker generation mismatch", (state) => mutateRevisionMarker(state, (marker) => ({ ...marker, generation: "00000000-0000-4000-8000-000000000002" }))],
    ["a revision marker revision mismatch", (state) => mutateRevisionMarker(state, (marker) => ({ ...marker, revision: 2 }))],
    ["a revision marker savedAt mismatch", (state) => mutateRevisionMarker(state, (marker) => ({ ...marker, savedAt: "2026-09-12T00:00:00.000Z" }))],
    ["a revision marker supersededAt mismatch", (state) => mutateRevisionMarker(state, (marker) => ({ ...marker, supersededAt: "2026-09-14T00:00:00.000Z" }))],
    ["a revision marker byteLength mismatch", (state) => mutateRevisionMarker(state, (marker) => ({ ...marker, byteLength: 1 }))],
    ["a revision body byte mismatch", (state) => { state.kv.entries.get(revisionKey(state.id, 0))!.value = "x"; }],
  ];

  it.each(reconciliationProofMutations)("does not repair reconciliation with %s", async (_name, mutate) => {
    const state = await interruptedContentSave();
    mutate(state);
    const before = state.kv.operations.length;

    await expect(state.pasteService.loadContent(state.id, undefined)).rejects.toMatchObject({ code: "STORAGE_INCONSISTENT", status: 503 });
    expect(state.kv.operations.slice(before).some((operation) => operation.type === "put" || operation.type === "delete")).toBe(false);
  });

  it("fails closed for every non-provable one-revision marker mismatch", async () => {
    const kv = new RecordingKV();
    const pasteService = service(kv);
    await pasteService.create({ content: "v1", customId: "incoherent", expiration: "permanent" }, {});
    const marker = kv.entries.get("incoherent")!.metadata as Record<string, unknown>;
    kv.entries.get("incoherent")!.metadata = { ...marker, contentRevision: 2, commit: null };

    await expect(pasteService.loadContent("incoherent", undefined)).rejects.toMatchObject({
      code: "STORAGE_INCONSISTENT",
      status: 503,
    });
  });
});

describe("settings, password, expiry, and delete mutations", () => {
  async function withHistory(count: number, expiration: number | null = 3_600) {
    const kv = new RecordingKV();
    const pasteService = service(kv);
    let paste = await pasteService.create({ content: "v1", customId: `history${count}`, expiration }, {});
    for (let revision = 2; revision <= count + 1; revision += 1) {
      const result = await pasteService.updateContent(`history${count}`, { content: `v${revision}`, version: paste.version });
      paste = result.paste;
    }
    return { kv, pasteService, paste };
  }

  it("writes each changed settings field and a combined update as one metadata-only mutation", async () => {
    const { kv, pasteService, paste } = await withHistory(1, null);
    for (const input of [{ title: "Title" }, { format: "markdown" as const }, { viewOnce: true }, { title: "Next", format: "text" as const, viewOnce: false }]) {
      const before = kv.operations.length;
      const result = await pasteService.updateSettings("history1", input);
      expect(result.changed).toBe(true);
      expect(result.paste.contentRevision).toBe(2);
      expect(kv.operations.slice(before).filter((operation) => operation.type === "put").map((operation) => operation.key)).toEqual([
        metaKey("history1"),
      ]);
    }
    expect(JSON.parse(kv.entries.get(metaKey("history1"))!.value)).toMatchObject({
      title: "Next",
      format: "text",
      viewOnce: false,
      contentRevision: 2,
      history: { entries: [expect.objectContaining({ revision: 1 })] },
    });
    expect(paste.contentRevision).toBe(2);
  });

  it("returns a settings no-op without KV writes and rejects an empty settings mutation", async () => {
    const { kv, pasteService } = await withHistory(0, null);
    const before = kv.operations.length;

    await expect(pasteService.updateSettings("history0", { title: "" })).resolves.toMatchObject({ changed: false });
    expect(kv.operations).toHaveLength(before + 2);
    await expect(pasteService.updateSettings("history0", {})).rejects.toMatchObject({ code: "VALIDATION_FAILED", status: 422 });
  });

  it.each([0, 1, 2, 3])("rewrites all existing keys before metadata when expiration changes with %i history slots", async (historyCount) => {
    const { kv, pasteService } = await withHistory(historyCount);
    const id = `history${historyCount}`;
    const before = kv.operations.length;

    const result = await pasteService.updateSettings(id, { expiration: 60 });

    expect(result).toMatchObject({ changed: true, paste: { contentRevision: historyCount + 1, expiresAt: "2026-09-13T00:01:00.000Z" } });
    const puts = kv.operations.slice(before).filter((operation) => operation.type === "put");
    expect(puts.map((operation) => operation.key)).toEqual([
      contentKey(id),
      ...JSON.parse(kv.entries.get(metaKey(id))!.value).history.entries.map((entry: { slot: number }) => revisionKey(id, entry.slot)),
      metaKey(id),
    ]);
    const physical = kv.entries.get(metaKey(id))!.expiration;
    expect(physical).toBe(1_789_257_660);
    for (const key of [contentKey(id), ...JSON.parse(kv.entries.get(metaKey(id))!.value).history.entries.map((entry: { slot: number }) => revisionKey(id, entry.slot)), metaKey(id)]) {
      expect(kv.entries.get(key)?.expiration).toBe(physical);
    }
  });

  it("extends, shortens, and makes expiration permanent without making history revisions", async () => {
    const { kv, pasteService } = await withHistory(2, 3_600);

    await expect(pasteService.updateSettings("history2", { expiration: 7_200 })).resolves.toMatchObject({ changed: true, paste: { contentRevision: 3 } });
    await expect(pasteService.updateSettings("history2", { expiration: 60 })).resolves.toMatchObject({ changed: true, paste: { expiresAt: "2026-09-13T00:01:00.000Z", contentRevision: 3 } });
    await expect(pasteService.updateSettings("history2", { expiration: "permanent" })).resolves.toMatchObject({ changed: true, paste: { expiresAt: null, contentRevision: 3 } });
    for (const key of [contentKey("history2"), revisionKey("history2", 0), revisionKey("history2", 1), metaKey("history2")]) {
      expect(kv.entries.get(key)?.expiration).toBeUndefined();
    }
  });

  it("sets, changes, and clears passwords while preserving content history", async () => {
    const { kv, pasteService } = await withHistory(1, null);
    const beforeSet = kv.operations.length;
    const set = await pasteService.updatePassword("history1", { newPassword: "x".repeat(128) });
    expect(set).toMatchObject({ changed: true, paste: { protected: true, contentRevision: 2 } });
    expect(kv.operations.slice(beforeSet).filter((operation) => operation.type === "put").map((operation) => operation.key)).toEqual([metaKey("history1")]);

    await expect(pasteService.updatePassword("history1", { newPassword: "next" })).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    await expect(pasteService.updatePassword("history1", { password: "wrong", newPassword: "next" })).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    await expect(pasteService.updatePassword("history1", { password: "x".repeat(128), newPassword: "next" })).resolves.toMatchObject({ changed: true, paste: { protected: true } });
    await expect(pasteService.updatePassword("history1", { password: "next", newPassword: "" })).resolves.toMatchObject({ changed: true, paste: { protected: false, contentRevision: 2 } });
    await expect(pasteService.updatePassword("history1", { newPassword: "" })).resolves.toMatchObject({ changed: false });
    await expect(pasteService.updatePassword("history1", { newPassword: "x".repeat(129) })).rejects.toMatchObject({ code: "VALIDATION_FAILED", status: 422 });
  });

  it.each([0, 1, 2, 3])("refreshes current and %i active revision values before changing a near-expiry password", async (historyCount) => {
    const { kv, paste } = await withHistory(historyCount);
    const id = `history${historyCount}`;
    const nearExpiry = new PasteService(
      kv as unknown as KVNamespace,
      () => new Date("2026-09-13T00:59:30.000Z"),
      () => "00000000-0000-4000-8000-000000000001",
    );
    const before = kv.operations.length;

    const result = await nearExpiry.updatePassword(id, { newPassword: "next", version: paste.version });

    expect(result).toMatchObject({ changed: true, paste: { protected: true, contentRevision: historyCount + 1 } });
    const revisionKeys = JSON.parse(kv.entries.get(metaKey(id))!.value).history.entries.map((entry: { slot: number }) => revisionKey(id, entry.slot));
    expect(kv.operations.slice(before).filter((operation) => operation.type === "put").map((operation) => operation.key)).toEqual([
      contentKey(id),
      ...revisionKeys,
      metaKey(id),
    ]);
    for (const key of [contentKey(id), ...revisionKeys, metaKey(id)]) {
      expect(kv.entries.get(key)?.expiration).toBe(1_789_261_230);
    }
    expect(JSON.parse(kv.entries.get(metaKey(id))!.value)).toMatchObject({ physicalExpiration: 1_789_261_230 });
  });

  const changedExpirySettingsFailures = [0, 1, 2, 3].flatMap((historyCount) => {
    const metadataOffset = 4 + historyCount * 2;
    return [3, ...Array.from({ length: historyCount }, (_, index) => 5 + index * 2), metadataOffset].map((failureOffset) => [
      historyCount,
      failureOffset,
      failureOffset === metadataOffset,
    ] as const);
  });

  it.each(changedExpirySettingsFailures)("reports changed-expiry settings failure for %i history revisions at operation %i", async (historyCount, failureOffset, mutationMayHaveApplied) => {
    const { kv, pasteService } = await withHistory(historyCount);
    const id = `history${historyCount}`;
    const before = kv.operations.length;
    const revisionKeys = JSON.parse(kv.entries.get(metaKey(id))!.value).history.entries.map((entry: { slot: number }) => revisionKey(id, entry.slot));
    const expectedOperations = [
      `getWithMetadata:${contentKey(id)}`,
      `get:${metaKey(id)}`,
      `put:${contentKey(id)}`,
      ...revisionKeys.flatMap((key: string) => [`getWithMetadata:${key}`, `put:${key}`]),
      `put:${metaKey(id)}`,
    ];
    kv.injectFailure(before + failureOffset);

    await expect(pasteService.updateSettings(id, { expiration: 60 })).rejects.toMatchObject({
      code: "STORAGE_WRITE_FAILED",
      status: 503,
      details: { retryable: true, mutationMayHaveApplied },
    });
    expect(kv.operations.slice(before).map((operation) => `${operation.type}:${operation.key}`)).toEqual(expectedOperations.slice(0, failureOffset));
  });

  const changedExpiryPasswordFailures = [0, 1, 2, 3].flatMap((historyCount) => {
    const metadataOffset = 4 + historyCount * 2;
    return [3, ...Array.from({ length: historyCount }, (_, index) => 5 + index * 2), metadataOffset].map((failureOffset) => [
      historyCount,
      failureOffset,
      failureOffset === metadataOffset,
    ] as const);
  });

  it.each(changedExpiryPasswordFailures)("reports changed-expiry password failure for %i history revisions at operation %i", async (historyCount, failureOffset, mutationMayHaveApplied) => {
    const { kv, paste } = await withHistory(historyCount);
    const id = `history${historyCount}`;
    const nearExpiry = new PasteService(
      kv as unknown as KVNamespace,
      () => new Date("2026-09-13T00:59:30.000Z"),
      () => "00000000-0000-4000-8000-000000000001",
    );
    const before = kv.operations.length;
    const revisionKeys = JSON.parse(kv.entries.get(metaKey(id))!.value).history.entries.map((entry: { slot: number }) => revisionKey(id, entry.slot));
    const expectedOperations = [
      `getWithMetadata:${contentKey(id)}`,
      `get:${metaKey(id)}`,
      `put:${contentKey(id)}`,
      ...revisionKeys.flatMap((key: string) => [`getWithMetadata:${key}`, `put:${key}`]),
      `put:${metaKey(id)}`,
    ];
    kv.injectFailure(before + failureOffset);

    await expect(nearExpiry.updatePassword(id, { newPassword: "next", version: paste.version })).rejects.toMatchObject({
      code: "STORAGE_WRITE_FAILED",
      status: 503,
      details: { retryable: true, mutationMayHaveApplied },
    });
    expect(kv.operations.slice(before).map((operation) => `${operation.type}:${operation.key}`)).toEqual(expectedOperations.slice(0, failureOffset));
  });

  const nearExpiryContentFailures: Array<[number, string, number, boolean]> = [0, 1, 2, 3].flatMap((historyCount) => {
    const activeRevisionCount = historyCount - (historyCount === 3 ? 1 : 0);
    const mainOffset = 4 + activeRevisionCount * 2;
    return [
      [historyCount, "target revision", 3, false],
      ...Array.from({ length: activeRevisionCount }, (_, index): [number, string, number, boolean] => [historyCount, `active revision ${index + 1}`, 5 + index * 2, false]),
      [historyCount, "main", mainOffset, false],
      [historyCount, "metadata", mainOffset + 1, true],
    ];
  });

  it.each(nearExpiryContentFailures)("reports near-expiry content failure with %i history revisions at %s write %i", async (historyCount, target, failureOffset, mutationMayHaveApplied) => {
    const { kv, paste } = await withHistory(historyCount);
    const id = `history${historyCount}`;
    const nearExpiry = new PasteService(
      kv as unknown as KVNamespace,
      () => new Date("2026-09-13T00:59:30.000Z"),
      () => "00000000-0000-4000-8000-000000000001",
    );
    const before = kv.operations.length;
    const metadata = JSON.parse(kv.entries.get(metaKey(id))!.value) as { history: { nextSlot: number; entries: Array<{ slot: number }> } };
    const targetKey = revisionKey(id, metadata.history.nextSlot);
    const activeRevisionKeys = metadata.history.entries
      .filter((entry) => entry.slot !== metadata.history.nextSlot)
      .map((entry) => revisionKey(id, entry.slot));
    const expectedOperations = [
      `getWithMetadata:${contentKey(id)}`,
      `get:${metaKey(id)}`,
      `put:${targetKey}`,
      ...activeRevisionKeys.flatMap((key) => [`getWithMetadata:${key}`, `put:${key}`]),
      `put:${contentKey(id)}`,
      `put:${metaKey(id)}`,
    ];
    kv.injectFailure(before + failureOffset);

    await expect(nearExpiry.updateContent(id, { content: `v${historyCount + 2}`, version: paste.version })).rejects.toMatchObject({
      code: "STORAGE_WRITE_FAILED",
      status: 503,
      details: { retryable: true, mutationMayHaveApplied },
    });
    expect(kv.operations.slice(before).map((operation) => `${operation.type}:${operation.key}`)).toEqual(expectedOperations.slice(0, failureOffset));
    expect(kv.operations.slice(before + failureOffset)).toEqual([]);
  });

  it("authorizes and version-checks delete before deleting main, three slots, and metadata", async () => {
    const { kv, pasteService, paste } = await withHistory(1, null);
    await expect(pasteService.delete("history1", undefined, "stale")).rejects.toMatchObject({ code: "VERSION_CONFLICT", status: 409 });
    const before = kv.operations.length;

    await pasteService.delete("history1", undefined, paste.version);

    expect(kv.operations.slice(before).filter((operation) => operation.type === "delete").map((operation) => operation.key)).toEqual([
      contentKey("history1"),
      revisionKey("history1", 0),
      revisionKey("history1", 1),
      revisionKey("history1", 2),
      metaKey("history1"),
    ]);
    expect([...kv.entries.keys()]).toEqual([pendingKey("history1")]);
  });

  it.each([4, 5, 6, 7, 8])("attempts every delete and reports partial delete failure %i", async (failureOffset) => {
    const { kv, pasteService } = await withHistory(0, null);
    kv.injectFailure(kv.operations.length + failureOffset);

    await expect(pasteService.delete("history0", undefined)).rejects.toMatchObject({
      code: "STORAGE_WRITE_FAILED",
      status: 503,
      details: { mutationMayHaveApplied: true },
    });
    expect(kv.operations.filter((operation) => operation.type === "delete").slice(-5).map((operation) => operation.key)).toEqual([
      contentKey("history0"),
      revisionKey("history0", 0),
      revisionKey("history0", 1),
      revisionKey("history0", 2),
      metaKey("history0"),
    ]);
  });
});

describe("history reads", () => {
  async function historyService() {
    const kv = new RecordingKV();
    const pasteService = service(kv);
    let paste = await pasteService.create({ content: "v1", customId: "snapshots", expiration: "permanent" }, {});
    for (const content of ["v2", "v3", "v4"]) {
      paste = (await pasteService.updateContent("snapshots", { content, version: paste.version })).paste;
    }
    return { kv, pasteService, paste };
  }

  it("lists prior descriptors newest-first without slot details and returns verified snapshots", async () => {
    const { pasteService, paste } = await historyService();

    await expect(pasteService.listHistory("snapshots", undefined)).resolves.toEqual({
      id: "snapshots",
      currentRevision: 4,
      currentVersion: paste.version,
      revisions: [
        expect.objectContaining({ revision: 3, savedAt: now.toISOString(), supersededAt: now.toISOString(), byteLength: 2 }),
        expect.objectContaining({ revision: 2, savedAt: now.toISOString(), supersededAt: now.toISOString(), byteLength: 2 }),
        expect.objectContaining({ revision: 1, savedAt: now.toISOString(), supersededAt: now.toISOString(), byteLength: 2 }),
      ],
    });
    const snapshot = await pasteService.getHistory("snapshots", "3", undefined);
    expect(snapshot).toEqual({
      id: "snapshots",
      revision: 3,
      savedAt: now.toISOString(),
      supersededAt: now.toISOString(),
      byteLength: 2,
      content: "v3",
    });
  });

  it.each(["0", "01", "+1", "1.5", "9007199254740992", "Infinity"])("rejects invalid revision path %s", async (revision) => {
    const { pasteService } = await historyService();
    await expect(pasteService.getHistory("snapshots", revision, undefined)).rejects.toMatchObject({ code: "BAD_REQUEST", status: 400 });
  });

  it("returns 404 for an absent descriptor and 503 for a missing revision slot", async () => {
    const { kv, pasteService } = await historyService();
    await expect(pasteService.getHistory("snapshots", "99", undefined)).rejects.toMatchObject({ code: "REVISION_NOT_FOUND", status: 404 });
    const descriptor = JSON.parse(kv.entries.get(metaKey("snapshots"))!.value).history.entries[0] as { slot: number };
    kv.entries.delete(revisionKey("snapshots", descriptor.slot));
    await expect(pasteService.getHistory("snapshots", "3", undefined)).rejects.toMatchObject({ code: "STORAGE_INCONSISTENT", status: 503 });
  });

  it.each([
    ["generation", (marker: Record<string, unknown>) => ({ ...marker, generation: "00000000-0000-4000-8000-000000000002" })],
    ["revision", (marker: Record<string, unknown>) => ({ ...marker, revision: 2 })],
    ["savedAt", (marker: Record<string, unknown>) => ({ ...marker, savedAt: "2026-09-12T00:00:00.000Z" })],
    ["supersededAt", (marker: Record<string, unknown>) => ({ ...marker, supersededAt: "2026-09-14T00:00:00.000Z" })],
    ["byteLength", (marker: Record<string, unknown>) => ({ ...marker, byteLength: 1 })],
  ])("fails closed when a revision %s marker disagrees with its descriptor", async (_name, mutate) => {
    const { kv, pasteService } = await historyService();
    const descriptor = JSON.parse(kv.entries.get(metaKey("snapshots"))!.value).history.entries[0] as { slot: number };
    const entry = kv.entries.get(revisionKey("snapshots", descriptor.slot))!;
    entry.metadata = mutate(entry.metadata as Record<string, unknown>);

    await expect(pasteService.getHistory("snapshots", "3", undefined)).rejects.toMatchObject({ code: "STORAGE_INCONSISTENT", status: 503 });
  });

  it("forbids view-once history before reading a revision body", async () => {
    const { kv, pasteService } = await historyService();
    await pasteService.updateSettings("snapshots", { viewOnce: true });
    const before = kv.operations.length;

    await expect(pasteService.getHistory("snapshots", "3", undefined)).rejects.toMatchObject({
      code: "VIEW_ONCE_HISTORY_FORBIDDEN",
      status: 409,
    });
    expect(kv.operations.slice(before).some((operation) => operation.key.startsWith("__cfpb:rev:"))).toBe(false);
    await expect(pasteService.listHistory("snapshots", undefined)).rejects.toMatchObject({ code: "VIEW_ONCE_HISTORY_FORBIDDEN", status: 409 });
  });
});

describe("first-mutation legacy migration", () => {
  const legacyCreatedAt = "2026-09-12T23:30:00.000Z";

  function legacy(kv = new RecordingKV(), id = "legacy-mutate", metadata: unknown = {}) {
    kv.seed(id, "old", metadata);
    return { kv, pasteService: service(kv), id };
  }

  it("migrates a content change once, preserving valid legacy timestamps and expiry", async () => {
    const { kv, pasteService, id } = legacy(undefined, "legacy-content", {
      title: "Old title",
      country: "US",
      createdAt: Date.parse(legacyCreatedAt),
      expiration: 3_600,
    });
    const before = kv.operations.length;

    const result = await pasteService.updateContent(id, { content: "new", version: "legacy" });

    expect(result).toMatchObject({
      changed: true,
      paste: {
        version: expect.stringMatching(/^00000000-0000-4000-8000-000000000001\.1$/),
        contentRevision: 2,
        title: "Old title",
        createdAt: legacyCreatedAt,
        expiresAt: "2026-09-13T00:30:00.000Z",
        createdCountry: "US",
      },
    });
    expect(kv.operations.slice(before).filter((operation) => operation.type === "put").map((operation) => operation.key)).toEqual([
      metaKey(id),
      revisionKey(id, 0),
      contentKey(id),
    ]);
    expect(JSON.parse(kv.entries.get(metaKey(id))!.value)).toMatchObject({
      versionCounter: 1,
      contentRevision: 2,
      createdAt: legacyCreatedAt,
      currentSavedAt: now.toISOString(),
      history: { nextSlot: 1, entries: [expect.objectContaining({ revision: 1, slot: 0, savedAt: legacyCreatedAt })] },
    });
    expect(kv.entries.get(revisionKey(id, 0))?.value).toBe("old");
    expect(kv.entries.get(contentKey(id))?.value).toBe("new");
  });

  it("uses mutation time and permanent expiry for unknown legacy metadata during settings migration", async () => {
    const { kv, pasteService, id } = legacy(undefined, "legacy-settings", { title: "legacy" });

    const result = await pasteService.updateSettings(id, { title: "changed" });

    expect(result).toMatchObject({ changed: true, paste: { version: expect.stringMatching(/\.1$/), contentRevision: 1, createdAt: now.toISOString(), expiresAt: null } });
    expect(JSON.parse(kv.entries.get(metaKey(id))!.value)).toMatchObject({
      title: "changed",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      currentSavedAt: now.toISOString(),
      expiresAt: null,
      expiration: { kind: "permanent" },
      history: { nextSlot: 0, entries: [] },
    });
    expect(kv.entries.get(contentKey(id))?.expiration).toBeUndefined();
  });

  it("combines a password mutation with migration as one version and preserves a legacy timestamp", async () => {
    const { kv, pasteService, id } = legacy(undefined, "legacy-password", { createdAt: Date.parse(legacyCreatedAt), expiration: 3_600 });

    const result = await pasteService.updatePassword(id, { newPassword: "new-password", version: "legacy" });

    expect(result).toMatchObject({ changed: true, paste: { version: expect.stringMatching(/\.1$/), protected: true, contentRevision: 1, createdAt: legacyCreatedAt, expiresAt: "2026-09-13T00:30:00.000Z" } });
    expect(JSON.parse(kv.entries.get(metaKey(id))!.value)).toMatchObject({
      password: "new-password",
      createdAt: legacyCreatedAt,
      updatedAt: now.toISOString(),
      currentSavedAt: legacyCreatedAt,
      versionCounter: 1,
      contentRevision: 1,
      history: { nextSlot: 0, entries: [] },
    });
    expect(kv.entries.has(revisionKey(id, 0))).toBe(false);
  });

  const legacyMigrationFailures: Array<["content" | "settings" | "password", number, boolean]> = [
    ["content", 3, false],
    ["content", 4, true],
    ["content", 5, true],
    ["settings", 3, false],
    ["settings", 4, true],
    ["password", 3, false],
    ["password", 4, true],
  ];

  it.each(legacyMigrationFailures)("reports legacy %s migration failure after write %i", async (kind, failureOffset, mutationMayHaveApplied) => {
    const id = `legacy-${kind}-${failureOffset}`;
    const { kv, pasteService } = legacy(undefined, id, { createdAt: Date.parse(legacyCreatedAt), expiration: 3_600 });
    const expectedOperations = kind === "content"
      ? [
          `getWithMetadata:${id}`,
          `get:${metaKey(id)}`,
          `put:${metaKey(id)}`,
          `put:${revisionKey(id, 0)}`,
          `put:${contentKey(id)}`,
        ]
      : [
          `getWithMetadata:${id}`,
          `get:${metaKey(id)}`,
          `put:${metaKey(id)}`,
          `put:${contentKey(id)}`,
        ];
    const action = kind === "content"
      ? () => pasteService.updateContent(id, { content: "new", version: "legacy" })
      : kind === "settings"
        ? () => pasteService.updateSettings(id, { title: "new", version: "legacy" })
        : () => pasteService.updatePassword(id, { newPassword: "new", version: "legacy" });
    kv.injectFailure(failureOffset);

    await expect(action()).rejects.toMatchObject({
      code: "STORAGE_WRITE_FAILED",
      status: 503,
      details: { retryable: true, mutationMayHaveApplied },
    });
    expect(kv.operations.map((operation) => `${operation.type}:${operation.key}`)).toEqual(expectedOperations.slice(0, failureOffset));
  });

  it("requires legacy or omitted version, leaves a legacy content no-op unwritten, and never migrates delete", async () => {
    const { kv, pasteService, id } = legacy();
    const before = kv.operations.length;
    await expect(pasteService.updateContent(id, { content: "old", version: "legacy" })).resolves.toMatchObject({ changed: false, paste: { version: "legacy" } });
    expect(kv.operations).toHaveLength(before + 2);
    await expect(pasteService.updateContent(id, { content: "new", version: "stale" })).rejects.toMatchObject({ code: "VERSION_CONFLICT", status: 409 });

    await pasteService.delete(id, undefined, "legacy");
    expect(kv.entries.has(metaKey(id))).toBe(false);
    expect([...kv.entries.keys()]).toEqual([pendingKey(id)]);
  });
});

describe("mutation boundaries", () => {
  it.each([
    [3, false],
    [4, false],
    [5, true],
  ])("reports content write failure %i with its application state", async (failureOffset, mutationMayHaveApplied) => {
    const kv = new RecordingKV();
    const pasteService = service(kv);
    await pasteService.create({ content: "old", customId: "content-fail", expiration: "permanent" }, {});
    kv.injectFailure(kv.operations.length + failureOffset);

    await expect(pasteService.updateContent("content-fail", { content: "new" })).rejects.toMatchObject({
      code: "STORAGE_WRITE_FAILED",
      details: { mutationMayHaveApplied },
    });
  });

  it("rewrites changed-expiry active history between target revision and main content", async () => {
    const kv = new RecordingKV();
    const initial = service(kv);
    let paste = await initial.create({ content: "v1", customId: "content-expiry", expiration: 3_600 }, {});
    paste = (await initial.updateContent("content-expiry", { content: "v2", version: paste.version })).paste;
    const later = new PasteService(
      kv as unknown as KVNamespace,
      () => new Date("2026-09-13T00:59:30.000Z"),
      () => "00000000-0000-4000-8000-000000000001",
    );
    const before = kv.operations.length;

    await later.updateContent("content-expiry", { content: "v3", version: paste.version });

    expect(kv.operations.slice(before).filter((operation) => operation.type === "put").map((operation) => operation.key)).toEqual([
      revisionKey("content-expiry", 1),
      revisionKey("content-expiry", 0),
      contentKey("content-expiry"),
      metaKey("content-expiry"),
    ]);
    const physical = 1_789_261_230;
    for (const key of [contentKey("content-expiry"), revisionKey("content-expiry", 0), revisionKey("content-expiry", 1), metaKey("content-expiry")]) {
      expect(kv.entries.get(key)?.expiration).toBe(physical);
    }
  });

  it("rejects reconciliation when its predecessor slot or marker proof is absent", async () => {
    const kv = new RecordingKV();
    const pasteService = service(kv);
    await pasteService.create({ content: "v1", customId: "unproved", expiration: "permanent" }, {});
    const marker = kv.entries.get("unproved")!.metadata as Record<string, unknown>;
    kv.entries.get("unproved")!.metadata = {
      ...marker,
      contentRevision: 2,
      commit: {
        versionCounter: 2,
        previous: { revision: 1, slot: 0, savedAt: now.toISOString(), supersededAt: now.toISOString(), byteLength: 2 },
      },
    };

    await expect(pasteService.loadContent("unproved", undefined)).rejects.toMatchObject({ code: "STORAGE_INCONSISTENT", status: 503 });
    expect(kv.entries.has(metaKey("unproved"))).toBe(true);
  });

  it("keeps equivalent permanent and absolute settings as no-ops but reapplies relative expiry", async () => {
    const permanentKv = new RecordingKV();
    const permanent = service(permanentKv);
    await permanent.create({ content: "x", customId: "permanent-noop", expiration: "permanent" }, {});
    const permanentBefore = permanentKv.operations.length;
    await expect(permanent.updateSettings("permanent-noop", { expiration: "permanent" })).resolves.toMatchObject({ changed: false });
    expect(permanentKv.operations).toHaveLength(permanentBefore + 2);

    const absoluteKv = new RecordingKV();
    const absolute = service(absoluteKv);
    const timestamp = "2026-09-13T01:00:00.000Z";
    await absolute.create({ content: "x", customId: "absolute-noop", expiration: timestamp }, {});
    await expect(absolute.updateSettings("absolute-noop", { expiration: timestamp })).resolves.toMatchObject({ changed: false });

    const relative = service();
    await relative.create({ content: "x", customId: "relative-refresh", expiration: 60 }, {});
    await expect(relative.updateSettings("relative-refresh", { expiration: 60 })).resolves.toMatchObject({ changed: true, paste: { expiresAt: "2026-09-13T00:01:00.000Z" } });
  });

  it("reports metadata-only settings and password write failures as not applied", async () => {
    for (const [id, mutate] of [
      ["setting-fail", (pasteService: PasteService) => pasteService.updateSettings("setting-fail", { title: "next" })],
      ["password-fail", (pasteService: PasteService) => pasteService.updatePassword("password-fail", { newPassword: "next" })],
    ] as const) {
      const kv = new RecordingKV();
      const pasteService = service(kv);
      await pasteService.create({ content: "content", customId: id, expiration: "permanent" }, {});
      kv.injectFailure(kv.operations.length + 3);
      await expect(mutate(pasteService)).rejects.toMatchObject({
        code: "STORAGE_WRITE_FAILED",
        details: { mutationMayHaveApplied: false },
      });
    }
  });

  it("does not write a password no-op and rejects unauthorized delete before deleting", async () => {
    const kv = new RecordingKV();
    const pasteService = service(kv);
    await pasteService.create({ content: "content", customId: "password-delete", password: "secret", expiration: "permanent" }, {});
    const before = kv.operations.length;
    await expect(pasteService.updatePassword("password-delete", { password: "secret", newPassword: "secret" })).resolves.toMatchObject({ changed: false });
    expect(kv.operations).toHaveLength(before + 2);
    const deletes = kv.operations.filter((operation) => operation.type === "delete").length;
    await expect(pasteService.delete("password-delete", "wrong")).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    expect(kv.operations.filter((operation) => operation.type === "delete")).toHaveLength(deletes);
  });

  it("does not expose history slots and rejects a descriptor whose slot points elsewhere", async () => {
    const kv = new RecordingKV();
    const pasteService = service(kv);
    let paste = await pasteService.create({ content: "v1", customId: "slot-check", expiration: "permanent" }, {});
    paste = (await pasteService.updateContent("slot-check", { content: "v2", version: paste.version })).paste;
    const listed = await pasteService.listHistory("slot-check", undefined);
    expect(listed.revisions[0]).not.toHaveProperty("slot");
    const metadata = JSON.parse(kv.entries.get(metaKey("slot-check"))!.value);
    metadata.history.entries[0].slot = 1;
    kv.entries.get(metaKey("slot-check"))!.value = JSON.stringify(metadata);
    await expect(pasteService.getHistory("slot-check", "1", undefined)).rejects.toMatchObject({ code: "STORAGE_INCONSISTENT", status: 503 });
  });
});
