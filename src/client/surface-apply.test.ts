import { describe, expect, it, vi } from "vitest";
import {
  autosyncApplyEntryAllowed,
  createStagedSurfaceApply,
  reloadApplyEntryAllowed,
  terminalLocalApplyEntryAllowed,
  useRemoteApplyEntryAllowed,
  type DerivedSurfaceCapture,
  type StagedSurfacePorts,
} from "./surface-apply";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

function capture(overrides: Partial<DerivedSurfaceCapture> = {}): DerivedSurfaceCapture {
  return {
    localGeneration: 1,
    currentExactSource: "one",
    currentDisplayGeneration: 1,
    hostGeneration: 1,
    parentApplyGeneration: 1,
    parentApplyToken: 1,
    derivedRetryToken: 1,
    ...overrides,
  };
}

function surfaceFixture(initial = capture(), now = () => Date.now()) {
  const previews: Deferred<unknown>[] = [];
  const visuals: Deferred<unknown>[] = [];
  const diffs: Deferred<unknown>[] = [];
  const ports: StagedSurfacePorts = {
    stagePreview: vi.fn(() => {
      const next = deferred<unknown>();
      previews.push(next);
      return next.promise;
    }),
    stageVisual: vi.fn(() => {
      const next = deferred<unknown>();
      visuals.push(next);
      return next.promise;
    }),
    stageDiff: vi.fn(() => {
      const next = deferred<unknown>();
      diffs.push(next);
      return next.promise;
    }),
    mounted: () => ["preview", "visual", "diff"],
    commit: vi.fn(),
    restoreOld: vi.fn(async () => true),
    showOldGenerationFailure: vi.fn(),
    disposeAttemptResources: vi.fn(),
  };
  return {
    previews,
    visuals,
    diffs,
    ports,
    apply: createStagedSurfaceApply({ ports, capture: initial, now }),
  };
}

async function resolveStages(fixture: ReturnType<typeof surfaceFixture>, index = 0): Promise<void> {
  fixture.previews[index]!.resolve(`preview-${index}`);
  fixture.visuals[index]!.resolve(`visual-${index}`);
  fixture.diffs[index]!.resolve(`diff-${index}`);
  await settle();
}

