import type { TerminalOriginSettleContext } from "./contracts";

export interface DerivedSurfaceCapture {
  localGeneration: number;
  currentExactSource: string;
  currentDisplayGeneration: number;
  hostGeneration: number;
  parentApplyGeneration: number;
  parentApplyToken: number;
  derivedRetryToken: number;
}

export interface StagedSurfacePorts {
  stagePreview(source: string, generation: number): Promise<unknown>;
  stageVisual(source: string, generation: number): Promise<unknown>;
  stageDiff(source: string, generation: number): Promise<unknown>;
  commit(staged: { preview: unknown; visual: unknown; diff: unknown }, generation: number): void;
  restoreOld(generation: number, source: string): Promise<boolean>;
  showOldGenerationFailure(generation: number, source: string): void;
  disposeAttemptResources(attempt: unknown): void;
}

export type SurfaceFallback = "preview" | "visual" | "diff" | null;

export interface StagedSurfaceSnapshot {
  capture: DerivedSurfaceCapture;
  source: string;
  status: "idle" | "staging" | "committed" | "fallback";
  fallback: SurfaceFallback;
}

export interface StagedSurfaceApplyOptions {
  ports: StagedSurfacePorts;
  capture: DerivedSurfaceCapture;
}

export interface StagedSurfaceApply {
  snapshot(): Readonly<StagedSurfaceSnapshot>;
  apply(source: string): Promise<boolean>;
  retry(source: string): Promise<boolean>;
  replaceCapture(capture: DerivedSurfaceCapture): void;
  invalidate(): void;
  remount(): void;
  settleTerminal(origin: TerminalOriginSettleContext, result: "displayed" | "display-failed" | "current-unchanged" | "current-kept-choice"): string;
}

export interface AutosyncApplyEntry {
  requestCurrent: boolean;
  acceptedBaselineCurrent: boolean;
  localGenerationCurrent: boolean;
  active: boolean;
  composing: boolean;
  autosaveTimer: boolean;
  autosaveInFlight: boolean;
  coalescedIntent: boolean;
  mutationOccupied: boolean;
  unresolvedMutation: boolean;
  localSourceWork: boolean;
}

export interface UseRemoteApplyEntry {
  candidateCurrent: boolean;
  acceptedBaselineCurrent: boolean;
  localGenerationCurrent: boolean;
  ordinary: boolean;
  draftMatchesAccepted: boolean;
  composing: boolean;
  autosaveTimer: boolean;
  autosaveInFlight: boolean;
  coalescedIntent: boolean;
  mutationOccupied: boolean;
  unresolvedMutation: boolean;
  conflictCausedByCandidate: boolean;
}

export interface ReloadApplyEntry {
  requestCurrent: boolean;
  acceptedBaselineCurrent: boolean;
  draftCurrent: boolean;
  localGenerationCurrent: boolean;
  mutationOccupied: boolean;
  terminal: boolean;
}

export interface TerminalLocalApplyEntry {
  terminalEpochCurrent: boolean;
  displayGenerationCurrent: boolean;
  selectedSourceCurrent: boolean;
}

export function autosyncApplyEntryAllowed(entry: AutosyncApplyEntry): boolean {
  return (
    entry.requestCurrent &&
    entry.acceptedBaselineCurrent &&
    entry.localGenerationCurrent &&
    entry.active &&
    !entry.composing &&
    !entry.autosaveTimer &&
    !entry.autosaveInFlight &&
    !entry.coalescedIntent &&
    !entry.mutationOccupied &&
    !entry.unresolvedMutation &&
    !entry.localSourceWork
  );
}

export function useRemoteApplyEntryAllowed(entry: UseRemoteApplyEntry): boolean {
  return (
    entry.candidateCurrent &&
    entry.acceptedBaselineCurrent &&
    entry.localGenerationCurrent &&
    entry.ordinary &&
    entry.draftMatchesAccepted &&
    !entry.composing &&
    !entry.autosaveTimer &&
    !entry.autosaveInFlight &&
    !entry.coalescedIntent &&
    !entry.mutationOccupied &&
    !entry.unresolvedMutation
  );
}

export function reloadApplyEntryAllowed(entry: ReloadApplyEntry): boolean {
  return (
    entry.requestCurrent &&
    entry.acceptedBaselineCurrent &&
    entry.draftCurrent &&
    entry.localGenerationCurrent &&
    !entry.mutationOccupied &&
    !entry.terminal
  );
}

export function terminalLocalApplyEntryAllowed(entry: TerminalLocalApplyEntry): boolean {
  return entry.terminalEpochCurrent && entry.displayGenerationCurrent && entry.selectedSourceCurrent;
}

