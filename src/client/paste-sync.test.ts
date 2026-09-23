import { describe, expect, it } from "vitest";
import { PasteSync, classifyRemote } from "./paste-sync";
import type { PasteSyncCapture, PasteSyncEvent, PasteSyncReadRequest, PasteSyncReadResult, RemoteApplyAttempt } from "./paste-sync";
import type { PasteSummary, RemoteSnapshot } from "./contracts";

type TimerCallback = () => void;

class FakeClock {
  now = 0;
  private nextId = 1;
  private timers = new Map<number, { at: number; callback: TimerCallback }>();
  maxActiveTimers = 0;
  timerSetCount = 0;

  setTimeout = (callback: TimerCallback, delay: number): number => {
    this.timerSetCount += 1;
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
  settled: boolean;
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
    acceptedSummary: summary(),
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
  let maxActiveReads = 0;
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
      reads.push({ request, settled: false, resolve, reject });
      maxActiveReads = Math.max(maxActiveReads, reads.filter((read) => !read.settled).length);
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
      const read = reads[index];
      if (!read) return;
      read.settled = true;
      read.resolve({ status: 304, etag: responseEtag });
    },
    resolve200(index: number, remote = snapshot()) {
      const read = reads[index];
      if (!read) return;
      read.settled = true;
      read.resolve({ status: 200, snapshot: remote });
    },
    resolveStatus(index: number, status: 403 | 404 | 409 | 503) {
      const read = reads[index];
      if (!read) return;
      read.settled = true;
      read.resolve({ status });
    },
    reject(index: number, reason: unknown) {
      const read = reads[index];
      if (!read) return;
      read.settled = true;
      read.reject(reason);
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
    activeReadCount() {
      return reads.filter((read) => !read.settled).length;
    },
    maxActiveReads() {
      return maxActiveReads;
    },
  };
}

function commitPreparedRemoteApply(controller: PasteSync, attempt: RemoteApplyAttempt, committedAt: number): boolean {
  const prepared = controller.prepareRemoteApplyCommit(attempt, committedAt);
  if (prepared === null) return false;
  prepared.commit()();
  return true;
}