describe("staged surface application", () => {
  it("stages surfaces and publishes only after every stage and capture guard succeeds", async () => {
    const fixture = surfaceFixture();
    const attempt = fixture.apply.apply("two");
    await resolveStages(fixture);

    await expect(attempt).resolves.toBe(true);
    expect(fixture.ports.commit).toHaveBeenCalledWith({ preview: "preview-0", visual: "visual-0", diff: "diff-0" }, 2);
  });

  it("stages only the derived surfaces that have a mounted host", async () => {
    const fixture = surfaceFixture();
    fixture.ports.mounted = () => ["visual"];
    const attempt = fixture.apply.apply("two");

    expect(fixture.ports.stagePreview).not.toHaveBeenCalled();
    expect(fixture.ports.stageVisual).toHaveBeenCalledOnce();
    expect(fixture.ports.stageDiff).not.toHaveBeenCalled();
    fixture.visuals[0]!.resolve("visual");
    await settle();

    await expect(attempt).resolves.toBe(true);
    expect(fixture.ports.commit).toHaveBeenCalledWith(expect.objectContaining({ visual: "visual" }), 2);
  });

  it("rechecks the confirmed Reload guard before committing a staged target", async () => {
    const fixture = surfaceFixture();
    let current = true;
    const attempt = fixture.apply.applyReload("two", {
      requestCurrent: true,
      acceptedBaselineCurrent: true,
      draftCurrent: true,
      localGenerationCurrent: true,
      mutationOccupied: false,
      terminal: false,
      commitCurrent: () => current,
    });
    current = false;
    await resolveStages(fixture);

    await expect(attempt).resolves.toBe(false);
    expect(fixture.ports.commit).not.toHaveBeenCalled();
  });

  it("runs the remote finalizer once after surface publication and before resolution", async () => {
    const fixture = surfaceFixture();
    const order: string[] = [];
    vi.mocked(fixture.ports.commit).mockImplementation(() => { order.push("surface"); });
    const attempt = fixture.apply.applyUseRemote("two", {
      candidateCurrent: true,
      acceptedBaselineCurrent: true,
      localGenerationCurrent: true,
      ordinary: true,
      active: true,
      activeDeadlineCurrent: true,
      activeUntil: Number.MAX_SAFE_INTEGER,
      draftMatchesAccepted: true,
      composing: false,
      autosaveTimer: false,
      autosaveInFlight: false,
      coalescedIntent: false,
      mutationOccupied: false,
      unresolvedMutation: false,
      conflictCausedByCandidate: true,
      finalizeCurrent: () => {
        order.push("finalize");
        fixture.apply.replaceCapture(capture({
          currentExactSource: "two",
          currentDisplayGeneration: 2,
          parentApplyGeneration: 2,
          parentApplyToken: 2,
        }));
      },
    }).then((applied) => {
      order.push("resolved");
      return applied;
    });
    await resolveStages(fixture);

    await expect(attempt).resolves.toBe(true);
    expect(order).toEqual(["surface", "finalize", "resolved"]);
    expect(fixture.ports.disposeAttemptResources).not.toHaveBeenCalled();
  });

  it("does not run a remote finalizer when surface publication throws", async () => {
    const fixture = surfaceFixture();
    fixture.ports.mounted = () => [];
    const finalizeCurrent = vi.fn();
    vi.mocked(fixture.ports.commit).mockImplementation(() => { throw new Error("commit failed"); });

    await expect(fixture.apply.applyUseRemote("two", {
      candidateCurrent: true,
      acceptedBaselineCurrent: true,
      localGenerationCurrent: true,
      ordinary: true,
      active: true,
      activeDeadlineCurrent: true,
      activeUntil: Number.MAX_SAFE_INTEGER,
      draftMatchesAccepted: true,
      composing: false,
      autosaveTimer: false,
      autosaveInFlight: false,
      coalescedIntent: false,
      mutationOccupied: false,
      unresolvedMutation: false,
      conflictCausedByCandidate: true,
      finalizeCurrent,
    })).resolves.toBe(false);

    expect(finalizeCurrent).not.toHaveBeenCalled();
  });

  it("keeps current presentation when an edit invalidates a detached stage", async () => {
    const fixture = surfaceFixture();
    const attempt = fixture.apply.apply("two");
    fixture.apply.replaceCapture(capture({ localGeneration: 2, currentExactSource: "local" }));
    await resolveStages(fixture);

    await expect(attempt).resolves.toBe(false);
    expect(fixture.ports.commit).not.toHaveBeenCalled();
    expect(fixture.ports.disposeAttemptResources).toHaveBeenCalled();
    expect(fixture.apply.snapshot()).toMatchObject({ source: "local", status: "idle" });
  });

  it.each([
    ["localGeneration", capture({ localGeneration: 2 })],
    ["currentExactSource", capture({ currentExactSource: "two" })],
    ["currentDisplayGeneration", capture({ currentDisplayGeneration: 2 })],
    ["hostGeneration", capture({ hostGeneration: 2 })],
    ["parentApplyGeneration", capture({ parentApplyGeneration: 2 })],
    ["parentApplyToken", capture({ parentApplyToken: 2 })],
    ["derivedRetryToken", capture({ derivedRetryToken: 2 })],
  ] as const)("uses a seven-field guard when %s changes", async (_field, replacement) => {
    const fixture = surfaceFixture();
    const attempt = fixture.apply.apply("two");
    fixture.apply.replaceCapture(replacement);
    await resolveStages(fixture);

    await expect(attempt).resolves.toBe(false);
    expect(fixture.ports.commit).not.toHaveBeenCalled();
    expect(fixture.ports.disposeAttemptResources).toHaveBeenCalled();
  });

  it("drops a reverse retry without clearing the current fallback or draft source", async () => {
    const fixture = surfaceFixture();
    const initial = fixture.apply.apply("two");
    await resolveStages(fixture, 0);
    await initial;
    const first = fixture.apply.retryPreview("two");
    const firstPreview = fixture.previews[1]!.promise;
    const second = fixture.apply.retryPreview("two");
    const secondPreview = fixture.previews[2]!.promise;

    expect(firstPreview).not.toBe(secondPreview);
    fixture.previews[2]!.resolve("preview-2");
    await settle();
    await expect(second).resolves.toBe(true);
    fixture.previews[1]!.resolve("preview-1");
    await settle();
    await expect(first).resolves.toBe(false);
    expect(fixture.ports.commit).toHaveBeenCalledTimes(2);
    expect(fixture.apply.snapshot()).toMatchObject({ source: "two" });
  });

  it("publishes a target-bound preview fallback while retaining the other staged surfaces", async () => {
    const fixture = surfaceFixture();
    const attempt = fixture.apply.apply("two");
    fixture.previews[0]!.reject(new Error("preview failed"));
    fixture.visuals[0]!.resolve("visual");
    fixture.diffs[0]!.resolve("diff");
    await settle();

    await expect(attempt).resolves.toBe(true);
    expect(fixture.ports.commit).toHaveBeenCalledWith(expect.objectContaining({ preview: expect.objectContaining({ surface: "preview", source: "two", generation: 2 }), visual: "visual", diff: "diff" }), 2);
    expect(fixture.apply.snapshot()).toMatchObject({ status: "fallback", source: "two", fallback: "preview" });
  });
});

