import { describe, expect, it } from "vitest";
import { PasteSync, classifyRemote } from "./paste-sync";
import type { PasteSyncCapture, PasteSyncEvent, PasteSyncReadRequest, PasteSyncReadResult } from "./paste-sync";
import type { PasteSummary, RemoteSnapshot } from "./contracts";

type TimerCallback = () => void;

class FakeClock {
  now = 0;
  private nextId = 1;
  private timers = new Map<number, { at: number; callback: TimerCallback }>();
  maxActiveTimers = 0;

  setTimeout = (callback: TimerCallback, delay: number): number => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.now + delay, callback });
    this.maxActiveTimers = Math.max(this.maxActiveTimers, this.timers.size);
    return id;
  };

  clearTimeout = (id: number): void => {
    this.timers.delete(id);
  };

  advance(milliseconds: number): void {
    const target = this.now + milliseconds;
    let callbacks = 0;

    for (;;) {
      let next: [number, { at: number; callback: TimerCallback }] | undefined;
      for (const timer of this.timers.entries()) {
        if (timer[1].at <= target && (!next || timer[1].at < next[1].at)) {
          next = timer;
        }
      }
      if (!next) break;
      this.timers.delete(next[0]);
      this.now = next[1].at;
      if (++callbacks > 1_000) throw new Error("timer did not advance");
      next[1].callback();
    }

    this.now = target;
  }

  activeTimerCount(): number {
    return this.timers.size;
  }
}

interface PendingRead {
  request: PasteSyncReadRequest;
  resolve: (result: PasteSyncReadResult) => void;
  reject: (reason: unknown) => void;
}

const etag = '"sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"' as const;

function summary(overrides: Partial<PasteSummary> = {}): PasteSummary {
  return {
    id: "paste-id",
    title: "Untitled",
    format: "text",
    viewOnce: false,
    protected: false,
    createdAt: "2026-09-13T00:00:00.000Z",
    updatedAt: "2026-09-13T00:00:00.000Z",
    expiresAt: null,
    expiration: { kind: "permanent" },
    version: "generation-a.1",
    contentRevision: 1,
    contentBytes: 5,
    createdCountry: null,
    links: {
      view: "/p/paste-id",
      raw: "/p/paste-id/raw",
      html: "/p/paste-id/html",
      markdown: "/p/paste-id/markdown",
      file: "/p/paste-id/file",
    },
    ...overrides,
  };
}

function capture(overrides: Partial<PasteSyncCapture> = {}): PasteSyncCapture {
  return {
    phase: "ordinary",
    activeUntil: 300_000,
    locallyClean: true,
    offline: false,
    localGeneration: 0,
    acceptedApplyGeneration: 0,
    baseline: {
      acceptedApplyGeneration: 0,
      localGeneration: 0,
      generation: "generation-a",
      version: "generation-a.1",
      contentRevision: 1,
      updatedAt: "2026-09-13T00:00:00.000Z",
      acceptedSource: "local",
    },
    responseEtag: etag,
    ...overrides,
  };
}

function snapshot(overrides: Partial<RemoteSnapshot> = {}): RemoteSnapshot {
  return {
    etag,
    source: "local",
    summary: summary(),
    identity: { kind: "v2", generation: "generation-a", versionCounter: 1 },
    contentRevision: 1,
    updatedAtMs: Date.parse("2026-09-13T00:00:00.000Z"),
    ...overrides,
  };
}

function syncFixture({ loadAt }: { loadAt: number }) {
  const clock = new FakeClock();
  clock.now = loadAt;
  let currentCapture = capture();
  const reads: PendingRead[] = [];
  const events: PasteSyncEvent[] = [];
  const controller = new PasteSync({
    now: () => clock.now,
    timer: {
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    },
    AbortController,
    capture: () => currentCapture,
    read: (request) => new Promise<PasteSyncReadResult>((resolve, reject) => {
      reads.push({ request, resolve, reject });
    }),
    emit: (event) => events.push(event),
  });

  controller.start(loadAt);

  return {
    clock,
    controller,
    events,
    reads,
    setCapture(next: PasteSyncCapture) {
      currentCapture = next;
    },
    resolve304(index: number, responseEtag = etag) {
      reads[index]?.resolve({ status: 304, etag: responseEtag });
    },
    resolve200(index: number, remote = snapshot()) {
      reads[index]?.resolve({ status: 200, snapshot: remote });
    },
    resolveStatus(index: number, status: 403 | 404 | 409 | 503) {
      reads[index]?.resolve({ status });
    },
    reject(index: number, reason: unknown) {
      reads[index]?.reject(reason);
    },
    async flush() {
      await Promise.resolve();
      await Promise.resolve();
    },
    lastState() {
      return [...events].reverse().find((event): event is Extract<PasteSyncEvent, { type: "state" }> => event.type === "state")?.state;
    },
    activeTimerCount() {
      return clock.activeTimerCount();
    },
  };
}