describe("PasteSync timing", () => {
  it("emits initial waiting without a transition timestamp", () => {
    const fixture = syncFixture({ loadAt: 0 });

    expect(fixture.events[0]).toEqual({ type: "state", state: "waiting", at: null });
  });

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

  it("does not overlap a retired physical read before its valid view-once response settles", async () => {
    const fixture = syncFixture({ loadAt: 0 });

    fixture.clock.advance(3_000);
    fixture.controller.localWorkChanged();
    fixture.controller.localWorkSettled(fixture.clock.now);
    fixture.clock.advance(3_000);

    expect(fixture.reads).toHaveLength(1);
    expect(fixture.maxActiveReads()).toBe(1);
    fixture.resolve200(0, snapshot({ summary: summary({ viewOnce: true }) }));
    await fixture.flush();

    expect(fixture.events.filter((event) => event.type === "terminal-view-once")).toHaveLength(1);
    expect(fixture.activeReadCount()).toBe(0);
    expect(fixture.activeTimerCount()).toBe(0);
  });

  it("rejects Retry while a physical check is still pending", () => {
    const fixture = syncFixture({ loadAt: 0 });

    fixture.clock.advance(3_000);

    expect(fixture.controller.retrySync(fixture.clock.now, "replacement")).toBe(false);
    fixture.clock.advance(3_000);
    expect(fixture.reads).toHaveLength(1);
    expect(fixture.clock.maxActiveTimers).toBe(1);
  });

  it("expires a non-view-once response that settles before the queued deadline callback", async () => {
    const fixture = syncFixture({ loadAt: 0 });

    fixture.clock.advance(3_000);
    fixture.clock.now = 300_000;
    fixture.resolve304(0);
    await fixture.flush();

    expect(fixture.lastState()).toBe("inactive");
    expect(fixture.activeTimerCount()).toBe(0);
    expect(fixture.reads[0]?.request.signal.aborted).toBe(true);
  });

  it("releases a response that settles at the deadline before its queued deadline callback", async () => {
    const fixture = syncFixture({ loadAt: 0 });

    fixture.clock.advance(3_000);
    fixture.clock.now = 300_000;
    fixture.resolve304(0);
    await fixture.flush();
    fixture.controller.recordUserActivity(fixture.clock.now);
    fixture.controller.localWorkChanged();
    fixture.controller.localWorkSettled(fixture.clock.now);
    fixture.clock.advance(3_000);

    expect(fixture.reads).toHaveLength(2);
  });

  it("releases a rejection that settles at the deadline before its queued deadline callback", async () => {
    const fixture = syncFixture({ loadAt: 0 });

    fixture.clock.advance(3_000);
    fixture.clock.now = 300_000;
    fixture.reject(0, new Error("network unavailable"));
    await fixture.flush();
    fixture.controller.recordUserActivity(fixture.clock.now);
    fixture.controller.localWorkChanged();
    fixture.controller.localWorkSettled(fixture.clock.now);
    fixture.clock.advance(3_000);

    expect(fixture.reads).toHaveLength(2);
  });

  it("keeps terminal view-once precedence but retires ordinary authority at the deadline", async () => {
    const fixture = syncFixture({ loadAt: 0 });

    fixture.clock.advance(3_000);
    fixture.clock.now = 300_000;
    fixture.resolve200(0, snapshot({ summary: summary({ viewOnce: true }) }));
    await fixture.flush();

    expect(fixture.events).toContainEqual(expect.objectContaining({
      type: "terminal-view-once",
      ordinaryTokenCurrent: false,
      receivedAt: 300_000,
    }));
    expect(fixture.lastState()).toBe("inactive");
    expect(fixture.activeTimerCount()).toBe(0);
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
  it.each([
    ["g.1e2", 101],
    ["g.01", 2],
    ["g.+1", 2],
    ["g.1.5", 2],
    ["g.0", 2],
    ["g.9007199254740992", 2],
  ])("fails closed for malformed baseline counter %s", (version, versionCounter) => {
    const baseline = { ...capture().baseline, generation: "g", version };
    const remote = snapshot({
      identity: { kind: "v2", generation: "g", versionCounter },
      contentRevision: 2,
      updatedAtMs: Date.parse("2026-09-14T00:00:00.000Z"),
    });

    expect(classifyRemote(remote, baseline)).toBe("incomparable");
  });

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

describe("PasteSync prepared remote apply", () => {
  it("defers remote success publication and the next cadence until release", async () => {
    const fixture = syncFixture({ loadAt: 0 });
    const remote = snapshot({
      identity: { kind: "v2", generation: "generation-a", versionCounter: 2 },
      contentRevision: 2,
      updatedAtMs: Date.parse("2026-09-14T00:00:00.000Z"),
    });

    fixture.clock.advance(3_000);
    fixture.resolve200(0, remote);
    await fixture.flush();
    const apply = fixture.events.find(
      (event): event is Extract<PasteSyncEvent, { type: "proven-newer" }> => event.type === "proven-newer",
    );
    if (!apply) throw new Error("missing remote apply");
    const eventsBeforePrepare = [...fixture.events];
    const timerSetsBeforePrepare = fixture.clock.timerSetCount;

    const prepared = fixture.controller.prepareRemoteApplyCommit(apply.attempt, fixture.clock.now);

    expect(prepared).not.toBeNull();
    expect(fixture.events).toEqual(eventsBeforePrepare);
    expect(fixture.activeTimerCount()).toBe(0);
    expect(fixture.clock.timerSetCount).toBe(timerSetsBeforePrepare);
    const release = prepared!.commit();
    expect(fixture.events).toEqual(eventsBeforePrepare);
    expect(fixture.activeTimerCount()).toBe(0);
    expect(fixture.clock.timerSetCount).toBe(timerSetsBeforePrepare);

    release();
    expect(fixture.lastState()).toBe("remote-applied");
    expect(fixture.activeTimerCount()).toBe(1);
    expect(fixture.clock.timerSetCount).toBe(timerSetsBeforePrepare + 1);
    release();
    expect(fixture.clock.timerSetCount).toBe(timerSetsBeforePrepare + 1);
    fixture.clock.advance(2_999);
    expect(fixture.reads).toHaveLength(1);
    fixture.clock.advance(1);
    expect(fixture.reads).toHaveLength(2);
  });

  it("restores a failed candidate without publishing before release", async () => {
    const fixture = syncFixture({ loadAt: 0 });

    fixture.clock.advance(3_000);
    fixture.resolve200(0, snapshot({ source: "remote" }));
    await fixture.flush();
    const candidate = fixture.events.find(
      (event): event is Extract<PasteSyncEvent, { type: "candidate" }> => event.type === "candidate",
    );
    if (!candidate) throw new Error("missing candidate");
    const attempt = fixture.controller.startCandidateApply(candidate.snapshot, candidate.capture);
    if (!attempt) throw new Error("missing candidate attempt");
    const eventsBeforePrepare = [...fixture.events];

    const prepared = fixture.controller.prepareRemoteApplyCommit(attempt, fixture.clock.now);

    expect(prepared).not.toBeNull();
    expect(fixture.events).toEqual(eventsBeforePrepare);
    expect(fixture.activeTimerCount()).toBe(0);
    const release = prepared!.fail();
    expect(fixture.events).toEqual(eventsBeforePrepare);
    expect(fixture.activeTimerCount()).toBe(0);

    release();
    expect(fixture.events.slice(eventsBeforePrepare.length)).toEqual([
      { type: "error", at: 3_000 },
      { type: "state", state: "error", at: 3_000 },
    ]);
    expect(fixture.controller.retrySync(fixture.clock.now, null)).toBe(true);
    fixture.clock.advance(2_999);
    expect(fixture.reads).toHaveLength(1);
    fixture.clock.advance(1);
    expect(fixture.reads).toHaveLength(2);
  });

  it("retires a failed autosync apply and resumes one cadence after release", async () => {
    const fixture = syncFixture({ loadAt: 0 });
    const remote = snapshot({
      identity: { kind: "v2", generation: "generation-a", versionCounter: 2 },
      contentRevision: 2,
      updatedAtMs: Date.parse("2026-09-14T00:00:00.000Z"),
    });

    fixture.clock.advance(3_000);
    fixture.resolve200(0, remote);
    await fixture.flush();
    const apply = fixture.events.find(
      (event): event is Extract<PasteSyncEvent, { type: "proven-newer" }> => event.type === "proven-newer",
    );
    if (!apply) throw new Error("missing remote apply");
    const eventsBeforePrepare = [...fixture.events];

    const prepared = fixture.controller.prepareRemoteApplyCommit(apply.attempt, fixture.clock.now);

    expect(prepared).not.toBeNull();
    const release = prepared!.fail();
    expect(fixture.events).toEqual(eventsBeforePrepare);
    expect(fixture.activeTimerCount()).toBe(0);
    release();
    expect(fixture.events.slice(eventsBeforePrepare.length)).toEqual([
      { type: "error", at: 3_000 },
      { type: "state", state: "error", at: 3_000 },
    ]);
    fixture.clock.advance(2_999);
    expect(fixture.reads).toHaveLength(1);
    fixture.clock.advance(1);
    expect(fixture.reads).toHaveLength(2);
  });

  it("leaves wrong and stale remote apply attempts untouched", async () => {
    const fixture = syncFixture({ loadAt: 0 });

    fixture.clock.advance(3_000);
    fixture.resolve200(0, snapshot({ source: "remote" }));
    await fixture.flush();
    const candidate = fixture.events.find(
      (event): event is Extract<PasteSyncEvent, { type: "candidate" }> => event.type === "candidate",
    );
    if (!candidate) throw new Error("missing candidate");
    const attempt = fixture.controller.startCandidateApply(candidate.snapshot, candidate.capture);
    if (!attempt) throw new Error("missing candidate attempt");
    const eventsBeforePrepare = [...fixture.events];
    const timerSetsBeforePrepare = fixture.clock.timerSetCount;

    expect(fixture.controller.prepareRemoteApplyCommit({} as RemoteApplyAttempt, fixture.clock.now)).toBeNull();
    fixture.setCapture(capture({ offline: true }));
    expect(fixture.controller.prepareRemoteApplyCommit(attempt, fixture.clock.now)).toBeNull();
    expect(fixture.events).toEqual(eventsBeforePrepare);
    expect(fixture.activeTimerCount()).toBe(1);
    expect(fixture.clock.timerSetCount).toBe(timerSetsBeforePrepare);
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
      { remote: snapshot({ etag: '"sha256-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"' }), event: "unchanged" },
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

  it("waits for staged remote apply acknowledgement before reporting success or resuming cadence", async () => {
    const fixture = syncFixture({ loadAt: 0 });
    const remote = snapshot({
      identity: { kind: "v2", generation: "generation-a", versionCounter: 2 },
      contentRevision: 2,
      updatedAtMs: Date.parse("2026-09-14T00:00:00.000Z"),
    });

    fixture.clock.advance(3_000);
    fixture.resolve200(0, remote);
    await fixture.flush();

    const apply = fixture.events.find(
      (event): event is Extract<PasteSyncEvent, { type: "proven-newer" }> => event.type === "proven-newer",
    );
    expect(apply).toBeDefined();
    expect(fixture.lastState()).toBe("checking");
    fixture.clock.advance(3_000);
    expect(fixture.reads).toHaveLength(1);

    expect(commitPreparedRemoteApply(fixture.controller, apply!.attempt, fixture.clock.now)).toBe(true);
    expect(fixture.lastState()).toBe("remote-applied");
    fixture.clock.advance(2_999);
    expect(fixture.reads).toHaveLength(1);
    fixture.clock.advance(1);
    expect(fixture.reads).toHaveLength(2);
  });

  it("owns a retained candidate through apply completion without restarting its cadence", async () => {
    const fixture = syncFixture({ loadAt: 0 });
    const remote = snapshot({ source: "remote" });

    fixture.clock.advance(3_000);
    fixture.resolve200(0, remote);
    await fixture.flush();
    const candidate = fixture.events.find(
      (event): event is Extract<PasteSyncEvent, { type: "candidate" }> => event.type === "candidate",
    );
    if (!candidate) throw new Error("missing candidate");

    const attempt = fixture.controller.startCandidateApply(candidate.snapshot, candidate.capture);
    expect(attempt).not.toBeNull();
    fixture.clock.advance(3_000);
    expect(fixture.reads).toHaveLength(1);

    expect(commitPreparedRemoteApply(fixture.controller, attempt!, fixture.clock.now)).toBe(true);
    expect(fixture.lastState()).toBe("remote-applied");
    fixture.clock.advance(2_999);
    expect(fixture.reads).toHaveLength(1);
    fixture.clock.advance(1);
    expect(fixture.reads).toHaveLength(2);
  });

  it("keeps exact remote apply ownership only while the captured ordinary scheduler state is current", async () => {
    const fixture = syncFixture({ loadAt: 0 });
    const remote = snapshot({ source: "remote" });

    fixture.clock.advance(3_000);
    fixture.resolve200(0, remote);
    await fixture.flush();
    const candidate = fixture.events.find(
      (event): event is Extract<PasteSyncEvent, { type: "candidate" }> => event.type === "candidate",
    );
    if (!candidate) throw new Error("missing candidate");

    const attempt = fixture.controller.startCandidateApply(candidate.snapshot, candidate.capture);
    expect(attempt).not.toBeNull();
    expect(fixture.controller.isRemoteApplyCurrent(attempt!)).toBe(true);

    fixture.setCapture(capture({ offline: true }));
    expect(fixture.controller.isRemoteApplyCurrent(attempt!)).toBe(false);
  });

  it("rejects invalidated retained candidates and restores a cancelled candidate apply", async () => {
    const fixture = syncFixture({ loadAt: 0 });
    const remote = snapshot({ source: "remote" });

    fixture.clock.advance(3_000);
    fixture.resolve200(0, remote);
    await fixture.flush();
    const candidate = fixture.events.find(
      (event): event is Extract<PasteSyncEvent, { type: "candidate" }> => event.type === "candidate",
    );
    if (!candidate) throw new Error("missing candidate");

    const first = fixture.controller.startCandidateApply(candidate.snapshot, candidate.capture);
    expect(first).not.toBeNull();
    expect(fixture.controller.cancelRemoteApply(first!, fixture.clock.now)).toBe(true);
    const second = fixture.controller.startCandidateApply(candidate.snapshot, candidate.capture);
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    fixture.controller.localWorkChanged();
    expect(fixture.controller.startCandidateApply(candidate.snapshot, candidate.capture)).toBeNull();
    expect(commitPreparedRemoteApply(fixture.controller, second!, fixture.clock.now)).toBe(false);
  });

  it("rejects a remote apply token from another controller's first attempt", async () => {
    const remote = snapshot({
      identity: { kind: "v2", generation: "generation-a", versionCounter: 2 },
      contentRevision: 2,
      updatedAtMs: Date.parse("2026-09-14T00:00:00.000Z"),
    });
    const fixtureA = syncFixture({ loadAt: 0 });
    const fixtureB = syncFixture({ loadAt: 0 });

    fixtureA.clock.advance(3_000);
    fixtureB.clock.advance(3_000);
    fixtureA.resolve200(0, remote);
    fixtureB.resolve200(0, remote);
    await fixtureA.flush();
    await fixtureB.flush();

    const applyA = fixtureA.events.find(
      (event): event is Extract<PasteSyncEvent, { type: "proven-newer" }> => event.type === "proven-newer",
    );
    const applyB = fixtureB.events.find(
      (event): event is Extract<PasteSyncEvent, { type: "proven-newer" }> => event.type === "proven-newer",
    );
    if (!applyA || !applyB) throw new Error("missing remote apply");
    expect(applyA.attempt).not.toBe(applyB.attempt);

    expect(fixtureA.controller.cancelRemoteApply(applyA.attempt, fixtureA.clock.now)).toBe(true);
    expect(commitPreparedRemoteApply(fixtureB.controller, applyA.attempt, fixtureB.clock.now)).toBe(false);
    expect(commitPreparedRemoteApply(fixtureB.controller, applyB.attempt, fixtureB.clock.now)).toBe(true);
    expect(fixtureB.lastState()).toBe("remote-applied");
  });

  it("does not let a late completion from cancelled A settle B", async () => {
    const fixture = syncFixture({ loadAt: 0 });
    const remote = snapshot({
      identity: { kind: "v2", generation: "generation-a", versionCounter: 2 },
      contentRevision: 2,
      updatedAtMs: Date.parse("2026-09-14T00:00:00.000Z"),
    });

    fixture.clock.advance(3_000);
    fixture.resolve200(0, remote);
    await fixture.flush();
    const applyA = fixture.events.find(
      (event): event is Extract<PasteSyncEvent, { type: "proven-newer" }> => event.type === "proven-newer",
    );
    if (!applyA) throw new Error("missing remote apply A");
    expect(fixture.controller.cancelRemoteApply(applyA.attempt, fixture.clock.now)).toBe(true);

    fixture.clock.advance(3_000);
    fixture.resolve200(1, remote);
    await fixture.flush();
    const applyB = fixture.events.filter(
      (event): event is Extract<PasteSyncEvent, { type: "proven-newer" }> => event.type === "proven-newer",
    ).at(-1);
    if (!applyB) throw new Error("missing remote apply B");
    expect(applyB.attempt).not.toBe(applyA.attempt);

    expect(commitPreparedRemoteApply(fixture.controller, applyA.attempt, fixture.clock.now)).toBe(false);
    expect(fixture.controller.cancelRemoteApply(applyB.attempt, fixture.clock.now)).toBe(true);
    expect(fixture.lastState()).toBe("error");
  });

  it("does not let a late cancellation from cancelled A settle B", async () => {
    const fixture = syncFixture({ loadAt: 0 });
    const remote = snapshot({
      identity: { kind: "v2", generation: "generation-a", versionCounter: 2 },
      contentRevision: 2,
      updatedAtMs: Date.parse("2026-09-14T00:00:00.000Z"),
    });

    fixture.clock.advance(3_000);
    fixture.resolve200(0, remote);
    await fixture.flush();
    const applyA = fixture.events.find(
      (event): event is Extract<PasteSyncEvent, { type: "proven-newer" }> => event.type === "proven-newer",
    );
    if (!applyA) throw new Error("missing remote apply A");
    expect(fixture.controller.cancelRemoteApply(applyA.attempt, fixture.clock.now)).toBe(true);

    fixture.clock.advance(3_000);
    fixture.resolve200(1, remote);
    await fixture.flush();
    const applyB = fixture.events.filter(
      (event): event is Extract<PasteSyncEvent, { type: "proven-newer" }> => event.type === "proven-newer",
    ).at(-1);
    if (!applyB) throw new Error("missing remote apply B");
    expect(applyB.attempt).not.toBe(applyA.attempt);

    expect(fixture.controller.cancelRemoteApply(applyA.attempt, fixture.clock.now)).toBe(false);
    expect(commitPreparedRemoteApply(fixture.controller, applyB.attempt, fixture.clock.now)).toBe(true);
    expect(fixture.lastState()).toBe("remote-applied");
  });

  it("accepts an unconditional marker-equal 200 after mutation when its complete public summary matches", async () => {
    const fixture = syncFixture({ loadAt: 0 });
    fixture.setCapture(capture({ responseEtag: null }));

    fixture.clock.advance(3_000);
    fixture.resolve200(0, snapshot());
    await fixture.flush();

    expect(fixture.events).toContainEqual({ type: "unchanged", etag, checkedAt: 3_000 });
    expect(fixture.lastState()).toBe("unchanged");
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
    fixture.resolve200(2);
    await fixture.flush();
    expect(fixture.events).toContainEqual({ type: "credential-proved", password: "pending-password", at: 9_000 });
  });

  it.each([
    ["Keep current", (fixture: ReturnType<typeof syncFixture>) => fixture.controller.keepCurrent(fixture.clock.now)],
    ["Retry sync", (fixture: ReturnType<typeof syncFixture>) => expect(fixture.controller.retrySync(fixture.clock.now, null)).toBe(true)],
  ])("dismisses a scheduler-owned candidate through %s when aggregate locallyClean is false", async (_action, dismiss) => {
    const fixture = syncFixture({ loadAt: 0 });

    fixture.clock.advance(3_000);
    fixture.resolve200(0, snapshot({ source: "remote" }));
    await fixture.flush();
    fixture.setCapture(capture({ locallyClean: false }));
    dismiss(fixture);

    expect(fixture.lastState()).toBe("waiting");
    fixture.clock.advance(2_999);
    expect(fixture.reads).toHaveLength(1);
    fixture.clock.advance(1);
    expect(fixture.reads).toHaveLength(2);
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

  it("does not publish a retired ordinary 200 after local work takes authority", async () => {
    const fixture = syncFixture({ loadAt: 0 });
    const remote = snapshot({
      source: "remote-authority",
      identity: { kind: "v2", generation: "generation-a", versionCounter: 2 },
      contentRevision: 2,
      updatedAtMs: Date.parse("2026-09-14T00:00:00.000Z"),
      summary: summary({
        version: "generation-a.2",
        contentRevision: 2,
        updatedAt: "2026-09-14T00:00:00.000Z",
        contentBytes: 16,
      }),
    });

    fixture.clock.advance(3_000);
    fixture.controller.localWorkChanged();
    const eventsAfterRetirement = [...fixture.events];
    fixture.resolve200(0, remote);
    await fixture.flush();

    expect(fixture.events).toEqual(eventsAfterRetirement);
    expect(fixture.lastState()).toBe("paused-local");
    expect(fixture.activeReadCount()).toBe(0);
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

  it("latches forbidden across offline recovery and keeps Retry conditional until an authorized 304 proves its credential", async () => {
    const fixture = syncFixture({ loadAt: 0 });

    fixture.clock.advance(3_000);
    fixture.resolveStatus(0, 403);
    await fixture.flush();
    fixture.controller.setOnline(false, fixture.clock.now);
    fixture.controller.setOnline(true, fixture.clock.now);
    fixture.clock.advance(3_000);

    expect(fixture.reads).toHaveLength(1);
    expect(fixture.lastState()).toBe("forbidden");
    expect(fixture.controller.retrySync(fixture.clock.now, "replacement")).toBe(true);
    fixture.clock.advance(3_000);
    expect(fixture.reads[1]?.request.ifNoneMatch).toBe(etag);
    expect(fixture.reads[1]?.request.password).toBe("replacement");
    fixture.resolve304(1);
    await fixture.flush();
    expect(fixture.events).toContainEqual({ type: "credential-proved", password: "replacement", at: 9_000 });
  });

  it("releases a failed Delete pause only after confirmed access and local work settles", () => {
    const fixture = syncFixture({ loadAt: 0 });
    fixture.controller.localWorkChanged();
    fixture.controller.rejectDelete(403, 0);
    expect(fixture.lastState()).toBe("forbidden");
    fixture.clock.advance(1);
    fixture.controller.confirmedAccess(fixture.clock.now);
    expect(fixture.lastState()).toBe("paused-local");
    fixture.clock.advance(3_000);
    expect(fixture.reads).toHaveLength(0);
    fixture.controller.localWorkSettled(fixture.clock.now);
    expect(fixture.lastState()).toBe("waiting");
    fixture.clock.advance(3_000);
    expect(fixture.reads).toHaveLength(1);
  });

  it("does not let queued callbacks change permanent not-found state", async () => {
    const fixture = syncFixture({ loadAt: 0 });

    fixture.clock.advance(3_000);
    fixture.resolveStatus(0, 404);
    await fixture.flush();
    fixture.controller.localWorkChanged();
    fixture.controller.localWorkSettled(fixture.clock.now);
    fixture.controller.setOnline(false, fixture.clock.now);
    fixture.controller.setOnline(true, fixture.clock.now);
    fixture.controller.recordUserActivity(fixture.clock.now);
    fixture.clock.advance(3_000);

    expect(fixture.lastState()).toBe("not-found");
    expect(fixture.reads).toHaveLength(1);
    expect(fixture.activeTimerCount()).toBe(0);
  });

  it("clears an expired Retry intent before a later activity window starts", async () => {
    const fixture = syncFixture({ loadAt: 0 });

    fixture.clock.advance(3_000);
    fixture.resolve200(0, snapshot({ source: "remote" }));
    await fixture.flush();
    fixture.clock.advance(296_000);
    expect(fixture.controller.retrySync(fixture.clock.now, "old-pending")).toBe(true);
    fixture.clock.advance(1_000);
    expect(fixture.lastState()).toBe("inactive");
    fixture.controller.recordUserActivity(fixture.clock.now);
    fixture.controller.localWorkChanged();
    fixture.controller.localWorkSettled(fixture.clock.now);
    fixture.clock.advance(3_000);

    expect(fixture.reads[1]?.request.password).toBeNull();
    expect(fixture.reads[1]?.request.ifNoneMatch).toBe(etag);
  });

  it("handles HTTP outcomes and online network failures without an immediate retry", async () => {
    const cases: Array<{
      status: 403 | 404 | 409 | 503;
      event: PasteSyncEvent["type"];
      state: string;
      followup: boolean;
      keepsTimer: boolean;
    }> = [
      { status: 403, event: "forbidden", state: "forbidden", followup: false, keepsTimer: true },
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

  it("marks an online transport result for degraded network presentation", async () => {
    const fixture = syncFixture({ loadAt: 0 });
    fixture.clock.advance(3_000);
    const read = fixture.reads[0]!;
    read.settled = true;
    read.resolve({ status: 0, transport: "network" } as unknown as PasteSyncReadResult);
    await fixture.flush();

    expect(fixture.events).toContainEqual({ type: "error", at: 3_000, transport: "network" });
  });

  it("does not let Retry or settle reopen an expired window", async () => {
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
    expect(fixture.reads).toHaveLength(1);
    fixture.reject(0, new DOMException("aborted", "AbortError"));
    await fixture.flush();
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
