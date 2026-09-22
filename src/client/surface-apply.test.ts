import { describe, expect, it, vi } from "vitest";
import {
  createStagedSurfaceApply,
  type DerivedSurfaceCapture,
  type GuardedSurfaceOperation,
  type StagedSurfacePorts,
} from "./surface-apply";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
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

function fixture() {
  const previews: Deferred<unknown>[] = [];
  const ports: StagedSurfacePorts = {
    stagePreview: vi.fn(() => {
      const value = deferred<unknown>();
      previews.push(value);
      return value.promise;
    }),
    stageVisual: vi.fn(async () => "visual"),
    stageDiff: vi.fn(async () => "diff"),
    mounted: () => ["preview"],
    prepareCommit: vi.fn(() => () => {}),
    commit: vi.fn(() => undefined),
    restoreOld: vi.fn(async () => true),
    showOldGenerationFailure: vi.fn(() => undefined),
    disposeAttemptResources: vi.fn(),
  };
  return { previews, ports, apply: createStagedSurfaceApply({ ports, capture: capture() }) };
}

function operation(overrides: Partial<GuardedSurfaceOperation> = {}): GuardedSurfaceOperation {
  return {
    enter: vi.fn(() => true),
    prepare: vi.fn(() => ({ commit: () => undefined, fail: () => undefined })),
    reject: vi.fn(),
    ...overrides,
  };
}

function rollbackFixture() {
  const restoration = deferred<boolean>();
  const order: string[] = [];
  const ports: StagedSurfacePorts = {
    stagePreview: vi.fn(async (source) => {
      order.push(`stage-preview-${source}`);
      return `preview-${source}`;
    }),
    stageVisual: vi.fn(async (source) => {
      order.push(`stage-visual-${source}`);
      return `visual-${source}`;
    }),
    stageDiff: vi.fn(async (source) => {
      order.push(`stage-diff-${source}`);
      return `diff-${source}`;
    }),
    mounted: () => ["preview", "visual", "diff"],
    commit: vi.fn(() => undefined),
    restoreOld: vi.fn(() => {
      order.push("restore");
      return restoration.promise;
    }),
    showOldGenerationFailure: vi.fn(() => {
      order.push("show-old-fallback");
      return () => { order.push("fallback-release"); };
    }),
    disposeAttemptResources: vi.fn((attempt) => {
      const staged = (attempt as { staged: Record<string, unknown> }).staged;
      order.push(`dispose-${Object.keys(staged).join(",")}`);
    }),
  };
  return { restoration, order, ports, apply: createStagedSurfaceApply({ ports, capture: capture() }) };
}