describe("PasteSync timing", () => {
  it("uses one timer for cadence and the exclusive active deadline", async () => {
    const fixture = syncFixture({ loadAt: 0 });

    fixture.clock.advance(2_999);
    expect(fixture.reads).toHaveLength(0);
    fixture.clock.advance(1);
    expect(fixture.reads).toHaveLength(1);
    fixture.resolve304(0);
    await fixture.flush();

    fixture.clock.advance(296_999);
    expect(fixture.lastState()).not.toBe("inactive");
    fixture.clock.advance(1);
    expect(fixture.lastState()).toBe("inactive");
    expect(fixture.activeTimerCount()).toBe(0);
    expect(fixture.clock.maxActiveTimers).toBe(1);
  });

  it("drops a due check when capture becomes locally dirty", () => {
    const fixture = syncFixture({ loadAt: 0 });
    fixture.setCapture(capture({ locallyClean: false }));

    fixture.clock.advance(3_000);

    expect(fixture.reads).toHaveLength(0);
    expect(fixture.lastState()).toBe("paused-local");
    expect(fixture.activeTimerCount()).toBe(1);
  });

  it("waits a complete 3,000 ms from request settlement", async () => {
    const fixture = syncFixture({ loadAt: 0 });

    fixture.clock.advance(3_000);
    fixture.clock.advance(1_000);
    fixture.resolve304(0);
    await fixture.flush();

    fixture.clock.advance(2_999);
    expect(fixture.reads).toHaveLength(1);
    fixture.clock.advance(1);
    expect(fixture.reads).toHaveLength(2);
  });

  it("dispatches at 299,999 ms but not at the exclusive deadline", () => {
    const fixture = syncFixture({ loadAt: 0 });

    fixture.controller.localWorkChanged();
    fixture.clock.advance(296_999);
    fixture.controller.localWorkSettled(fixture.clock.now);
    fixture.clock.advance(3_000);
    expect(fixture.reads).toHaveLength(1);
    fixture.clock.advance(1);

    expect(fixture.reads).toHaveLength(1);
    expect(fixture.lastState()).toBe("inactive");
  });

  it("caps instant clean responses at 99 GETs", async () => {
    const fixture = syncFixture({ loadAt: 0 });

    for (let request = 0; request < 99; request += 1) {
      fixture.clock.advance(3_000);
      expect(fixture.reads).toHaveLength(request + 1);
      fixture.resolve304(request);
      await fixture.flush();
    }

    fixture.clock.advance(3_000);
    expect(fixture.reads).toHaveLength(99);
    expect(fixture.lastState()).toBe("inactive");
    expect(fixture.clock.maxActiveTimers).toBe(1);
  });
});

describe("classifyRemote", () => {
  it("compares all three markers only within the same v2 generation", () => {
    const baseline = capture().baseline;
    const older = snapshot({ updatedAtMs: Date.parse("2026-09-12T00:00:00.000Z") });
    const newer = snapshot({
      identity: { kind: "v2", generation: "generation-a", versionCounter: 2 },
      contentRevision: 2,
      updatedAtMs: Date.parse("2026-09-14T00:00:00.000Z"),
    });
    const mixed = snapshot({
      identity: { kind: "v2", generation: "generation-a", versionCounter: 2 },
      updatedAtMs: Date.parse("2026-09-12T00:00:00.000Z"),
    });
    const otherGeneration = snapshot({
      identity: { kind: "v2", generation: "generation-b", versionCounter: 2 },
      contentRevision: 2,
      updatedAtMs: Date.parse("2026-09-14T00:00:00.000Z"),
    });

    expect(classifyRemote(older, baseline)).toBe("definitely-older");
    expect(classifyRemote(newer, baseline)).toBe("definitely-newer");
    expect(classifyRemote(snapshot(), baseline)).toBe("marker-equal");
    expect(classifyRemote(mixed, baseline)).toBe("incomparable");
    expect(classifyRemote(otherGeneration, baseline)).toBe("incomparable");
  });

  it("keeps legacy equal markers distinct from legacy divergence", () => {
    const baseline = {
      ...capture().baseline,
      generation: "legacy" as const,
      version: "legacy-version",
    };
    const equalLegacy = snapshot({ identity: { kind: "legacy" }, summary: summary({ version: "legacy-version" }) });
    const divergentLegacy = snapshot({
      identity: { kind: "legacy" },
      contentRevision: 2,
      summary: summary({ version: "legacy-version", contentRevision: 2 }),
    });

    expect(classifyRemote(equalLegacy, baseline)).toBe("marker-equal");
    expect(classifyRemote(divergentLegacy, baseline)).toBe("incomparable");
  });
});