describe("terminal settlement", () => {
  it("settles a terminal origin exactly once with the required outcome key", () => {
    const fixture = surfaceFixture();
    expect(fixture.apply.settleTerminal({ actionKey: "content-reconcile", actionAttempt: 3, startedAt: "2026-09-15T00:00:00.000Z" }, "displayed")).toBe("content-reconcile-terminal-current-kept");
    expect(fixture.apply.settleTerminal({ actionKey: "content-reconcile", actionAttempt: 3, startedAt: "2026-09-15T00:00:00.000Z" }, "displayed")).toBeNull();
  });

  it.each([
    ["displayed", "reload-terminal-response-displayed"],
    ["display-failed", "reload-terminal-response-display-failed"],
    ["current-unchanged", "reload-terminal-current-unchanged"],
    ["current-kept-choice", "reload-terminal-current-kept-choice"],
  ] as const)("uses %s for a reload terminal origin", (result, expected) => {
    const fixture = surfaceFixture();
    expect(fixture.apply.settleTerminal({ actionKey: "reload-server", actionAttempt: 3, startedAt: "2026-09-15T00:00:00.000Z" }, result)).toBe(expected);
  });
});

describe("source-specific entry guards", () => {
  it("requires ordinary autosync to be active, clean, and free of all local work", () => {
    expect(autosyncApplyEntryAllowed({
      requestCurrent: true,
      acceptedBaselineCurrent: true,
      localGenerationCurrent: true,
      active: true,
      activeUntil: Number.MAX_SAFE_INTEGER,
      composing: false,
      autosaveTimer: false,
      autosaveInFlight: false,
      coalescedIntent: false,
      mutationOccupied: false,
      unresolvedMutation: false,
      localSourceWork: false,
    })).toBe(true);
    expect(autosyncApplyEntryAllowed({
      requestCurrent: true,
      acceptedBaselineCurrent: true,
      localGenerationCurrent: true,
      active: true,
      activeUntil: Number.MAX_SAFE_INTEGER,
      composing: false,
      autosaveTimer: false,
      autosaveInFlight: false,
      coalescedIntent: false,
      mutationOccupied: false,
      unresolvedMutation: false,
      localSourceWork: true,
    })).toBe(false);
  });

  it("allows Use remote without treating its own conflict status as local dirt", () => {
    expect(useRemoteApplyEntryAllowed({
      candidateCurrent: true,
      acceptedBaselineCurrent: true,
      localGenerationCurrent: true,
      ordinary: true,
      active: true,
      activeDeadlineCurrent: true,
      activeUntil: Number.MAX_SAFE_INTEGER,
      draftMatchesAccepted: true,
      composing: false,
      autosaveTimer: false,
      autosaveInFlight: false,
      coalescedIntent: false,
      mutationOccupied: false,
      unresolvedMutation: false,
      conflictCausedByCandidate: true,
    })).toBe(true);
  });

  it("permits confirmed Reload with a dirty inactive draft but rejects an occupied slot or terminal state", () => {
    expect(reloadApplyEntryAllowed({ requestCurrent: true, acceptedBaselineCurrent: true, draftCurrent: true, localGenerationCurrent: true, mutationOccupied: false, terminal: false })).toBe(true);
    expect(reloadApplyEntryAllowed({ requestCurrent: true, acceptedBaselineCurrent: true, draftCurrent: true, localGenerationCurrent: true, mutationOccupied: true, terminal: false })).toBe(false);
  });

  it("keeps terminal local source choice independent from ordinary controller guards", () => {
    expect(terminalLocalApplyEntryAllowed({ terminalEpochCurrent: true, displayGenerationCurrent: true, selectedSourceCurrent: true })).toBe(true);
    expect(terminalLocalApplyEntryAllowed({ terminalEpochCurrent: true, displayGenerationCurrent: false, selectedSourceCurrent: true })).toBe(false);
  });
});

