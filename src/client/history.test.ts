import { describe, expect, it, vi } from "vitest";
import type { BaselineCapture, HistoryList, RevisionResource } from "./contracts";
import {
  createHistoryController,
  createHistoryDiff,
  formatHistoryDiffLine,
} from "./history";

function baseline(overrides: Partial<BaselineCapture> = {}): BaselineCapture {
  return {
    acceptedApplyGeneration: 3,
    localGeneration: 5,
    generation: "g.1",
    version: "g.1",
    contentRevision: 1,
    updatedAt: "2026-09-15T00:00:00.000Z",
    acceptedSource: "one",
    ...overrides,
  };
}

function historyList(): HistoryList {
  return {
    id: "paste",
    currentRevision: 2,
    currentVersion: "g.1",
    revisions: [{ revision: 1, savedAt: "2026-09-14T00:00:00.000Z", supersededAt: "2026-09-15T00:00:00.000Z", byteLength: 3 }],
  };
}

function revision(overrides: Partial<RevisionResource> = {}): RevisionResource {
  return {
    id: "paste",
    revision: 1,
    savedAt: "2026-09-14T00:00:00.000Z",
    supersededAt: "2026-09-15T00:00:00.000Z",
    byteLength: 3,
    content: "old",
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function settleHistory(controller = createHistoryController(), capture = baseline()) {
  const listRequest = controller.open(capture);
  expect(controller.acceptList(listRequest.token, capture, historyList())).toBe(true);
  const snapshotRequest = controller.select(1, capture);
  expect(controller.acceptSnapshot(snapshotRequest.token, capture, revision())).toBe(true);
  return { capture, controller };
}

const captureMismatches: ReadonlyArray<readonly [string, BaselineCapture]> = [
  ["acceptedApplyGeneration", baseline({ acceptedApplyGeneration: 4 })],
  ["localGeneration", baseline({ localGeneration: 6 })],
  ["generation", baseline({ generation: "g.2" })],
  ["version", baseline({ version: "g.2" })],
  ["contentRevision", baseline({ contentRevision: 2 })],
  ["updatedAt", baseline({ updatedAt: "2026-09-15T00:00:01.000Z" })],
  ["acceptedSource", baseline({ acceptedSource: "two" })],
];

type RequestCallbackCase = {
  name: string;
  start(controller: ReturnType<typeof createHistoryController>, capture: BaselineCapture): { token: number };
  settle(
    controller: ReturnType<typeof createHistoryController>,
    request: { token: number },
    capture: BaselineCapture,
  ): boolean;
};

const requestCallbackCases: readonly RequestCallbackCase[] = [
  {
    name: "acceptList",
    start: (controller, capture) => controller.open(capture),
    settle: (controller, request, capture) => controller.acceptList(request.token, capture, historyList()),
  },
  {
    name: "failList",
    start: (controller, capture) => controller.open(capture),
    settle: (controller, request, capture) => controller.failList(request.token, capture, { status: 500, code: "INTERNAL_ERROR" }),
  },
  {
    name: "acceptSnapshot",
    start: (controller, capture) => controller.select(1, capture),
    settle: (controller, request, capture) => controller.acceptSnapshot(request.token, capture, revision()),
  },
  {
    name: "failSnapshot",
    start: (controller, capture) => controller.select(1, capture),
    settle: (controller, request, capture) => controller.failSnapshot(request.token, capture, { status: 500, code: "INTERNAL_ERROR" }),
  },
];

describe("history diff", () => {
  it("formats diff prefixes as text without constructing HTML", () => {
    expect(formatHistoryDiffLine({ kind: "same", text: "unchanged\n" })).toBe(" unchanged\n");
    expect(formatHistoryDiffLine({ kind: "delete", text: "<script>old</script>\n" })).toBe("-<script>old</script>\n");
    expect(formatHistoryDiffLine({ kind: "add", text: "<img src=x>\n" })).toBe("+<img src=x>\n");
  });

  it("creates the diff worker only after a selected revision has a mounted host and ignores stale text responses", () => {
    const workers: Array<{
      postMessage: ReturnType<typeof vi.fn>;
      terminate: ReturnType<typeof vi.fn>;
      onmessage: ((event: MessageEvent<unknown>) => void) | null;
      onerror: ((event: ErrorEvent) => void) | null;
    }> = [];
    const onLines = vi.fn();
    const history = createHistoryDiff({
      createWorker: () => {
        const worker = { postMessage: vi.fn(), terminate: vi.fn(), onmessage: null, onerror: null };
        workers.push(worker);
        return worker;
      },
      onLines,
    });

    expect(history.selectRevision("1", "a\nb\n", "a\nc\n")).toBe("automatic");
    expect(workers).toHaveLength(0);
    history.setMounted(true);
    expect(workers).toHaveLength(1);
    expect(history.selectRevision("2", "old\n", "<img src=x>\n")).toBe("automatic");

    workers[0]!.onmessage?.({
      data: { type: "result", id: 1, lines: [{ kind: "same", text: "stale\n" }] },
    } as MessageEvent<unknown>);
    expect(onLines).not.toHaveBeenCalled();

    workers[0]!.onmessage?.({
      data: { type: "result", id: 2, lines: [{ kind: "add", text: "<img src=x>\n" }] },
    } as MessageEvent<unknown>);
    expect(onLines).toHaveBeenCalledWith([{ kind: "add", text: "<img src=x>\n" }]);

    history.destroy();
    expect(workers[0]!.terminate).toHaveBeenCalledOnce();
  });

  it("requires explicit diff calculation when either side exceeds the automatic policy", () => {
    const createWorker = vi.fn();
    const history = createHistoryDiff({ createWorker, onLines: vi.fn() });

    expect(history.selectRevision("1", "x".repeat(1_048_577), "current")).toBe("manual");
    expect(createWorker).not.toHaveBeenCalled();
  });
});

describe("history lifecycle arbitration", () => {
  it("drops a list that resolves after a remote apply invalidates its generation", async () => {
    const controller = createHistoryController();
    const g1 = baseline();
    const request = controller.open(g1);
    const response = deferred<HistoryList>();
    const settled = response.promise.then((value) => controller.acceptList(request.token, g1, value));

    controller.invalidate("remote-apply");
    const afterInvalidate = controller.snapshot();
    expect(request.signal.aborted).toBe(true);

    response.resolve(historyList());
    expect(await settled).toBe(false);
    expect(controller.snapshot()).toEqual(afterInvalidate);
  });

  it("drops a superseded snapshot when newer selection settles first", async () => {
    const controller = createHistoryController();
    const g1 = baseline();
    const first = controller.select(1, g1);
    const second = controller.select(2, g1);
    const firstResponse = deferred<RevisionResource>();
    const secondResponse = deferred<RevisionResource>();
    const firstSettle = firstResponse.promise.then((value) => controller.acceptSnapshot(first.token, g1, value));
    const secondSettle = secondResponse.promise.then((value) => controller.acceptSnapshot(second.token, g1, value));

    expect(first.signal.aborted).toBe(true);
    secondResponse.resolve(revision({ revision: 2, content: "new" }));
    expect(await secondSettle).toBe(true);
    const afterSecond = controller.snapshot();

    firstResponse.resolve(revision());
    expect(await firstSettle).toBe(false);
    expect(controller.snapshot()).toEqual(afterSecond);
  });

  it.each(requestCallbackCases)("T7-R1-03 $name rejects every isolated baseline mismatch without changing presentation", ({ start, settle }) => {
    const controller = createHistoryController();
    const capture = baseline();
    const request = start(controller, capture);
    const before = controller.snapshot();

    for (const [, mismatch] of captureMismatches) {
      expect(settle(controller, request, mismatch)).toBe(false);
      expect(controller.snapshot()).toEqual(before);
    }
  });

  it("captures an immutable baseline for list callbacks", () => {
    const controller = createHistoryController();
    const capture = baseline();
    const request = controller.open(capture);
    capture.version = "g.2";

    expect(controller.acceptList(request.token, baseline(), historyList())).toBe(true);
  });

  it("retains settled history across a settings-only version change", () => {
    const { capture, controller } = settleHistory();
    const before = controller.snapshot();

    expect(controller.retainAfterApply(capture, baseline({ version: "g.2", updatedAt: "2026-09-15T00:00:01.000Z" }))).toBe("all");
    expect(controller.snapshot()).toEqual({ ...before, epoch: before.epoch + 1 });
  });

  it("marks the list stale while retaining an immutable selected snapshot after content changes", () => {
    const { capture, controller } = settleHistory();
    const selected = controller.snapshot().selected;

    expect(controller.retainAfterApply(capture, baseline({ version: "g.2", contentRevision: 2, updatedAt: "2026-09-15T00:00:01.000Z", acceptedSource: "two" }))).toBe("snapshot-only");
    expect(controller.snapshot()).toMatchObject({
      listState: "stale",
      snapshotState: "ready",
      list: historyList(),
      selected,
      failure: null,
    });
  });

  it("clears history when the paste generation changes", () => {
    const { capture, controller } = settleHistory();

    expect(controller.retainAfterApply(capture, baseline({ generation: "g.2", version: "g.2" }))).toBe("none");
    expect(controller.snapshot()).toMatchObject({
      listState: "idle",
      snapshotState: "idle",
      list: null,
      selected: null,
      failure: null,
    });
  });

  it("returns separate monotonic tokens and aborts replaced list and snapshot requests", () => {
    const controller = createHistoryController();
    const capture = baseline();
    const firstList = controller.open(capture);
    const secondList = controller.open(capture);
    const firstSnapshot = controller.select(1, capture);
    const secondSnapshot = controller.select(2, capture);

    expect(secondList.token).toBeGreaterThan(firstList.token);
    expect(secondSnapshot.token).toBeGreaterThan(firstSnapshot.token);
    expect(firstList.signal.aborted).toBe(true);
    expect(firstSnapshot.signal.aborted).toBe(true);
  });

  it("does not replace loading presentation when a stale failure settles", () => {
    const controller = createHistoryController();
    const g1 = baseline();
    const first = controller.open(g1);
    const second = controller.open(g1);
    const beforeFailure = controller.snapshot();

    expect(controller.failList(first.token, g1, { status: 500, code: "INTERNAL_ERROR" })).toBe(false);
    expect(controller.snapshot()).toEqual(beforeFailure);
    expect(controller.failList(second.token, g1, { status: 500, code: "INTERNAL_ERROR" })).toBe(true);
    expect(controller.snapshot()).toMatchObject({
      listState: "failed",
      failure: { target: "list", value: { status: 500, code: "INTERNAL_ERROR" } },
    });
  });

  it("drops a snapshot that resolves after accepted current content changes", () => {
    const controller = createHistoryController();
    const g1 = baseline({ version: "g.1", contentRevision: 1, acceptedSource: "one" });
    const request = controller.select(1, g1);
    controller.invalidate("remote-apply");
    const accepted = controller.acceptSnapshot(request.token, g1, revision({ revision: 1, content: "old" }));

    expect(accepted).toBe(false);
    expect(controller.snapshot().selected).toBeNull();
  });

  it("aborts both active requests during invalidation", () => {
    const controller = createHistoryController();
    const capture = baseline();
    const list = controller.open(capture);
    const snapshot = controller.select(1, capture);

    controller.invalidate("mutation");

    expect(list.signal.aborted).toBe(true);
    expect(snapshot.signal.aborted).toBe(true);
    expect(controller.snapshot().epoch).toBe(1);
  });

  it("restores settled history when an in-flight refresh is invalidated", () => {
    const { capture, controller } = settleHistory();
    const previous = controller.snapshot();
    const list = controller.open(capture);
    const snapshot = controller.select(2, capture);

    controller.invalidate("mutation");

    expect(list.signal.aborted).toBe(true);
    expect(snapshot.signal.aborted).toBe(true);
    expect(controller.snapshot()).toEqual({
      ...previous,
      epoch: previous.epoch + 1,
    });
  });

  it("aborts requests and rejects callbacks after destroy", () => {
    const controller = createHistoryController();
    const capture = baseline();
    const list = controller.open(capture);
    const snapshot = controller.select(1, capture);

    controller.destroy();

    expect(list.signal.aborted).toBe(true);
    expect(snapshot.signal.aborted).toBe(true);
    expect(controller.acceptList(list.token, capture, historyList())).toBe(false);
    expect(controller.acceptSnapshot(snapshot.token, capture, revision())).toBe(false);
  });

  it("T7-R1-03 keeps list and snapshot ownership independent", () => {
    const controller = createHistoryController();
    const capture = baseline();
    const firstList = controller.open(capture);
    const firstSnapshot = controller.select(1, capture);
    const secondList = controller.open(capture);

    expect(firstList.signal.aborted).toBe(true);
    expect(firstSnapshot.signal.aborted).toBe(false);
    expect(controller.acceptSnapshot(firstSnapshot.token, capture, revision())).toBe(true);

    const secondSnapshot = controller.select(2, capture);
    expect(secondList.signal.aborted).toBe(false);
    expect(controller.acceptList(secondList.token, capture, historyList())).toBe(true);
    expect(controller.acceptSnapshot(firstSnapshot.token, capture, revision())).toBe(false);
    expect(controller.acceptSnapshot(secondSnapshot.token, capture, revision({ revision: 2 }))).toBe(true);
    expect(controller.snapshot()).toMatchObject({
      listState: "ready",
      snapshotState: "ready",
      list: historyList(),
      selected: revision({ revision: 2 }),
    });
  });

  it("T7-R1-03 copies the baseline passed to select", () => {
    const controller = createHistoryController();
    const capture = baseline();
    const request = controller.select(1, capture);
    capture.acceptedSource = "two";

    expect(controller.acceptSnapshot(request.token, baseline(), revision())).toBe(true);
  });

  it.each(["remote-apply", "reload", "mutation", "terminal", "delete"] as const)("T7-R1-03 invalidates both streams for %s", (reason) => {
    const controller = createHistoryController();
    const capture = baseline();
    const list = controller.open(capture);
    const snapshot = controller.select(1, capture);
    const before = controller.snapshot();

    controller.invalidate(reason);

    expect(list.signal.aborted).toBe(true);
    expect(snapshot.signal.aborted).toBe(true);
    expect(controller.acceptList(list.token, capture, historyList())).toBe(false);
    expect(controller.failSnapshot(snapshot.token, capture, { status: 500, code: "INTERNAL_ERROR" })).toBe(false);
    expect(controller.snapshot()).toEqual({
      epoch: before.epoch + 1,
      listState: "idle",
      snapshotState: "idle",
      list: null,
      selected: null,
      failure: null,
    });
  });

  it.each([
    ["all", baseline({ version: "g.2", updatedAt: "2026-09-15T00:00:01.000Z" })],
    ["snapshot-only", baseline({ acceptedSource: "two" })],
    ["none", baseline({ generation: "g.2", version: "g.2" })],
  ] as const)("T7-R1-03 retires in-flight streams for %s retention", (expected, next) => {
    const controller = createHistoryController();
    const capture = baseline();
    const list = controller.open(capture);
    const snapshot = controller.select(1, capture);

    expect(controller.retainAfterApply(capture, next)).toBe(expected);
    expect(list.signal.aborted).toBe(true);
    expect(snapshot.signal.aborted).toBe(true);
    expect(controller.acceptList(list.token, capture, historyList())).toBe(false);
    expect(controller.acceptSnapshot(snapshot.token, capture, revision())).toBe(false);
    expect(controller.snapshot()).toEqual({
      epoch: 1,
      listState: "idle",
      snapshotState: "idle",
      list: null,
      selected: null,
      failure: null,
    });
  });

  it("T7-R1-02 treats an acceptedSource-only change as snapshot-only retention", () => {
    const { capture, controller } = settleHistory();
    const selected = controller.snapshot().selected;

    expect(controller.retainAfterApply(capture, baseline({ acceptedSource: "two" }))).toBe("snapshot-only");
    expect(controller.snapshot()).toMatchObject({
      listState: "stale",
      snapshotState: "ready",
      list: historyList(),
      selected,
      failure: null,
    });
  });

  it("T7-R1-01 retires an outer list replacement when its abort listener starts a newer request", () => {
    const controller = createHistoryController();
    const capture = baseline();
    const first = controller.open(capture);
    let nested: ReturnType<typeof controller.open> | undefined;
    first.signal.addEventListener("abort", () => {
      nested = controller.open(capture);
    });

    const outer = controller.open(capture);
    if (nested === undefined) throw new Error("replacement did not run from the abort listener");

    expect(outer.signal.aborted).toBe(true);
    expect(nested.signal.aborted).toBe(false);
    expect(controller.acceptList(outer.token, capture, historyList())).toBe(false);
    expect(controller.acceptList(nested.token, capture, historyList())).toBe(true);
  });

  it("T7-R1-01 retires an outer snapshot replacement when its abort listener starts a newer request", () => {
    const controller = createHistoryController();
    const capture = baseline();
    const first = controller.select(1, capture);
    let nested: ReturnType<typeof controller.select> | undefined;
    first.signal.addEventListener("abort", () => {
      nested = controller.select(2, capture);
    });

    const outer = controller.select(3, capture);
    if (nested === undefined) throw new Error("replacement did not run from the abort listener");

    expect(outer.signal.aborted).toBe(true);
    expect(nested.signal.aborted).toBe(false);
    expect(controller.acceptSnapshot(outer.token, capture, revision({ revision: 3 }))).toBe(false);
    expect(controller.acceptSnapshot(nested.token, capture, revision({ revision: 2 }))).toBe(true);
  });

  it("T7-R1-01 prevents invalidation and retention listeners from accepting stale data", () => {
    const capture = baseline();
    const invalidationController = createHistoryController();
    const invalidated = invalidationController.open(capture);
    let invalidationAccepted: boolean | undefined;
    invalidated.signal.addEventListener("abort", () => {
      invalidationAccepted = invalidationController.acceptList(invalidated.token, capture, historyList());
    });

    invalidationController.invalidate("remote-apply");

    expect(invalidationAccepted).toBe(false);
    expect(invalidationController.snapshot()).toEqual({
      epoch: 1,
      listState: "idle",
      snapshotState: "idle",
      list: null,
      selected: null,
      failure: null,
    });

    const retentionController = createHistoryController();
    const retained = retentionController.open(capture);
    let retentionAccepted: boolean | undefined;
    retained.signal.addEventListener("abort", () => {
      retentionAccepted = retentionController.acceptList(retained.token, capture, historyList());
    });

    expect(retentionController.retainAfterApply(capture, baseline({ version: "g.2", updatedAt: "2026-09-15T00:00:01.000Z" }))).toBe("all");
    expect(retentionAccepted).toBe(false);
    expect(retentionController.snapshot()).toEqual({
      epoch: 1,
      listState: "idle",
      snapshotState: "idle",
      list: null,
      selected: null,
      failure: null,
    });
  });

  it("T7-R1-01 installs terminal presentation before destroy abort listeners run", () => {
    const controller = createHistoryController();
    const capture = baseline();
    const list = controller.open(capture);
    const snapshot = controller.select(1, capture);
    let listAbortState: ReturnType<typeof controller.snapshot> | undefined;
    let snapshotAbortState: ReturnType<typeof controller.snapshot> | undefined;
    list.signal.addEventListener("abort", () => {
      listAbortState = controller.snapshot();
    });
    snapshot.signal.addEventListener("abort", () => {
      snapshotAbortState = controller.snapshot();
    });

    controller.destroy();

    const terminal = controller.snapshot();
    expect(terminal).toEqual({
      epoch: 1,
      listState: "idle",
      snapshotState: "idle",
      list: null,
      selected: null,
      failure: null,
    });
    expect(listAbortState).toEqual(terminal);
    expect(snapshotAbortState).toEqual(terminal);
  });

  it("T7-R1-03 returns aborted signals without changing state after destroy", () => {
    const controller = createHistoryController();
    const capture = baseline();
    controller.destroy();
    const terminal = controller.snapshot();

    const list = controller.open(capture);
    const snapshot = controller.select(1, capture);

    expect(list.signal.aborted).toBe(true);
    expect(snapshot.signal.aborted).toBe(true);
    expect(controller.snapshot()).toEqual(terminal);
  });
});