describe("PasteSync ordering and recovery", () => {
  it("emits unchanged only for an exact 200 and retains marker-equal source divergence as a candidate", async () => {
    const fixture = syncFixture({ loadAt: 0 });

    fixture.clock.advance(3_000);
    fixture.resolve200(0, snapshot());
    await fixture.flush();
    expect(fixture.events).toContainEqual({ type: "unchanged", etag, checkedAt: 3_000 });
    expect(fixture.lastState()).toBe("unchanged");

    fixture.clock.advance(3_000);
    fixture.resolve200(1, snapshot({ source: "remote", summary: summary({ contentBytes: 6 }) }));
    await fixture.flush();
    expect(fixture.events.at(-2)).toMatchObject({ type: "candidate", snapshot: { source: "remote" }, checkedAt: 6_000 });
    expect(fixture.lastState()).toBe("conflict");
  });

  it("auto-publishes only definitely-newer snapshots", async () => {
    const fixtures = [
      {
        remote: snapshot({
          identity: { kind: "v2", generation: "generation-a", versionCounter: 2 },
          contentRevision: 2,
          updatedAtMs: Date.parse("2026-09-14T00:00:00.000Z"),
        }),
        event: "proven-newer",
      },
      { remote: snapshot({ updatedAtMs: Date.parse("2026-09-12T00:00:00.000Z") }), event: "candidate" },
      { remote: snapshot({ source: "remote" }), event: "candidate" },
      { remote: snapshot({ etag: '"sha256-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"' }), event: "candidate" },
      {
        remote: snapshot({
          identity: { kind: "v2", generation: "generation-a", versionCounter: 2 },
          updatedAtMs: Date.parse("2026-09-12T00:00:00.000Z"),
        }),
        event: "candidate",
      },
      {
        remote: snapshot({ identity: { kind: "v2", generation: "generation-b", versionCounter: 2 } }),
        event: "candidate",
      },
    ] as const;

    for (const expected of fixtures) {
      const fixture = syncFixture({ loadAt: 0 });
      fixture.clock.advance(3_000);
      fixture.resolve200(0, expected.remote);
      await fixture.flush();

      expect(fixture.events.find((event) => event.type === expected.event)).toBeDefined();
      expect(fixture.events.some((event) => event.type === "proven-newer")).toBe(expected.event === "proven-newer");
    }
  });

  it("retains repeated candidates and gives Keep current and Retry full cadences", async () => {
    const fixture = syncFixture({ loadAt: 0 });
    const candidate = snapshot({ source: "remote" });

    fixture.clock.advance(3_000);
    fixture.resolve200(0, candidate);
    await fixture.flush();
    fixture.controller.keepCurrent(fixture.clock.now);
    fixture.clock.advance(2_999);
    expect(fixture.reads).toHaveLength(1);
    fixture.clock.advance(1);
    fixture.resolve200(1, candidate);
    await fixture.flush();

    expect(fixture.events.filter((event) => event.type === "candidate")).toHaveLength(2);
    expect(fixture.lastState()).toBe("conflict");
    expect(fixture.controller.retrySync(fixture.clock.now, "pending-password")).toBe(true);
    fixture.clock.advance(2_999);
    expect(fixture.reads).toHaveLength(2);
    fixture.clock.advance(1);
    expect(fixture.reads[2]?.request.ifNoneMatch).toBeUndefined();
    expect(fixture.reads[2]?.request.password).toBe("pending-password");
    fixture.resolve304(2);
    await fixture.flush();
    expect(fixture.events).toContainEqual({ type: "credential-proved", password: "pending-password", at: 9_000 });
  });

  it("cancels local-dirty reads and starts a fresh cadence only when local work settles", async () => {
    const fixture = syncFixture({ loadAt: 0 });

    fixture.clock.advance(3_000);
    fixture.controller.localWorkChanged();
    expect(fixture.reads[0]?.request.signal.aborted).toBe(true);
    fixture.reject(0, new DOMException("aborted", "AbortError"));
    await fixture.flush();
    expect(fixture.lastState()).toBe("paused-local");
    expect(fixture.events.some((event) => event.type === "error")).toBe(false);

    fixture.controller.localWorkSettled(fixture.clock.now);
    fixture.clock.advance(2_999);
    expect(fixture.reads).toHaveLength(1);
    fixture.clock.advance(1);
    expect(fixture.reads).toHaveLength(2);
  });

  it("pauses offline, clears a candidate, and waits a full cadence after online", async () => {
    const fixture = syncFixture({ loadAt: 0 });

    fixture.clock.advance(3_000);
    fixture.resolve200(0, snapshot({ source: "remote" }));
    await fixture.flush();
    fixture.controller.setOnline(false, fixture.clock.now);
    expect(fixture.lastState()).toBe("paused-offline");
    fixture.controller.setOnline(true, fixture.clock.now);
    expect(fixture.lastState()).toBe("waiting");
    fixture.clock.advance(2_999);
    expect(fixture.reads).toHaveLength(1);
    fixture.clock.advance(1);
    expect(fixture.reads).toHaveLength(2);
  });

  it("handles HTTP outcomes and online network failures without an immediate retry", async () => {
    const cases: Array<{
      status: 403 | 404 | 409 | 503;
      event: PasteSyncEvent["type"];
      state: string;
      followup: boolean;
      keepsTimer: boolean;
    }> = [
      { status: 403, event: "forbidden", state: "forbidden", followup: false, keepsTimer: false },
      { status: 404, event: "not-found", state: "not-found", followup: false, keepsTimer: false },
      { status: 409, event: "conflict", state: "conflict", followup: false, keepsTimer: true },
      { status: 503, event: "error", state: "error", followup: true, keepsTimer: true },
    ];

    for (const expected of cases) {
      const fixture = syncFixture({ loadAt: 0 });
      fixture.clock.advance(3_000);
      fixture.resolveStatus(0, expected.status);
      await fixture.flush();
      expect(fixture.events.some((event) => event.type === expected.event)).toBe(true);
      expect(fixture.lastState()).toBe(expected.state);
      expect(fixture.activeTimerCount() > 0).toBe(expected.keepsTimer);
      fixture.clock.advance(3_000);
      expect(fixture.reads).toHaveLength(expected.followup ? 2 : 1);
    }

    const networkFixture = syncFixture({ loadAt: 0 });
    networkFixture.clock.advance(3_000);
    networkFixture.reject(0, new Error("network unavailable"));
    await networkFixture.flush();
    expect(networkFixture.lastState()).toBe("error");
    networkFixture.clock.advance(3_000);
    expect(networkFixture.reads).toHaveLength(2);
  });

  it("does not let Retry or settle reopen an expired window", () => {
    const fixture = syncFixture({ loadAt: 0 });

    fixture.clock.advance(300_000);
    expect(fixture.lastState()).toBe("inactive");
    expect(fixture.controller.retrySync(fixture.clock.now, null)).toBe(false);
    fixture.controller.localWorkSettled(fixture.clock.now);
    fixture.clock.advance(3_000);
    expect(fixture.reads).toHaveLength(1);

    fixture.controller.recordUserActivity(fixture.clock.now);
    fixture.clock.advance(3_000);
    expect(fixture.reads).toHaveLength(1);
    fixture.controller.localWorkChanged();
    fixture.controller.localWorkSettled(fixture.clock.now);
    fixture.clock.advance(3_000);
    expect(fixture.reads).toHaveLength(2);
  });
});

