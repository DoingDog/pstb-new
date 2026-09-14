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

describe("history diff", () => {
  it("formats diff prefixes as text without constructing HTML", () => {
    expect(formatHistoryDiffLine({ kind: "same", text: "unchanged\n" })).toBe(" unchanged\n");
    expect(formatHistoryDiffLine({ kind: "delete", text: "<script>old</script>\n" })).toBe("-<script>old</script>\n");
    expect(formatHistoryDiffLine({ kind: "add", text: "<img src=x>\n" })).toBe("+<img src=x>\n");
  });

  it("creates the diff worker only for a selected revision and ignores stale text responses", () => {
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

  it("requires every BaselineCapture field to match before accepting a list", () => {
    const controller = createHistoryController();
    const capture = baseline();
    const request = controller.open(capture);
    const mismatches: BaselineCapture[] = [
      baseline({ acceptedApplyGeneration: 4 }),
      baseline({ localGeneration: 6 }),
      baseline({ generation: "g.2" }),
      baseline({ version: "g.2" }),
      baseline({ contentRevision: 2 }),
      baseline({ updatedAt: "2026-09-15T00:00:01.000Z" }),
      baseline({ acceptedSource: "two" }),
    ];

    for (const mismatch of mismatches) {
      expect(controller.acceptList(request.token, mismatch, historyList())).toBe(false);
    }
    expect(controller.snapshot()).toEqual({
      epoch: 0,
      listState: "loading",
      snapshotState: "idle",
      list: null,
      selected: null,
      failure: null,
    });
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
});
