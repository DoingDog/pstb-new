import type { TerminalOriginSettleContext, TerminalOutcomeKey } from "./contracts";

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
  now?(): number;
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
  active: boolean;
  activeDeadlineCurrent: boolean;
  activeUntil: number;
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
  return entry.requestCurrent && entry.acceptedBaselineCurrent && entry.localGenerationCurrent && entry.active
    && !entry.composing && !entry.autosaveTimer && !entry.autosaveInFlight && !entry.coalescedIntent
    && !entry.mutationOccupied && !entry.unresolvedMutation && !entry.localSourceWork;
}
export function useRemoteApplyEntryAllowed(entry: UseRemoteApplyEntry): boolean {
  return entry.candidateCurrent && entry.acceptedBaselineCurrent && entry.localGenerationCurrent && entry.ordinary
    && entry.active && entry.activeDeadlineCurrent && entry.draftMatchesAccepted && !entry.composing
    && !entry.autosaveTimer && !entry.autosaveInFlight && !entry.coalescedIntent && !entry.mutationOccupied
    && !entry.unresolvedMutation;
}
export function reloadApplyEntryAllowed(entry: ReloadApplyEntry): boolean {
  return entry.requestCurrent && entry.acceptedBaselineCurrent && entry.draftCurrent && entry.localGenerationCurrent && !entry.mutationOccupied && !entry.terminal;
}
export function terminalLocalApplyEntryAllowed(entry: TerminalLocalApplyEntry): boolean {
  return entry.terminalEpochCurrent && entry.displayGenerationCurrent && entry.selectedSourceCurrent;
}

export interface StagedSurfaceApply {
  snapshot(): Readonly<StagedSurfaceSnapshot>;
  apply(source: string): Promise<boolean>;
  applyAutosync(source: string, entry: AutosyncApplyEntry): Promise<boolean>;
  applyUseRemote(source: string, entry: UseRemoteApplyEntry): Promise<boolean>;
  applyReload(source: string, entry: ReloadApplyEntry): Promise<boolean>;
  applyTerminalLocal(source: string, entry: TerminalLocalApplyEntry): Promise<boolean>;
  retry(source: string): Promise<boolean>;
  retryPreview(source: string): Promise<boolean>;
  retryVisual(source: string): Promise<boolean>;
  retryDiff(source: string): Promise<boolean>;
  replaceCapture(capture: DerivedSurfaceCapture): void;
  invalidate(): void;
  remount(): void;
  settleTerminal(origin: TerminalOriginSettleContext, result: "displayed" | "display-failed" | "current-unchanged" | "current-kept-choice"): TerminalOutcomeKey | null;
  settleUseConsumedResponse(result: "displayed" | "display-failed"): TerminalOutcomeKey | null;
}

type Staged = { preview: unknown; visual: unknown; diff: unknown };
type Surface = Exclude<SurfaceFallback, null>;
type Attempt = { capture: DerivedSurfaceCapture; source: string; generation: number; staged: Partial<Staged>; failure: SurfaceFallback; retired: boolean; touchedHost: boolean; oldGeneration: number; oldSource: string; activeUntil?: number };

function copyCapture(capture: DerivedSurfaceCapture): DerivedSurfaceCapture {
  return { ...capture };
}
function sameCapture(left: DerivedSurfaceCapture, right: DerivedSurfaceCapture): boolean {
  return left.localGeneration === right.localGeneration
    && left.currentExactSource === right.currentExactSource
    && left.currentDisplayGeneration === right.currentDisplayGeneration
    && left.hostGeneration === right.hostGeneration
    && left.parentApplyGeneration === right.parentApplyGeneration
    && left.parentApplyToken === right.parentApplyToken
    && left.derivedRetryToken === right.derivedRetryToken;
}
function fallbackResource(surface: Surface, source: string, generation: number): unknown {
  return { kind: "fallback", surface, source, generation };
}

