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

export interface StagedHistoryDiff {
  id: number;
  previous: string;
  current: string;
  lines: DiffLine[];
}

interface PendingStagedHistoryDiff {
  id: number;
  previous: string;
  current: string;
  resolve(value: StagedHistoryDiff | null): void;
  reject(reason: Error): void;
}

interface ActiveDiffRequest {
  worker: DiffWorker;
  id: number;
  generation: number;
}

export interface HistoryDiffOptions {
  onLines(lines: DiffLine[]): void;
  onError?(message: string): void;
  createWorker?(): DiffWorker;
}

export type HistoryDiffMode = "idle" | "computing" | "manual" | "unchanged" | "failed";

export interface HistoryDiffController {
  selectRevision(revision: DiffId, previous: string, current: string): "automatic" | "manual";
  replaceCurrent(current: string): HistoryDiffMode;
  stageCurrent(current: string): Promise<StagedHistoryDiff | null>;
  prepareReplaceCurrent(current: string): (() => void) | null;
  prepareAdoptStaged(stage: StagedHistoryDiff): (() => void) | null;
  adoptStaged(stage: StagedHistoryDiff): boolean;
  setMounted(mounted: boolean): HistoryDiffMode;
  computeDiff(): HistoryDiffMode;
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
  let mounted = false;
  let latestId = 0;
  let nextRequestGeneration = 0;
  let activeRequest: ActiveDiffRequest | undefined;

  let staged: PendingStagedHistoryDiff | undefined;

  const retireStaged = (): void => {
    const pending = staged;
    staged = undefined;
    pending?.resolve(null);
  };
  const retireRequest = (): void => {
    activeRequest = undefined;
    nextRequestGeneration += 1;
    latestId += 1;
  };
  const ensureWorker = (): DiffWorker | undefined => {
    if (worker !== undefined) return worker;
    try {
      worker = (options.createWorker ?? defaultDiffWorker)();
      return worker;
    } catch (error) {
      options.onError?.(error instanceof Error ? error.message : "Unable to calculate diff");
      return undefined;
    }
  };
  const requestDiff = (activeWorker: DiffWorker, previous: string, current: string): number => {
    const id = ++latestId;
    const generation = ++nextRequestGeneration;
    const request: ActiveDiffRequest = { worker: activeWorker, id, generation };
    activeRequest = request;
    activeWorker.onmessage = (event) => {
      if (
        worker !== activeWorker
        || activeRequest?.worker !== activeWorker
        || activeRequest.id !== id
        || activeRequest.generation !== generation
        || !isDiffResponse(event.data)
        || event.data.id !== id
      ) return;
      activeRequest = undefined;
      const pending = staged?.id === event.data.id ? staged : undefined;
      if (pending !== undefined) {
        staged = undefined;
        if (event.data.type === "result") pending.resolve({ id: pending.id, previous: pending.previous, current: pending.current, lines: event.data.lines });
        else pending.reject(new Error(event.data.message));
        return;
      }
      if (event.data.type === "result") options.onLines(event.data.lines);
      else options.onError?.(event.data.message);
    };
    activeWorker.onerror = () => {
      if (
        worker !== activeWorker
        || activeRequest?.worker !== activeWorker
        || activeRequest.id !== id
        || activeRequest.generation !== generation
      ) return;
      activeRequest = undefined;
      const pending = staged?.id === id ? staged : undefined;
      if (pending !== undefined) {
        staged = undefined;
        pending.reject(new Error("Unable to calculate diff"));
      } else options.onError?.("Unable to calculate diff");
    };
    activeWorker.postMessage({ type: "diff", id, previous, current });
    return id;
  };
  const startDiff = (): HistoryDiffMode => {
    if (selected === undefined) return "idle";
    const activeWorker = ensureWorker();
    if (activeWorker === undefined) return "failed";
    retireStaged();
    requestDiff(activeWorker, selected.previous, selected.current);
    return "computing";
  };
  const prepareReplaceCurrent = (current: string): (() => void) | null => {
    const selectedCurrent = selected;
    if (selectedCurrent === undefined || selectedCurrent.current === current) return null;
    const next = { ...selectedCurrent, current };
    return () => {
      selected = next;
    };
  };
  const prepareAdoptStaged = (stage: StagedHistoryDiff): (() => void) | null => {
    const current = selected;
    if (current === undefined || latestId !== stage.id || current.previous !== stage.previous) return null;
    const next = { ...current, current: stage.current };
    return () => {
      selected = next;
    };
  };