describe("PasteSync terminal view-once precedence", () => {
  it.each([
    ["local edit", (fixture: ReturnType<typeof syncFixture>) => fixture.controller.localWorkChanged()],
    ["offline", (fixture: ReturnType<typeof syncFixture>) => fixture.controller.setOnline(false, fixture.clock.now)],
    ["the exact active deadline", (fixture: ReturnType<typeof syncFixture>) => fixture.clock.advance(297_000)],
  ])("handles a complete view-once response after %s retires its ordinary token", async (_name, retire) => {
    const fixture = syncFixture({ loadAt: 0 });
    fixture.clock.advance(3_000);
    retire(fixture);

    fixture.resolve200(0, snapshot({ summary: summary({ viewOnce: true }) }));
    await fixture.flush();

    expect(fixture.events.filter((event) => event.type === "terminal-view-once")).toEqual([
      expect.objectContaining({ ordinaryTokenCurrent: false }),
    ]);
    expect(fixture.events.some((event) => event.type === "candidate" || event.type === "proven-newer")).toBe(false);
    expect(fixture.activeTimerCount()).toBe(0);
    expect(fixture.clock.maxActiveTimers).toBe(1);
  });

  it("stops ordinary scheduling after a current complete view-once response", async () => {
    const fixture = syncFixture({ loadAt: 0 });
    fixture.clock.advance(3_000);
    fixture.resolve200(0, snapshot({ summary: summary({ viewOnce: true }) }));
    await fixture.flush();

    expect(fixture.events.filter((event) => event.type === "terminal-view-once")).toEqual([
      expect.objectContaining({ ordinaryTokenCurrent: true, receivedAt: 3_000 }),
    ]);
    fixture.clock.advance(300_000);
    expect(fixture.reads).toHaveLength(1);
  });

  it("does not synthesize terminal state from an adapter validation failure", async () => {
    const fixture = syncFixture({ loadAt: 0 });
    fixture.clock.advance(3_000);
    fixture.reject(0, new Error("response digest mismatch"));
    await fixture.flush();

    expect(fixture.events.some((event) => event.type === "terminal-view-once")).toBe(false);
    expect(fixture.lastState()).toBe("error");
  });
});
