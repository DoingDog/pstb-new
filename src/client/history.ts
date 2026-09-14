import type { ApiFailure } from "./api";
import type { BaselineCapture, HistoryList, RevisionResource } from "./contracts";
import type { DiffId, DiffLine, DiffRequest, DiffResponse } from "./diff";

export const AUTOMATIC_DIFF_MAX_BYTES = 1_048_576;
export const AUTOMATIC_DIFF_MAX_LINES = 50_000;

export function formatHistoryDiffLine(line: DiffLine): string {
  return `${line.kind === "add" ? "+" : line.kind === "delete" ? "-" : " "}${line.text}`;
}

interface DiffWorker {
  postMessage(message: DiffRequest): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}

interface SelectedDiff {
  revision: DiffId;
  previous: string;
  current: string;
}

export interface HistoryDiffOptions {
  onLines(lines: DiffLine[]): void;
  onError?(message: string): void;
  createWorker?(): DiffWorker;
}

export interface HistoryDiffController {
  selectRevision(revision: DiffId, previous: string, current: string): "automatic" | "manual";
  computeDiff(): boolean;
  clearSelection(): void;
  destroy(): void;
}

function automaticDiffAllowed(previous: string, current: string): boolean {
  const encoder = new TextEncoder();
  return (
    encoder.encode(previous).byteLength <= AUTOMATIC_DIFF_MAX_BYTES &&
    encoder.encode(current).byteLength <= AUTOMATIC_DIFF_MAX_BYTES &&
    lineCount(previous) <= AUTOMATIC_DIFF_MAX_LINES &&
    lineCount(current) <= AUTOMATIC_DIFF_MAX_LINES
  );
}

function lineCount(source: string): number {
  if (source === "") return 0;
  let newlines = 0;
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") newlines += 1;
  }
  return source.endsWith("\n") ? newlines : newlines + 1;
}

function defaultDiffWorker(): DiffWorker {
  return new Worker(new URL("./diff.ts", import.meta.url), { type: "module" });
}

function isDiffResponse(value: unknown): value is DiffResponse {
  if (typeof value !== "object" || value === null) return false;
  const response = value as { type?: unknown; id?: unknown; lines?: unknown; message?: unknown };
  if (typeof response.id !== "string" && typeof response.id !== "number") return false;
  if (response.type === "result") return Array.isArray(response.lines);
  return response.type === "error" && typeof response.message === "string";
}

export function createHistoryDiff(options: HistoryDiffOptions): HistoryDiffController {
  let worker: DiffWorker | undefined;
  let selected: SelectedDiff | undefined;
  let latestId = 0;

  const startDiff = (): boolean => {
    if (selected === undefined) return false;

    if (worker === undefined) {
      try {
        worker = (options.createWorker ?? defaultDiffWorker)();
        worker.onmessage = (event) => {
          if (!isDiffResponse(event.data) || event.data.id !== latestId) return;
          if (event.data.type === "result") options.onLines(event.data.lines);
          else options.onError?.(event.data.message);
        };
        worker.onerror = () => options.onError?.("Unable to calculate diff");
      } catch (error) {
        options.onError?.(error instanceof Error ? error.message : "Unable to calculate diff");
        return false;
      }
    }

    latestId += 1;
    worker.postMessage({ type: "diff", id: latestId, previous: selected.previous, current: selected.current });
    return true;
  };

  return {
    selectRevision(revision, previous, current) {
      selected = { revision, previous, current };
      if (automaticDiffAllowed(previous, current)) {
        startDiff();
        return "automatic";
      }
      latestId += 1;
      return "manual";
    },
    computeDiff: startDiff,
    clearSelection() {
      selected = undefined;
      latestId += 1;
    },
    destroy() {
      selected = undefined;
      latestId += 1;
      worker?.terminate();
      worker = undefined;
    },
  };
}

export interface HistoryFailure {
  status: number | null;
  code: ApiFailure["code"];
}

export interface HistoryControllerSnapshot {
  epoch: number;
  listState: "idle" | "loading" | "ready" | "failed" | "stale";
  snapshotState: "idle" | "loading" | "ready" | "failed";
  list: HistoryList | null;
  selected: RevisionResource | null;
  failure: { target: "list" | "snapshot"; value: HistoryFailure } | null;
}

export interface HistoryController {
  snapshot(): Readonly<HistoryControllerSnapshot>;
  open(capture: BaselineCapture): { token: number; signal: AbortSignal };
  acceptList(token: number, capture: BaselineCapture, value: HistoryList): boolean;
  failList(token: number, capture: BaselineCapture, failure: HistoryFailure): boolean;
  select(revision: number, capture: BaselineCapture): { token: number; signal: AbortSignal };
  acceptSnapshot(token: number, capture: BaselineCapture, value: RevisionResource): boolean;
  failSnapshot(token: number, capture: BaselineCapture, failure: HistoryFailure): boolean;
  invalidate(reason: "remote-apply" | "reload" | "mutation" | "terminal" | "delete"): void;
  retainAfterApply(previous: BaselineCapture, next: BaselineCapture): "all" | "snapshot-only" | "none";
  destroy(): void;
}

interface PendingRequest {
  token: number;
  epoch: number;
  capture: BaselineCapture;
  abort: AbortController;
}

function sameCapture(left: BaselineCapture, right: BaselineCapture): boolean {
  return (
    left.acceptedApplyGeneration === right.acceptedApplyGeneration &&
    left.localGeneration === right.localGeneration &&
    left.generation === right.generation &&
    left.version === right.version &&
    left.contentRevision === right.contentRevision &&
    left.updatedAt === right.updatedAt &&
    left.acceptedSource === right.acceptedSource
  );
}

