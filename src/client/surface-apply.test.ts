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

function surfaceFixture(initial = capture()) {
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
    apply: createStagedSurfaceApply({ ports, capture: initial }),
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
    expect(fixture.ports.commit).toHaveBeenCalledWith({ preview: "preview-0", visual: "visual-0", diff: "diff-0" }, 1);
  });

  it("keeps current presentation when an edit invalidates a detached stage", async () => {
    const fixture = surfaceFixture();
    const attempt = fixture.apply.apply("two");
    fixture.apply.replaceCapture(capture({ localGeneration: 2, currentExactSource: "local" }));
    await resolveStages(fixture);

    await expect(attempt).resolves.toBe(false);
    expect(fixture.ports.commit).not.toHaveBeenCalled();
    expect(fixture.ports.disposeAttemptResources).toHaveBeenCalledTimes(1);
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
    expect(fixture.ports.disposeAttemptResources).toHaveBeenCalledTimes(1);
  });

  it("drops a reverse retry without clearing the current fallback or draft source", async () => {
    const fixture = surfaceFixture();
    const first = fixture.apply.retry("two");
    const firstPreview = fixture.previews[0]!.promise;
    const second = fixture.apply.retry("two");
    const secondPreview = fixture.previews[1]!.promise;

    expect(firstPreview).not.toBe(secondPreview);
    await resolveStages(fixture, 1);
    await expect(second).resolves.toBe(true);
    await resolveStages(fixture, 0);
    await expect(first).resolves.toBe(false);
    expect(fixture.ports.commit).toHaveBeenCalledTimes(1);
    expect(fixture.apply.snapshot()).toMatchObject({ source: "two" });
  });

  it("retains the old generation when a detached preview fails", async () => {
    const fixture = surfaceFixture();
    const attempt = fixture.apply.apply("two");
    fixture.previews[0]!.reject(new Error("preview failed"));
    fixture.visuals[0]!.resolve("visual");
    fixture.diffs[0]!.resolve("diff");
    await settle();

    await expect(attempt).resolves.toBe(false);
    expect(fixture.ports.commit).not.toHaveBeenCalled();
    expect(fixture.apply.snapshot()).toMatchObject({ status: "fallback", source: "one", fallback: "preview" });
  });
});

describe("terminal settlement", () => {
  it("settles a terminal origin exactly once with the required outcome key", () => {
    const fixture = surfaceFixture();
    expect(fixture.apply.settleTerminal({ actionKey: "content-reconcile", actionAttempt: 3, startedAt: "2026-09-15T00:00:00.000Z" }, "displayed")).toBe("content-reconcile-terminal-current-kept");
    expect(fixture.apply.settleTerminal({ actionKey: "content-reconcile", actionAttempt: 3, startedAt: "2026-09-15T00:00:00.000Z" }, "displayed")).toBe("");
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