describe("StagedSurfaceApply round-one regressions", () => {
  it("retires the first source-owned transaction when a newer entry starts and uses one target generation", async () => {
    const fixture = surfaceFixture();
    const first = fixture.apply.apply("first");
    const second = fixture.apply.apply("second");

    expect(fixture.ports.stagePreview).toHaveBeenNthCalledWith(1, "first", 2);
    expect(fixture.ports.stagePreview).toHaveBeenNthCalledWith(2, "second", 3);
    await resolveStages(fixture, 0);
    await expect(first).resolves.toBe(false);
    expect(fixture.ports.commit).not.toHaveBeenCalled();
    await resolveStages(fixture, 1);
    await expect(second).resolves.toBe(true);
    expect(fixture.ports.commit).toHaveBeenCalledWith(expect.any(Object), 3);
    expect(fixture.apply.snapshot().capture.currentDisplayGeneration).toBe(3);
  });

  it("publishes a target-bound fallback without leaking late detached stage resources", async () => {
    const fixture = surfaceFixture();
    const attempt = fixture.apply.apply("two");
    fixture.previews[0]!.reject(new Error("preview failed"));
    fixture.visuals[0]!.resolve("visual");
    fixture.diffs[0]!.resolve("diff");
    await settle();

    await expect(attempt).resolves.toBe(true);
    expect(fixture.ports.commit).toHaveBeenCalledWith(expect.objectContaining({ preview: expect.objectContaining({ surface: "preview", source: "two", generation: 2 }), visual: "visual", diff: "diff" }), 2);
    expect(fixture.apply.snapshot()).toMatchObject({ status: "fallback", fallback: "preview" });
  });

  it("restores the old generation and contains disposer failures after a touched-host commit failure", async () => {
    const fixture = surfaceFixture();
    vi.mocked(fixture.ports.commit).mockImplementation(() => {
      throw new Error("commit failed");
    });
    vi.mocked(fixture.ports.disposeAttemptResources).mockImplementation(() => {
      throw new Error("dispose failed");
    });
    vi.mocked(fixture.ports.restoreOld).mockResolvedValue(false);
    const attempt = fixture.apply.apply("two");
    await resolveStages(fixture);

    await expect(attempt).resolves.toBe(false);
    expect(fixture.ports.restoreOld).toHaveBeenCalledWith(1, "one", 2);
    expect(fixture.ports.showOldGenerationFailure).toHaveBeenCalledWith(1, "one", 2);
  });

  it("keeps a mounted fallback visible until a guarded retry publishes", async () => {
    const fixture = surfaceFixture();
    const failed = fixture.apply.apply("two");
    fixture.previews[0]!.reject(new Error("preview failed"));
    fixture.visuals[0]!.resolve("visual");
    fixture.diffs[0]!.resolve("diff");
    await settle();
    await failed;

    const retry = fixture.apply.retry("two");
    expect(fixture.apply.snapshot()).toMatchObject({ status: "fallback", fallback: "preview" });
    fixture.previews[1]!.resolve("preview-retry");
    await settle();
    await retry;
  });

  it("rejects a source-specific retry whose source is no longer exact", async () => {
    const fixture = surfaceFixture();
    expect(typeof (fixture.apply as unknown as { retryPreview?: unknown }).retryPreview).toBe("function");
    await expect(fixture.apply.retryPreview("other")).resolves.toBe(false);
    expect(fixture.ports.stagePreview).not.toHaveBeenCalled();
  });

  it("requires the Use remote active window in addition to ordinary-page guards", () => {
    expect(useRemoteApplyEntryAllowed({
      candidateCurrent: true,
      acceptedBaselineCurrent: true,
      localGenerationCurrent: true,
      ordinary: true,
      draftMatchesAccepted: true,
      composing: false,
      autosaveTimer: false,
      autosaveInFlight: false,
      coalescedIntent: false,
      mutationOccupied: false,
      unresolvedMutation: false,
      conflictCausedByCandidate: true,
      ...{ active: false, activeDeadlineCurrent: true, activeUntil: 0 },
    })).toBe(false);
  });

  it("retires a Use remote attempt before staging when its active deadline has elapsed", () => {
    const fixture = surfaceFixture();
    fixture.apply.applyUseRemote("two", {
      candidateCurrent: true,
      acceptedBaselineCurrent: true,
      localGenerationCurrent: true,
      ordinary: true,
      active: true,
      activeDeadlineCurrent: true,
      activeUntil: 0,
      draftMatchesAccepted: true,
      composing: false,
      autosaveTimer: false,
      autosaveInFlight: false,
      coalescedIntent: false,
      mutationOccupied: false,
      unresolvedMutation: false,
      conflictCausedByCandidate: true,
    });

    expect(fixture.ports.stagePreview).not.toHaveBeenCalled();
  });

  it("uses closed terminal outcomes and models a later consumed-response choice separately", () => {
    const fixture = surfaceFixture();
    expect(fixture.apply.settleTerminal({ actionKey: "reload-server", actionAttempt: 1, startedAt: "2026-09-15T00:00:00.000Z" }, "displayed")).toBe("reload-terminal-response-displayed");
    expect(fixture.apply.settleTerminal({ actionKey: "reload-server", actionAttempt: 1, startedAt: "2026-09-15T00:00:00.000Z" }, "displayed")).toBeNull();
    expect(typeof (fixture.apply as unknown as { settleUseConsumedResponse?: unknown }).settleUseConsumedResponse).toBe("function");
  });
});