function copyCapture(capture: DerivedSurfaceCapture): DerivedSurfaceCapture {
  return { ...capture };
}

function sameCapture(left: DerivedSurfaceCapture, right: DerivedSurfaceCapture): boolean {
  return (
    left.localGeneration === right.localGeneration &&
    left.currentExactSource === right.currentExactSource &&
    left.currentDisplayGeneration === right.currentDisplayGeneration &&
    left.hostGeneration === right.hostGeneration &&
    left.parentApplyGeneration === right.parentApplyGeneration &&
    left.parentApplyToken === right.parentApplyToken &&
    left.derivedRetryToken === right.derivedRetryToken
  );
}

function fallbackFor(error: unknown): Exclude<SurfaceFallback, null> {
  if (error instanceof SurfaceStageFailure) return error.surface;
  return "preview";
}

class SurfaceStageFailure extends Error {
  constructor(readonly surface: Exclude<SurfaceFallback, null>, readonly cause: unknown) {
    super(surface);
  }
}

async function stage<T>(surface: Exclude<SurfaceFallback, null>, promise: Promise<T>): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    throw new SurfaceStageFailure(surface, error);
  }
}

export function createStagedSurfaceApply(options: StagedSurfaceApplyOptions): StagedSurfaceApply {
  let current = copyCapture(options.capture);
  let currentSource = current.currentExactSource;
  let status: StagedSurfaceSnapshot["status"] = "idle";
  let fallback: SurfaceFallback = null;
  let terminalSettled = false;

  const snapshot = (): Readonly<StagedSurfaceSnapshot> => ({
    capture: copyCapture(current),
    source: currentSource,
    status,
    fallback,
  });

  const stale = (captured: DerivedSurfaceCapture): boolean => !sameCapture(captured, current);

  const run = async (source: string, captured: DerivedSurfaceCapture): Promise<boolean> => {
    status = "staging";
    fallback = null;
    const attempt: { capture: DerivedSurfaceCapture; source: string; staged?: { preview: unknown; visual: unknown; diff: unknown } } = {
      capture: captured,
      source,
    };
    try {
      const [preview, visual, diff] = await Promise.all([
        stage("preview", options.ports.stagePreview(source, captured.currentDisplayGeneration)),
        stage("visual", options.ports.stageVisual(source, captured.currentDisplayGeneration)),
        stage("diff", options.ports.stageDiff(source, captured.currentDisplayGeneration)),
      ]);
      attempt.staged = { preview, visual, diff };
      if (stale(captured)) {
        options.ports.disposeAttemptResources(attempt);
        return false;
      }
      options.ports.commit(attempt.staged, captured.currentDisplayGeneration);
      currentSource = source;
      current = {
        ...current,
        currentExactSource: source,
        currentDisplayGeneration: captured.currentDisplayGeneration + 1,
        parentApplyGeneration: captured.parentApplyGeneration + 1,
      };
      status = "committed";
      return true;
    } catch (error) {
      options.ports.disposeAttemptResources(attempt);
      if (stale(captured)) return false;
      status = "fallback";
      fallback = fallbackFor(error);
      return false;
    }
  };

  return {
    snapshot,
    apply(source) {
      return run(source, copyCapture(current));
    },
    retry(source) {
      current = { ...current, derivedRetryToken: current.derivedRetryToken + 1 };
      return run(source, copyCapture(current));
    },
    replaceCapture(capture) {
      current = copyCapture(capture);
      currentSource = capture.currentExactSource;
      if (status === "staging") status = "idle";
    },
    invalidate() {
      current = {
        ...current,
        derivedRetryToken: current.derivedRetryToken + 1,
        parentApplyGeneration: current.parentApplyGeneration + 1,
      };
      if (status === "staging") status = "idle";
    },
    remount() {
      current = {
        ...current,
        hostGeneration: current.hostGeneration + 1,
        derivedRetryToken: current.derivedRetryToken + 1,
      };
      if (status === "staging") status = "idle";
    },
    settleTerminal(origin, result) {
      if (terminalSettled) return "";
      terminalSettled = true;
      if (origin.actionKey === "content-reconcile") return "content-reconcile-terminal-current-kept";
      switch (result) {
        case "displayed":
          return "reload-terminal-response-displayed";
        case "display-failed":
          return "reload-terminal-response-display-failed";
        case "current-kept-choice":
          return "reload-terminal-current-kept-choice";
        case "current-unchanged":
          return "reload-terminal-current-unchanged";
      }
    },
  };
}