describe("serial prepared surface apply", () => {
  it("runs two queued async operations in FIFO order with stable promises", async () => {
    const test = fixture();
    const order: string[] = [];
    vi.mocked(test.ports.commit).mockImplementation((_staged, generation) => {
      order.push(`commit-${generation}`);
      return () => { order.push(`release-${generation}`); };
    });
    const first = operation({ prepare: vi.fn(() => ({ commit: () => { order.push("first"); }, fail: () => undefined })) });
    const second = operation({ prepare: vi.fn(() => ({ commit: () => { order.push("second"); }, fail: () => undefined })) });

    const firstResult = test.apply.apply("two", first);
    const secondResult = test.apply.apply("three", second);
    expect(test.ports.stagePreview).toHaveBeenCalledOnce();
    test.previews[0]!.resolve("preview-two");
    await settle();
    await expect(firstResult).resolves.toBe(true);
    expect(test.ports.stagePreview).toHaveBeenCalledTimes(2);
    expect(order).toEqual(["commit-2", "first", "release-2"]);

    test.previews[1]!.resolve("preview-three");
    await settle();
    await expect(secondResult).resolves.toBe(true);
    expect(order).toEqual(["commit-2", "first", "release-2", "commit-3", "second", "release-3"]);
  });

  it("cancels a never-settling staged head, starts later FIFO work, and disposes its late value", async () => {
    const test = fixture();
    const first = test.apply.apply("two", operation());
    const second = test.apply.apply("three", operation());
    test.apply.invalidate();
    await settle();

    await expect(first).resolves.toBe(false);
    expect(test.ports.stagePreview).toHaveBeenCalledTimes(2);
    test.previews[1]!.resolve("preview-three");
    await expect(second).resolves.toBe(true);
    test.previews[0]!.resolve("late-preview-two");
    await settle();
    expect(test.ports.disposeAttemptResources).toHaveBeenCalledWith(expect.objectContaining({ staged: { preview: "late-preview-two" } }));
  });

  it("keeps FIFO blocked until asynchronous restoration completes", async () => {
    const test = fixture();
    const restoration = deferred<boolean>();
    vi.mocked(test.ports.commit).mockImplementationOnce(() => { throw new Error("commit failed"); });
    vi.mocked(test.ports.restoreOld).mockReturnValue(restoration.promise);
    const first = test.apply.apply("two", operation());
    const second = test.apply.apply("three", operation());

    test.previews[0]!.resolve("preview-two");
    await settle();
    expect(test.ports.restoreOld).toHaveBeenCalledOnce();
    expect(test.ports.stagePreview).toHaveBeenCalledTimes(1);
    restoration.resolve(true);
    await settle();
    await expect(first).resolves.toBe(false);
    expect(test.ports.stagePreview).toHaveBeenCalledTimes(2);
    test.previews[1]!.resolve("preview-three");
    await expect(second).resolves.toBe(true);
  });


  it("restores the exact old presentation before releasing staged targets or newer FIFO work", async () => {
    const test = rollbackFixture();
    const commitFailure = new Error("commit failed");
    vi.mocked(test.ports.commit)
      .mockImplementationOnce(() => {
        test.order.push("commit-failed");
        throw commitFailure;
      })
      .mockImplementation(() => {
        test.order.push("commit-succeeded");
      });
    const first = test.apply.apply("two", operation({
      prepare: () => ({
        commit: () => undefined,
        fail: () => {
          test.order.push("prepared-fail");
          return () => { test.order.push("failure-release"); };
        },
      }),
    }));
    const second = test.apply.apply("three", operation());

    await settle();
    expect(test.ports.restoreOld).toHaveBeenCalledWith({
      failedGeneration: 2,
      oldGeneration: 1,
      oldSource: "one",
      parentApplyToken: 2,
      hostGeneration: 1,
    });
    expect(test.ports.disposeAttemptResources).not.toHaveBeenCalled();
    expect(test.ports.stagePreview).toHaveBeenCalledTimes(1);

    test.restoration.resolve(true);
    await expect(first).resolves.toBe(false);
    expect(test.ports.disposeAttemptResources).toHaveBeenCalledTimes(3);
    expect(test.order.indexOf("dispose-preview")).toBeGreaterThan(test.order.indexOf("restore"));
    expect(test.order.indexOf("failure-release")).toBeGreaterThan(test.order.indexOf("dispose-diff"));

    await settle();
    expect(test.ports.stagePreview).toHaveBeenCalledTimes(2);
    await expect(second).resolves.toBe(true);
    expect(test.apply.snapshot()).toMatchObject({ source: "three", status: "committed" });
  });

  it.each([
    ["returns false", () => Promise.resolve(false)],
    ["rejects", () => Promise.reject(new Error("restore failed"))],
  ] as const)("installs an old-bound fallback when restoreOld %s", async (_result, restoreOld) => {
    const test = rollbackFixture();
    vi.mocked(test.ports.commit).mockImplementation(() => { throw new Error("commit failed"); });
    vi.mocked(test.ports.restoreOld).mockImplementation(restoreOld);

    await expect(test.apply.apply("two", operation())).resolves.toBe(false);

    expect(test.ports.restoreOld).toHaveBeenCalledWith({
      failedGeneration: 2,
      oldGeneration: 1,
      oldSource: "one",
      parentApplyToken: 2,
      hostGeneration: 1,
    });
    expect(test.ports.showOldGenerationFailure).toHaveBeenCalledWith({
      failedGeneration: 2,
      oldGeneration: 1,
      oldSource: "one",
      parentApplyToken: 2,
      hostGeneration: 1,
    });
    expect(test.apply.snapshot()).toEqual({
      capture: capture(),
      source: "one",
      status: "fallback",
      fallback: "preview",
      complete: false,
    });
  });

  it("uses the mounted old surface for a rollback fallback", async () => {
    const test = rollbackFixture();
    test.ports.mounted = () => ["visual"];
    vi.mocked(test.ports.commit).mockImplementation(() => { throw new Error("commit failed"); });
    vi.mocked(test.ports.restoreOld).mockResolvedValue(false);

    await expect(test.apply.apply("two", operation())).resolves.toBe(false);

    expect(test.apply.snapshot()).toEqual({
      capture: capture(),
      source: "one",
      status: "fallback",
      fallback: "visual",
      complete: false,
    });
  });

  it("contains target-disposal throws after restoring the old generation", async () => {
    const test = rollbackFixture();
    vi.mocked(test.ports.commit).mockImplementation(() => { throw new Error("commit failed"); });
    vi.mocked(test.ports.disposeAttemptResources).mockImplementation((attempt) => {
      const staged = (attempt as { staged: Record<string, unknown> }).staged;
      test.order.push(`dispose-${Object.keys(staged).join(",")}`);
      throw new Error("dispose failed");
    });
    const attempt = test.apply.apply("two", operation());

    await settle();
    expect(test.ports.disposeAttemptResources).not.toHaveBeenCalled();
    test.restoration.resolve(true);
    await expect(attempt).resolves.toBe(false);

    expect(test.ports.disposeAttemptResources).toHaveBeenCalledTimes(3);
    expect(test.apply.snapshot()).toEqual({
      capture: capture(),
      source: "one",
      status: "idle",
      fallback: null,
      complete: false,
    });
  });

  it("uses the failed host identity before a queued remount advances it", async () => {
    const test = rollbackFixture();
    vi.mocked(test.ports.commit).mockImplementation(() => { throw new Error("commit failed"); });
    const attempt = test.apply.apply("two", operation());

    await settle();
    test.apply.remount();
    test.restoration.resolve(true);
    await expect(attempt).resolves.toBe(false);
    await settle();

    expect(test.ports.restoreOld).toHaveBeenCalledWith(expect.objectContaining({
      failedGeneration: 2,
      oldGeneration: 1,
      hostGeneration: 1,
      parentApplyToken: 2,
    }));
    expect(test.apply.snapshot()).toEqual({
      capture: capture({ hostGeneration: 2, parentApplyToken: 2, derivedRetryToken: 2 }),
      source: "one",
      status: "idle",
      fallback: null,
      complete: false,
    });
  });

  it("does not let a queued newer operation overwrite restored rollback presentation", async () => {
    const test = rollbackFixture();
    vi.mocked(test.ports.commit)
      .mockImplementationOnce(() => { throw new Error("commit failed"); })
      .mockImplementation(() => undefined);
    const first = test.apply.apply("two", operation());
    const second = test.apply.apply("three", operation());

    await settle();
    test.restoration.resolve(true);
    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(true);

    expect(test.ports.restoreOld).toHaveBeenCalledWith(expect.objectContaining({
      failedGeneration: 2,
      oldGeneration: 1,
      parentApplyToken: 2,
      hostGeneration: 1,
    }));
    expect(test.apply.snapshot()).toMatchObject({
      source: "three",
      status: "committed",
      capture: { currentDisplayGeneration: 2, parentApplyToken: 2 },
    });
  });

  it("rejects and poisons only the local scheduler when a prepared commit throws", async () => {
    const test = fixture();
    const failure = new Error("prepared commit failed");
    const first = test.apply.apply("two", operation({
      prepare: () => ({ commit: () => { throw failure; }, fail: () => undefined }),
    }));
    const second = test.apply.apply("three", operation());

    test.previews[0]!.resolve("preview-two");
    await settle();
    await expect(first).rejects.toBe(failure);
    await expect(second).rejects.toBe(failure);
    expect(test.ports.stagePreview).toHaveBeenCalledOnce();
  });

  it("runs enter at FIFO execution time before allocation or staging", async () => {
    const test = fixture();
    const first = test.apply.apply("two", operation());
    const stale = operation({ enter: vi.fn(() => false) });
    const second = test.apply.apply("three", stale);

    expect(stale.enter).not.toHaveBeenCalled();
    test.previews[0]!.resolve("preview-two");
    await first;
    await expect(second).resolves.toBe(false);
    expect(stale.enter).toHaveBeenCalledOnce();
    expect(stale.reject).toHaveBeenCalledOnce();
    expect(test.ports.stagePreview).toHaveBeenCalledOnce();
  });

  it("runs nested work through the same drain after release", async () => {
    const test = fixture();
    let nested: Promise<boolean> | undefined;
    const first = test.apply.apply("two", operation());
    vi.mocked(test.ports.commit).mockImplementationOnce(() => () => {
      test.apply.replaceCapture(capture({ currentExactSource: "two", currentDisplayGeneration: 2 }));
      nested = test.apply.apply("three", operation());
    });

    test.previews[0]!.resolve("preview-two");
    await first;
    await settle();
    expect(nested).toBeDefined();
    expect(test.ports.stagePreview).toHaveBeenCalledTimes(2);
    test.previews[1]!.resolve("preview-three");
    await expect(nested).resolves.toBe(true);
  });

  it("does not publish mixed state when a prepared controller or PasteSync claim rejects", async () => {
    const test = fixture();
    const rejected = operation({ prepare: () => null });
    const result = test.apply.apply("remote", rejected);

    test.previews[0]!.resolve("preview-remote");
    await expect(result).resolves.toBe(false);
    expect(test.ports.commit).not.toHaveBeenCalled();
    expect(rejected.reject).toHaveBeenCalledOnce();
    expect(test.apply.snapshot()).toMatchObject({ source: "one", status: "idle" });
  });

  for (const surface of ["preview", "visual", "diff"] as const) {
    it(`rejects a failed ${surface} Retry without replacing siblings`, async () => {
      const fail = new Error(`${surface} stage failed`);
      const stagePreview = vi.fn(async () => {
        if (surface === "preview") throw fail;
        return "preview-resource";
      });
      const stageVisual = vi.fn(async () => {
        if (surface === "visual") throw fail;
        return "visual-resource";
      });
      const stageDiff = vi.fn(async () => {
        if (surface === "diff") throw fail;
        return "diff-resource";
      });
      const ports: StagedSurfacePorts = {
        stagePreview,
        stageVisual,
        stageDiff,
        mounted: () => ["preview", "visual", "diff"],
        commit: vi.fn(() => undefined),
        restoreOld: vi.fn(async () => true),
        showOldGenerationFailure: vi.fn(() => undefined),
        disposeAttemptResources: vi.fn(),
      };
      const apply = createStagedSurfaceApply({ ports, capture: capture() });

      await expect(apply.apply("two", operation())).resolves.toBe(true);
      const prior = apply.snapshot();
      const priorDisposals = vi.mocked(ports.disposeAttemptResources).mock.calls.length;

      await expect(
        surface === "preview" ? apply.retryPreview("two") : surface === "visual" ? apply.retryVisual("two") : apply.retryDiff("two"),
      ).resolves.toBe(false);

      expect(ports.commit).toHaveBeenCalledTimes(1);
      expect(stagePreview).toHaveBeenCalledTimes(surface === "preview" ? 2 : 1);
      expect(stageVisual).toHaveBeenCalledTimes(surface === "visual" ? 2 : 1);
      expect(stageDiff).toHaveBeenCalledTimes(surface === "diff" ? 2 : 1);
      expect(apply.snapshot()).toEqual(prior);
      expect(ports.disposeAttemptResources).toHaveBeenCalledTimes(priorDisposals + 1);
      expect(ports.disposeAttemptResources).toHaveBeenLastCalledWith(expect.objectContaining({
        staged: expect.objectContaining({ [surface]: expect.anything() }),
      }));
    });
  }

  it("rejects a failed terminal Preview Retry without replacing its fallback", async () => {
    const failure = new Error("preview stage failed");
    const ports: StagedSurfacePorts = {
      stagePreview: vi.fn(async () => { throw failure; }),
      stageVisual: vi.fn(async () => "visual-resource"),
      stageDiff: vi.fn(async () => "diff-resource"),
      mounted: () => ["preview"],
      commit: vi.fn(() => undefined),
      restoreOld: vi.fn(async () => true),
      showOldGenerationFailure: vi.fn(() => undefined),
      disposeAttemptResources: vi.fn(),
    };
    const apply = createStagedSurfaceApply({ ports, capture: capture() });

    await expect(apply.applyTerminalLocal("two", {
      terminalEpochCurrent: true,
      displayGenerationCurrent: true,
      selectedSourceCurrent: true,
    })).resolves.toMatchObject({ outcome: "fallback", fallback: "preview" });
    const prior = apply.snapshot();
    const priorDisposals = vi.mocked(ports.disposeAttemptResources).mock.calls.length;

    await expect(apply.retryPreview("two")).resolves.toBe(false);

    expect(ports.commit).toHaveBeenCalledTimes(1);
    expect(ports.stagePreview).toHaveBeenCalledTimes(2);
    expect(ports.stageVisual).not.toHaveBeenCalled();
    expect(ports.stageDiff).not.toHaveBeenCalled();
    expect(apply.snapshot()).toEqual(prior);
    expect(ports.disposeAttemptResources).toHaveBeenCalledTimes(priorDisposals + 1);
    expect(ports.disposeAttemptResources).toHaveBeenLastCalledWith(expect.objectContaining({
      staged: expect.objectContaining({ preview: expect.anything() }),
    }));
  });

  it("serializes terminal-local work behind an ordinary operation", async () => {
    const test = fixture();
    const ordinary = test.apply.apply("two", operation());
    const terminal = test.apply.applyTerminalLocal("three", {
      terminalEpochCurrent: true,
      displayGenerationCurrent: true,
      selectedSourceCurrent: true,
    });

    test.previews[0]!.resolve("preview-two");
    await ordinary;
    await settle();
    expect(test.ports.stagePreview).toHaveBeenCalledTimes(2);
    test.previews[1]!.resolve("preview-three");
    await expect(terminal).resolves.toMatchObject({ outcome: "complete" });
  });
});