describe("StagedSurfaceApply round-two coordination regressions", () => {
  it("cancels an autosync apply that reaches its exclusive deadline while staging", async () => {
    let time = 99;
    const fixture = surfaceFixture(capture(), () => time);
    const attempt = fixture.apply.applyAutosync("two", {
      requestCurrent: true,
      acceptedBaselineCurrent: true,
      localGenerationCurrent: true,
      active: true,
      activeUntil: 100,
      composing: false,
      autosaveTimer: false,
      autosaveInFlight: false,
      coalescedIntent: false,
      mutationOccupied: false,
      unresolvedMutation: false,
      localSourceWork: false,
    });
    time = 100;
    await resolveStages(fixture);

    await expect(attempt).resolves.toBe(false);
    expect(fixture.ports.commit).not.toHaveBeenCalled();
    expect(fixture.apply.snapshot()).toMatchObject({ capture: capture(), source: "one", status: "idle", fallback: null });
  });

  it("retains the committed capture and presentation after a restored commit failure", async () => {
    const fixture = surfaceFixture();
    vi.mocked(fixture.ports.commit).mockImplementation(() => {
      throw new Error("commit failed");
    });
    const attempt = fixture.apply.apply("two");
    await resolveStages(fixture);

    await expect(attempt).resolves.toBe(false);
    expect(fixture.ports.restoreOld).toHaveBeenCalledWith(1, "one", 2);
    expect(fixture.apply.snapshot()).toMatchObject({ capture: capture(), source: "one", status: "idle", fallback: null });
  });

  it("does not publish an older restoration failure after a newer parent commit", async () => {
    const fixture = surfaceFixture();
    const restoration = deferred<boolean>();
    let commits = 0;
    vi.mocked(fixture.ports.commit).mockImplementation(() => {
      commits += 1;
      if (commits === 1) throw new Error("first commit failed");
    });
    vi.mocked(fixture.ports.restoreOld).mockReturnValue(restoration.promise);
    const first = fixture.apply.apply("two");
    await resolveStages(fixture, 0);
    expect(fixture.ports.restoreOld).toHaveBeenCalledWith(1, "one", 2);

    const second = fixture.apply.apply("three");
    await resolveStages(fixture, 1);
    await expect(second).resolves.toBe(true);
    expect(fixture.ports.commit).toHaveBeenLastCalledWith(expect.any(Object), 3);

    restoration.resolve(false);
    await expect(first).resolves.toBe(false);
    expect(fixture.ports.showOldGenerationFailure).not.toHaveBeenCalled();
  });

  it("disposes every staged surface after a commit failure when one disposal throws", async () => {
    const fixture = surfaceFixture();
    vi.mocked(fixture.ports.commit).mockImplementation(() => {
      throw new Error("commit failed");
    });
    vi.mocked(fixture.ports.disposeAttemptResources).mockImplementation((attempt) => {
      const staged = (attempt as { staged: Record<string, unknown> }).staged;
      if ("preview" in staged) throw new Error("preview dispose failed");
    });
    const attempt = fixture.apply.apply("two");
    await resolveStages(fixture);

    await expect(attempt).resolves.toBe(false);
    expect(fixture.ports.disposeAttemptResources).toHaveBeenCalledTimes(3);
    expect(vi.mocked(fixture.ports.disposeAttemptResources).mock.calls.map(([value]) => Object.keys((value as { staged: Record<string, unknown> }).staged))).toEqual([["preview"], ["visual"], ["diff"]]);
  });

  it("keeps fallback identity during a rejected retry and advances only that retry token", async () => {
    const fixture = surfaceFixture();
    const initial = fixture.apply.apply("two");
    fixture.previews[0]!.reject(new Error("preview failed"));
    fixture.visuals[0]!.resolve("visual");
    fixture.diffs[0]!.resolve("diff");
    await settle();
    await expect(initial).resolves.toBe(true);
    const committedFallback = fixture.apply.snapshot();

    const rejected = fixture.apply.retryPreview("two");
    expect(fixture.apply.snapshot()).toEqual(committedFallback);
    fixture.previews[1]!.reject(new Error("preview retry failed"));
    await settle();
    await expect(rejected).resolves.toBe(false);
    expect(fixture.apply.snapshot()).toEqual(committedFallback);
    expect(fixture.ports.commit).toHaveBeenCalledTimes(1);

    fixture.apply.invalidate();
    fixture.apply.remount();
    const accepted = fixture.apply.retryPreview("two");
    fixture.previews[2]!.resolve("preview retry");
    await settle();
    await expect(accepted).resolves.toBe(true);
    expect(fixture.apply.snapshot()).toMatchObject({
      source: "two",
      capture: {
        currentDisplayGeneration: 2,
        hostGeneration: 2,
        parentApplyGeneration: 3,
        parentApplyToken: 4,
        derivedRetryToken: 4,
      },
    });
  });

  it("allocates retry tokens above every surface counter across preview and visual retries", async () => {
    const fixture = surfaceFixture();
    const initial = fixture.apply.apply("two");
    fixture.previews[0]!.reject(new Error("preview failed"));
    fixture.visuals[0]!.resolve("visual");
    fixture.diffs[0]!.resolve("diff");
    await settle();
    await expect(initial).resolves.toBe(true);

    const committed = fixture.apply.snapshot().capture;
    const tokens = [committed.derivedRetryToken];
    const firstPreview = fixture.apply.retryPreview("two");
    fixture.previews[1]!.resolve("preview retry one");
    await settle();
    await expect(firstPreview).resolves.toBe(true);
    tokens.push(fixture.apply.snapshot().capture.derivedRetryToken);

    const secondPreview = fixture.apply.retryPreview("two");
    fixture.previews[2]!.resolve("preview retry two");
    await settle();
    await expect(secondPreview).resolves.toBe(true);
    tokens.push(fixture.apply.snapshot().capture.derivedRetryToken);

    const visual = fixture.apply.retryVisual("two");
    fixture.visuals[1]!.resolve("visual retry");
    await settle();
    await expect(visual).resolves.toBe(true);
    expect(fixture.apply.snapshot().capture).toEqual({ ...committed, derivedRetryToken: 4 });
    tokens.push(fixture.apply.snapshot().capture.derivedRetryToken);

    expect(tokens).toEqual([1, 2, 3, 4]);
  });

  it("allocates a higher diff retry token after a preview retry", async () => {
    const fixture = surfaceFixture();
    const initial = fixture.apply.apply("two");
    await resolveStages(fixture);
    await expect(initial).resolves.toBe(true);

    const tokens = [fixture.apply.snapshot().capture.derivedRetryToken];
    const preview = fixture.apply.retryPreview("two");
    fixture.previews[1]!.resolve("preview retry");
    await settle();
    await expect(preview).resolves.toBe(true);
    tokens.push(fixture.apply.snapshot().capture.derivedRetryToken);

    const diff = fixture.apply.retryDiff("two");
    fixture.diffs[1]!.resolve("diff retry");
    await settle();
    await expect(diff).resolves.toBe(true);
    tokens.push(fixture.apply.snapshot().capture.derivedRetryToken);

    expect(tokens).toEqual([1, 2, 3]);
  });

  it("settles use-consumed-response per terminal-local receipt", async () => {
    const fixture = surfaceFixture();
    const entry = { terminalEpochCurrent: true, displayGenerationCurrent: true, selectedSourceCurrent: true };

    const first = fixture.apply.applyTerminalLocal("two", entry);
    await resolveStages(fixture, 0);
    const firstReceipt = await first;
    expect(firstReceipt).toMatchObject({ outcome: "complete", fallback: null });
    if (firstReceipt === null) throw new Error("expected terminal-local receipt");
    expect(typeof firstReceipt.terminalLocalToken).toBe("symbol");
    expect(fixture.apply.settleUseConsumedResponse(firstReceipt.terminalLocalToken, "display-failed")).toBe("use-consumed-response-display-failed");
    expect(fixture.apply.settleUseConsumedResponse(firstReceipt.terminalLocalToken, "displayed")).toBeNull();

    const second = fixture.apply.applyTerminalLocal("three", entry);
    await resolveStages(fixture, 1);
    const secondReceipt = await second;
    expect(secondReceipt).toMatchObject({ outcome: "complete", fallback: null });
    if (secondReceipt === null) throw new Error("expected terminal-local receipt");
    expect(fixture.apply.settleUseConsumedResponse(secondReceipt.terminalLocalToken, "displayed")).toBe("use-consumed-response-displayed");
    expect(fixture.apply.settleUseConsumedResponse(secondReceipt.terminalLocalToken, "displayed")).toBeNull();
  });

  it("reports a target fallback instead of a successful terminal-local display", async () => {
    const fixture = surfaceFixture();
    const attempt = fixture.apply.applyTerminalLocal("two", { terminalEpochCurrent: true, displayGenerationCurrent: true, selectedSourceCurrent: true });
    fixture.previews[0]!.reject(new Error("preview failed"));
    fixture.visuals[0]!.resolve("visual");
    fixture.diffs[0]!.resolve("diff");
    await settle();

    await expect(attempt).resolves.toMatchObject({ outcome: "fallback", fallback: "preview" });
    expect(fixture.apply.snapshot()).toMatchObject({ source: "two", status: "fallback", fallback: "preview", complete: false });
  });

  it("keeps a terminal-local receipt when its commit fails", async () => {
    const fixture = surfaceFixture();
    vi.mocked(fixture.ports.commit).mockImplementation(() => {
      throw new Error("commit failed");
    });
    const entry = { terminalEpochCurrent: true, displayGenerationCurrent: true, selectedSourceCurrent: true };
    const attempt = fixture.apply.applyTerminalLocal("two", entry);
    await resolveStages(fixture);

    const receipt = await attempt;
    expect(receipt).toMatchObject({ outcome: "failed", fallback: null });
    if (receipt === null) throw new Error("expected terminal-local receipt");
    expect(fixture.apply.settleUseConsumedResponse(receipt.terminalLocalToken, "display-failed")).toBe("use-consumed-response-display-failed");
    expect(fixture.apply.settleUseConsumedResponse(receipt.terminalLocalToken, "display-failed")).toBeNull();
  });

  it("rejects a stale terminal-local receipt without consuming the latest receipt", async () => {
    const fixture = surfaceFixture();
    const entry = { terminalEpochCurrent: true, displayGenerationCurrent: true, selectedSourceCurrent: true };

    const first = fixture.apply.applyTerminalLocal("two", entry);
    const second = fixture.apply.applyTerminalLocal("three", entry);
    await resolveStages(fixture, 1);
    const secondReceipt = await second;
    expect(secondReceipt).toMatchObject({ outcome: "complete", fallback: null });
    if (secondReceipt === null) throw new Error("expected second terminal-local receipt");

    await resolveStages(fixture, 0);
    const firstReceipt = await first;
    expect(firstReceipt).toMatchObject({ outcome: "failed", fallback: null });
    if (firstReceipt === null) throw new Error("expected first terminal-local receipt");

    expect(fixture.apply.settleUseConsumedResponse(firstReceipt.terminalLocalToken, "display-failed")).toBeNull();
    expect(fixture.apply.settleUseConsumedResponse(secondReceipt.terminalLocalToken, "displayed")).toBe("use-consumed-response-displayed");
  });

  it("does not create a terminal-local receipt when its entry guard rejects", async () => {
    const fixture = surfaceFixture();
    await expect(fixture.apply.applyTerminalLocal("two", { terminalEpochCurrent: true, displayGenerationCurrent: false, selectedSourceCurrent: true })).resolves.toBeNull();
    expect(fixture.ports.stagePreview).not.toHaveBeenCalled();
  });

  it("rechecks the terminal-local selection before committing staged resources", async () => {
    const fixture = surfaceFixture();
    let current = true;
    const entry = {
      terminalEpochCurrent: true,
      displayGenerationCurrent: true,
      selectedSourceCurrent: true,
      commitCurrent: () => current,
    };
    const attempt = fixture.apply.applyTerminalLocal("two", entry);
    current = false;
    await resolveStages(fixture);

    await expect(attempt).resolves.toMatchObject({ outcome: "failed", fallback: null });
    expect(fixture.ports.commit).not.toHaveBeenCalled();
  });

  it("settles an invalidated terminal-local receipt after its stages finish", async () => {
    const fixture = surfaceFixture();
    const entry = { terminalEpochCurrent: true, displayGenerationCurrent: true, selectedSourceCurrent: true };
    const attempt = fixture.apply.applyTerminalLocal("two", entry);
    fixture.apply.invalidate();
    await resolveStages(fixture);

    const receipt = await attempt;
    expect(receipt).toMatchObject({ outcome: "failed", fallback: null });
    if (receipt === null) throw new Error("expected terminal-local receipt");
    expect(fixture.apply.settleUseConsumedResponse(receipt.terminalLocalToken, "display-failed")).toBe("use-consumed-response-display-failed");
    expect(fixture.apply.settleUseConsumedResponse(receipt.terminalLocalToken, "display-failed")).toBeNull();
  });

  it("retains an invalidated terminal-local receipt through an unrelated full apply", async () => {
    const fixture = surfaceFixture();
    const entry = { terminalEpochCurrent: true, displayGenerationCurrent: true, selectedSourceCurrent: true };
    const terminal = fixture.apply.applyTerminalLocal("two", entry);
    fixture.apply.invalidate();
    const ordinary = fixture.apply.apply("three");
    await resolveStages(fixture, 1);
    await expect(ordinary).resolves.toBe(true);
    await resolveStages(fixture, 0);

    const receipt = await terminal;
    expect(receipt).toMatchObject({ outcome: "failed", fallback: null });
    if (receipt === null) throw new Error("expected terminal-local receipt");
    expect(fixture.apply.settleUseConsumedResponse(receipt.terminalLocalToken, "display-failed")).toBe("use-consumed-response-display-failed");
    expect(fixture.apply.settleUseConsumedResponse(receipt.terminalLocalToken, "display-failed")).toBeNull();
  });

  it("settles a remounted terminal-local receipt after its stages finish", async () => {
    const fixture = surfaceFixture();
    const entry = { terminalEpochCurrent: true, displayGenerationCurrent: true, selectedSourceCurrent: true };
    const attempt = fixture.apply.applyTerminalLocal("two", entry);
    fixture.apply.remount();
    await resolveStages(fixture);

    const receipt = await attempt;
    expect(receipt).toMatchObject({ outcome: "failed", fallback: null });
    if (receipt === null) throw new Error("expected terminal-local receipt");
    expect(fixture.apply.settleUseConsumedResponse(receipt.terminalLocalToken, "display-failed")).toBe("use-consumed-response-display-failed");
    expect(fixture.apply.settleUseConsumedResponse(receipt.terminalLocalToken, "display-failed")).toBeNull();
  });

  it("settles a capture-replaced terminal-local receipt after its stages finish", async () => {
    const fixture = surfaceFixture();
    const entry = { terminalEpochCurrent: true, displayGenerationCurrent: true, selectedSourceCurrent: true };
    const attempt = fixture.apply.applyTerminalLocal("two", entry);
    fixture.apply.replaceCapture(capture({ localGeneration: 2, currentExactSource: "local" }));
    await resolveStages(fixture);

    const receipt = await attempt;
    expect(receipt).toMatchObject({ outcome: "failed", fallback: null });
    if (receipt === null) throw new Error("expected terminal-local receipt");
    expect(fixture.apply.settleUseConsumedResponse(receipt.terminalLocalToken, "display-failed")).toBe("use-consumed-response-display-failed");
    expect(fixture.apply.settleUseConsumedResponse(receipt.terminalLocalToken, "display-failed")).toBeNull();
  });
});