export function createStagedSurfaceApply(options: StagedSurfaceApplyOptions): StagedSurfaceApply {
  let current = copyCapture(options.capture);
  let currentSource = current.currentExactSource;
  let status: StagedSurfaceSnapshot["status"] = "idle";
  let fallback: SurfaceFallback = null;
  let mounted: Staged | undefined;
  let activeAttempt: Attempt | undefined;
  let terminalSettled = false;
  let useConsumedResponseSettled = false;
  const retryTokens: Record<Surface, number> = { preview: current.derivedRetryToken, visual: current.derivedRetryToken, diff: current.derivedRetryToken };
  const now = options.now ?? Date.now;

  const snapshot = (): Readonly<StagedSurfaceSnapshot> => ({ capture: copyCapture(current), source: currentSource, status, fallback });
  const stale = (captured: DerivedSurfaceCapture): boolean => !sameCapture(captured, current);
  const safeDispose = (attempt: unknown): void => {
    try {
      options.ports.disposeAttemptResources(attempt);
    } catch {}
  };
  const retire = (attempt: Attempt): void => {
    if (attempt.retired) return;
    attempt.retired = true;
    safeDispose(attempt);
  };
  const record = (attempt: Attempt, surface: Surface, value: unknown): unknown => {
    attempt.staged[surface] = value;
    if (attempt.retired) safeDispose({ capture: attempt.capture, source: attempt.source, staged: { [surface]: value } });
    return value;
  };

  const allocate = (source: string, retrySurface?: Surface, activeUntil?: number): Attempt => {
    if (activeAttempt !== undefined) retire(activeAttempt);
    const generation = current.currentDisplayGeneration + 1;
    const retryToken = retrySurface === undefined ? current.derivedRetryToken : ++retryTokens[retrySurface];
    const captured = {
      ...current,
      currentExactSource: source,
      currentDisplayGeneration: generation,
      parentApplyGeneration: current.parentApplyGeneration + 1,
      parentApplyToken: current.parentApplyToken + 1,
      derivedRetryToken: retryToken,
    };
    const attempt: Attempt = {
      capture: captured,
      source,
      generation,
      staged: {},
      failure: null,
      retired: false,
      touchedHost: false,
      oldGeneration: current.currentDisplayGeneration,
      oldSource: currentSource,
      ...(activeUntil === undefined ? {} : { activeUntil }),
    };
    current = captured;
    activeAttempt = attempt;
    if (status !== "fallback") {
      status = "staging";
      fallback = null;
    }
    return attempt;
  };

  const stageOne = async (attempt: Attempt, surface: Surface): Promise<unknown> => {
    const stagePort = surface === "preview" ? options.ports.stagePreview : surface === "visual" ? options.ports.stageVisual : options.ports.stageDiff;
    try {
      return record(attempt, surface, await stagePort(attempt.source, attempt.generation));
    } catch {
      attempt.failure ??= surface;
      return record(attempt, surface, fallbackResource(surface, attempt.source, attempt.generation));
    }
  };

  const restore = async (attempt: Attempt): Promise<void> => {
    if (!attempt.touchedHost) return;
    let restored = false;
    try {
      restored = await options.ports.restoreOld(attempt.oldGeneration, attempt.oldSource);
    } catch {}
    if (!restored) {
      try {
        options.ports.showOldGenerationFailure(attempt.oldGeneration, attempt.oldSource);
      } catch {}
    }
  };

  const publish = async (attempt: Attempt): Promise<boolean> => {
    if (attempt.retired || stale(attempt.capture) || (attempt.activeUntil !== undefined && now() >= attempt.activeUntil)) {
      retire(attempt);
      if (activeAttempt === attempt) activeAttempt = undefined;
      return false;
    }
    const staged = attempt.staged as Staged;
    try {
      attempt.touchedHost = true;
      options.ports.commit(staged, attempt.generation);
      mounted = staged;
      currentSource = attempt.source;
      status = attempt.failure === null ? "committed" : "fallback";
      fallback = attempt.failure;
      activeAttempt = undefined;
      return true;
    } catch {
      safeDispose(attempt);
      await restore(attempt);
      if (!stale(attempt.capture)) {
        status = "fallback";
        fallback = attempt.failure ?? "preview";
      }
      if (activeAttempt === attempt) activeAttempt = undefined;
      return false;
    }
  };

  const runAll = async (source: string, activeUntil?: number): Promise<boolean> => {
    const attempt = allocate(source, undefined, activeUntil);
    await Promise.all([stageOne(attempt, "preview"), stageOne(attempt, "visual"), stageOne(attempt, "diff")]);
    return publish(attempt);
  };

  const runRetry = async (source: string, surface: Surface): Promise<boolean> => {
    if (source !== current.currentExactSource) return false;
    const attempt = allocate(source, surface);
    const value = await stageOne(attempt, surface);
    const previous = mounted ?? {
      preview: fallbackResource("preview", source, attempt.generation),
      visual: fallbackResource("visual", source, attempt.generation),
      diff: fallbackResource("diff", source, attempt.generation),
    };
    attempt.staged = { ...previous, [surface]: value };
    return publish(attempt);
  };

  const guarded = (allowed: boolean, source: string, activeUntil?: number): Promise<boolean> => allowed ? runAll(source, activeUntil) : Promise.resolve(false);

  return {
    snapshot,
    apply: runAll,
    applyAutosync(source, entry) {
      return guarded(autosyncApplyEntryAllowed(entry), source);
    },
    applyUseRemote(source, entry) {
      return guarded(useRemoteApplyEntryAllowed(entry) && entry.activeUntil > now(), source, entry.activeUntil);
    },
    applyReload(source, entry) {
      return guarded(reloadApplyEntryAllowed(entry), source);
    },
    applyTerminalLocal(source, entry) {
      return guarded(terminalLocalApplyEntryAllowed(entry), source);
    },
    retry(source) {
      return runRetry(source, fallback ?? "preview");
    },
    retryPreview(source) {
      return runRetry(source, "preview");
    },
    retryVisual(source) {
      return runRetry(source, "visual");
    },
    retryDiff(source) {
      return runRetry(source, "diff");
    },
    replaceCapture(capture) {
      if (activeAttempt !== undefined) retire(activeAttempt);
      current = copyCapture(capture);
      currentSource = capture.currentExactSource;
      activeAttempt = undefined;
      if (status === "staging") status = "idle";
    },
    invalidate() {
      if (activeAttempt !== undefined) retire(activeAttempt);
      current = { ...current, parentApplyGeneration: current.parentApplyGeneration + 1, parentApplyToken: current.parentApplyToken + 1, derivedRetryToken: current.derivedRetryToken + 1 };
      activeAttempt = undefined;
      if (status === "staging") status = "idle";
    },
    remount() {
      if (activeAttempt !== undefined) retire(activeAttempt);
      current = { ...current, hostGeneration: current.hostGeneration + 1, parentApplyToken: current.parentApplyToken + 1, derivedRetryToken: current.derivedRetryToken + 1 };
      activeAttempt = undefined;
      if (status === "staging") status = "idle";
    },
    settleTerminal(origin, result) {
      if (terminalSettled) return null;
      terminalSettled = true;
      if (origin.actionKey === "content-reconcile") return "content-reconcile-terminal-current-kept";
      switch (result) {
        case "displayed": return "reload-terminal-response-displayed";
        case "display-failed": return "reload-terminal-response-display-failed";
        case "current-unchanged": return "reload-terminal-current-unchanged";
        case "current-kept-choice": return "reload-terminal-current-kept-choice";
      }
    },
    settleUseConsumedResponse(result) {
      if (useConsumedResponseSettled) return null;
      useConsumedResponseSettled = true;
      return result === "displayed" ? "use-consumed-response-displayed" : "use-consumed-response-display-failed";
    },
  };
}