  return {
    selectRevision(revision, previous, current) {
      retireStaged();
      selected = { revision, previous, current };
      if (automaticDiffAllowed(previous, current)) {
        if (mounted) startDiff();
        return "automatic";
      }
      retireRequest();
      return "manual";
    },
    replaceCurrent(current) {
      if (selected === undefined) return "idle";
      if (selected.current === current) return "unchanged";
      retireStaged();
      selected = { ...selected, current };
      retireRequest();
      if (!automaticDiffAllowed(selected.previous, current)) return "manual";
      if (!mounted) return "idle";
      return startDiff();
    },
    stageCurrent(current) {
      if (selected === undefined || !mounted || !automaticDiffAllowed(selected.previous, current)) return Promise.resolve(null);
      const activeWorker = ensureWorker();
      if (activeWorker === undefined) return Promise.reject(new Error("Unable to calculate diff"));
      retireStaged();
      const previous = selected.previous;
      const id = latestId + 1;
      return new Promise<StagedHistoryDiff | null>((resolve, reject) => {
        staged = { id, previous, current, resolve, reject };
        requestDiff(activeWorker, previous, current);
      });
    },
    prepareReplaceCurrent,
    prepareAdoptStaged,
    adoptStaged(stage) {
      const adopt = prepareAdoptStaged(stage);
      if (adopt === null) return false;
      adopt();
      return true;
    },
    setMounted(nextMounted) {
      if (mounted === nextMounted) {
        if (selected === undefined) return "idle";
        if (!automaticDiffAllowed(selected.previous, selected.current)) return "manual";
        return mounted ? startDiff() : "idle";
      }
      mounted = nextMounted;
      if (!mounted) {
        retireStaged();
        retireRequest();
        worker?.terminate();
        worker = undefined;
        return "idle";
      }
      if (selected === undefined) return "idle";
      if (!automaticDiffAllowed(selected.previous, selected.current)) return "manual";
      return startDiff();
    },
    computeDiff: startDiff,
    clearSelection() {
      retireStaged();
      selected = undefined;
      retireRequest();
    },
    destroy() {
      retireStaged();
      selected = undefined;
      retireRequest();
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
  commitRetention(previous: BaselineCapture, next: BaselineCapture): {
    readonly retention: "all" | "snapshot-only" | "none";
    release(): void;
  };
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

  const prepareRetireRequests = (finalize: (current: HistoryControllerSnapshot) => HistoryControllerSnapshot): (() => void) => {
    const current = state;
    const listAbort = listRequest?.abort;
    const snapshotAbort = snapshotRequest?.abort;
    listRequest = undefined;
    snapshotRequest = undefined;
    state = { ...finalize(current), epoch: current.epoch + 1 };
    let released = false;
    return () => {
      if (released) return;
      released = true;
      listAbort?.abort();
      snapshotAbort?.abort();
    };
  };
  const retireRequests = (finalize: (current: HistoryControllerSnapshot) => HistoryControllerSnapshot): void => {
    prepareRetireRequests(finalize)();
  };

  const matches = (request: PendingRequest | undefined, token: number, capture: BaselineCapture): boolean => (
    !destroyed && request !== undefined && request.token === token && request.epoch === state.epoch && sameCapture(request.capture, capture)
  );

  const retiredRequest = (token: number): { token: number; signal: AbortSignal } => {
    const abort = new AbortController();
    abort.abort();
    return { token, signal: abort.signal };
  };
  const commitRetention = (previous: BaselineCapture, next: BaselineCapture): {
    readonly retention: "all" | "snapshot-only" | "none";
    release(): void;
  } => {
    if (destroyed) return { retention: "none", release() {} };

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

    return { retention, release: prepareRetireRequests(() => finalState) };
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
      retireRequests((current) => ({
        ...current,
        listState: settledListState(current),
        snapshotState: settledSnapshotState(current),
      }));
    },
    commitRetention,
    retainAfterApply(previous, next) {
      const committed = commitRetention(previous, next);
      committed.release();
      return committed.retention;
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