function settledListState(state: HistoryControllerSnapshot): HistoryControllerSnapshot["listState"] {
  return state.listState === "loading" ? (state.list === null ? "idle" : "ready") : state.listState;
}

function settledSnapshotState(state: HistoryControllerSnapshot): HistoryControllerSnapshot["snapshotState"] {
  return state.snapshotState === "loading" ? (state.selected === null ? "idle" : "ready") : state.snapshotState;
}

export function createHistoryController(): HistoryController {
  let state: HistoryControllerSnapshot = {
    epoch: 0,
    listState: "idle",
    snapshotState: "idle",
    list: null,
    selected: null,
    failure: null,
  };
  let listToken = 0;
  let snapshotToken = 0;
  let listRequest: PendingRequest | undefined;
  let snapshotRequest: PendingRequest | undefined;
  let destroyed = false;

  const retireRequests = (finalize: (current: HistoryControllerSnapshot) => HistoryControllerSnapshot): void => {
    const current = state;
    const listAbort = listRequest?.abort;
    const snapshotAbort = snapshotRequest?.abort;
    listRequest = undefined;
    snapshotRequest = undefined;
    state = { ...finalize(current), epoch: current.epoch + 1 };
    listAbort?.abort();
    snapshotAbort?.abort();
  };

  const matches = (request: PendingRequest | undefined, token: number, capture: BaselineCapture): boolean => (
    !destroyed && request !== undefined && request.token === token && request.epoch === state.epoch && sameCapture(request.capture, capture)
  );

  const retiredRequest = (token: number): { token: number; signal: AbortSignal } => {
    const abort = new AbortController();
    abort.abort();
    return { token, signal: abort.signal };
  };

  return {
    snapshot() {
      return state;
    },
    open(capture) {
      const token = ++listToken;
      if (destroyed) return retiredRequest(token);

      const previous = listRequest;
      const abort = new AbortController();
      listRequest = { token, epoch: state.epoch, capture: { ...capture }, abort };
      state = {
        ...state,
        listState: "loading",
        list: null,
        failure: state.failure?.target === "list" ? null : state.failure,
      };
      previous?.abort.abort();
      return { token, signal: abort.signal };
    },
    acceptList(token, capture, value) {
      if (!matches(listRequest, token, capture)) return false;
      listRequest = undefined;
      state = {
        ...state,
        listState: "ready",
        list: value,
        failure: state.failure?.target === "list" ? null : state.failure,
      };
      return true;
    },
    failList(token, capture, failure) {
      if (!matches(listRequest, token, capture)) return false;
      listRequest = undefined;
      state = { ...state, listState: "failed", list: null, failure: { target: "list", value: failure } };
      return true;
    },
    select(_revision, capture) {
      const token = ++snapshotToken;
      if (destroyed) return retiredRequest(token);

      const previous = snapshotRequest;
      const abort = new AbortController();
      snapshotRequest = { token, epoch: state.epoch, capture: { ...capture }, abort };
      state = {
        ...state,
        snapshotState: "loading",
        selected: null,
        failure: state.failure?.target === "snapshot" ? null : state.failure,
      };
      previous?.abort.abort();
      return { token, signal: abort.signal };
    },
    acceptSnapshot(token, capture, value) {
      if (!matches(snapshotRequest, token, capture)) return false;
      snapshotRequest = undefined;
      state = {
        ...state,
        snapshotState: "ready",
        selected: value,
        failure: state.failure?.target === "snapshot" ? null : state.failure,
      };
      return true;
    },
    failSnapshot(token, capture, failure) {
      if (!matches(snapshotRequest, token, capture)) return false;
      snapshotRequest = undefined;
      state = { ...state, snapshotState: "failed", selected: null, failure: { target: "snapshot", value: failure } };
      return true;
    },
    invalidate(_reason) {
      if (destroyed) return;
      retireRequests((current) => current);
    },
    retainAfterApply(previous, next) {
      if (destroyed) return "none";

      const listState = settledListState(state);
      const snapshotState = settledSnapshotState(state);
      const retainedList = state.list;
      const retainedSnapshot = state.selected;
      const retention = previous.generation !== next.generation
        ? "none"
        : previous.contentRevision !== next.contentRevision || previous.acceptedSource !== next.acceptedSource
          ? "snapshot-only"
          : "all";
      let finalState: HistoryControllerSnapshot;

      if (retention === "none") {
        finalState = { ...state, listState: "idle", snapshotState: "idle", list: null, selected: null, failure: null };
      } else if (retention === "snapshot-only") {
        const retainSnapshot = snapshotState === "ready" && retainedSnapshot !== null;
        finalState = {
          ...state,
          listState: retainedList === null ? "idle" : "stale",
          snapshotState: retainSnapshot ? "ready" : "idle",
          list: retainedList,
          selected: retainSnapshot ? retainedSnapshot : null,
          failure: null,
        };
      } else {
        finalState = {
          ...state,
          listState,
          snapshotState,
          list: listState === "idle" ? null : retainedList,
          selected: snapshotState === "ready" ? retainedSnapshot : null,
        };
      }

      retireRequests(() => finalState);
      return retention;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      retireRequests((current) => ({
        ...current,
        listState: "idle",
        snapshotState: "idle",
        list: null,
        selected: null,
        failure: null,
      }));
    },
  };
}
