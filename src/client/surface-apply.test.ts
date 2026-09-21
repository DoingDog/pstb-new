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
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
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
