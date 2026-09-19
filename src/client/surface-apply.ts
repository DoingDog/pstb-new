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
  restoreOld(generation: number, source: string, parentToken: number): Promise<boolean>;
  showOldGenerationFailure(generation: number, source: string, parentToken: number): void;
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
  activeUntil: number;
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

export type TerminalLocalToken = symbol;
export interface TerminalLocalApplyReceipt {
  terminalLocalToken: TerminalLocalToken;
  applied: boolean;
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
  applyTerminalLocal(source: string, entry: TerminalLocalApplyEntry): Promise<TerminalLocalApplyReceipt | null>;
  retry(source: string): Promise<boolean>;
  retryPreview(source: string): Promise<boolean>;
  retryVisual(source: string): Promise<boolean>;
  retryDiff(source: string): Promise<boolean>;
  replaceCapture(capture: DerivedSurfaceCapture): void;
  invalidate(): void;
  remount(): void;
  settleTerminal(origin: TerminalOriginSettleContext, result: "displayed" | "display-failed" | "current-unchanged" | "current-kept-choice"): TerminalOutcomeKey | null;
  settleUseConsumedResponse(terminalLocalToken: TerminalLocalToken, result: "displayed" | "display-failed"): TerminalOutcomeKey | null;
}

type Staged = { preview: unknown; visual: unknown; diff: unknown };
type Surface = Exclude<SurfaceFallback, null>;
type Attempt = {
  base: DerivedSurfaceCapture;
  capture: DerivedSurfaceCapture;
  source: string;
  generation: number;
  staged: Partial<Staged>;
  failure: SurfaceFallback;
  retrySurface?: Surface;
  terminalLocal: boolean;
  retired: boolean;
  owned: Set<Surface>;
  disposed: Set<Surface>;
  touchedHost: boolean;
  oldGeneration: number;
  oldSource: string;
  oldStatus: StagedSurfaceSnapshot["status"];
  oldFallback: SurfaceFallback;
  activeUntil?: number;
};

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
  let terminalLocalAttempt: { token: TerminalLocalToken; settled: boolean } | null = null;
  const retryTokens: Record<Surface, number> = { preview: current.derivedRetryToken, visual: current.derivedRetryToken, diff: current.derivedRetryToken };
  let nextDisplayGeneration = current.currentDisplayGeneration;
  let nextParentApplyGeneration = current.parentApplyGeneration;
  let nextParentApplyToken = current.parentApplyToken;
  const now = options.now ?? Date.now;

  const snapshot = (): Readonly<StagedSurfaceSnapshot> => ({ capture: copyCapture(current), source: currentSource, status, fallback });
  const stale = (attempt: Attempt): boolean => !sameCapture(attempt.base, current);
  const syncRetryTokens = (token: number): void => {
    for (const surface of ["preview", "visual", "diff"] as const) retryTokens[surface] = Math.max(retryTokens[surface], token);
  };
  const syncCaptureCounters = (): void => {
    nextDisplayGeneration = Math.max(nextDisplayGeneration, current.currentDisplayGeneration);
    nextParentApplyGeneration = Math.max(nextParentApplyGeneration, current.parentApplyGeneration);
    nextParentApplyToken = Math.max(nextParentApplyToken, current.parentApplyToken);
    syncRetryTokens(current.derivedRetryToken);
  };
  const disposeResource = (attempt: Attempt, surface: Surface, value: unknown): void => {
    if (attempt.disposed.has(surface)) return;
    attempt.disposed.add(surface);
    try {
      options.ports.disposeAttemptResources({ ...attempt, staged: { [surface]: value } });
    } catch {}
  };
  const disposeOwned = (attempt: Attempt): void => {
    for (const surface of attempt.owned) disposeResource(attempt, surface, attempt.staged[surface]);
  };
  const retire = (attempt: Attempt): void => {
    if (attempt.retired) return;
    attempt.retired = true;
    disposeOwned(attempt);
  };
  const restorePresentation = (attempt: Attempt): void => {
    if (activeAttempt !== attempt || stale(attempt)) return;
    status = attempt.oldStatus;
    fallback = attempt.oldFallback;
    activeAttempt = undefined;
  };
  const record = (attempt: Attempt, surface: Surface, value: unknown): unknown => {
    attempt.owned.add(surface);
    attempt.staged[surface] = value;
    if (attempt.retired) disposeResource(attempt, surface, value);
    return value;
  };

  const abandonActive = (): void => {
    if (activeAttempt === undefined) return;
    const previous = activeAttempt;
    retire(previous);
    restorePresentation(previous);
  };
  const allocate = (source: string, activeUntil?: number, terminalLocal = false): Attempt => {
    abandonActive();
    const base = copyCapture(current);
    const retryToken = Math.max(current.derivedRetryToken, retryTokens.preview, retryTokens.visual, retryTokens.diff);
    syncRetryTokens(retryToken);
    const generation = ++nextDisplayGeneration;
    const captured = {
      ...base,
      currentExactSource: source,
      currentDisplayGeneration: generation,
      parentApplyGeneration: ++nextParentApplyGeneration,
      parentApplyToken: ++nextParentApplyToken,
      derivedRetryToken: retryToken,
    };
    const attempt: Attempt = {
      base,
      capture: captured,
      source,
      generation,
      staged: {},
      failure: null,
      terminalLocal,
      retired: false,
      owned: new Set(),
      disposed: new Set(),
      touchedHost: false,
      oldGeneration: current.currentDisplayGeneration,
      oldSource: currentSource,
      oldStatus: status,
      oldFallback: fallback,
      ...(activeUntil === undefined ? {} : { activeUntil }),
    };
    activeAttempt = attempt;
    if (status !== "fallback") {
      status = "staging";
      fallback = null;
    }
    return attempt;
  };
  const allocateRetry = (source: string, surface: Surface): Attempt => {
    abandonActive();
    const base = copyCapture(current);
    const retryToken = Math.max(current.derivedRetryToken, retryTokens.preview, retryTokens.visual, retryTokens.diff) + 1;
    syncRetryTokens(retryToken);
    const captured = { ...base, derivedRetryToken: retryToken };
    const attempt: Attempt = {
      base,
      capture: captured,
      source,
      generation: current.currentDisplayGeneration,
      staged: {},
      failure: null,
      retrySurface: surface,
      terminalLocal: false,
      retired: false,
      owned: new Set(),
      disposed: new Set(),
      touchedHost: false,
      oldGeneration: current.currentDisplayGeneration,
      oldSource: currentSource,
      oldStatus: status,
      oldFallback: fallback,
    };
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

  const attemptIsCurrent = (attempt: Attempt): boolean => activeAttempt === attempt && !attempt.retired && !stale(attempt);
  const restore = async (attempt: Attempt): Promise<void> => {
    if (!attempt.touchedHost) return;
    let restored = false;
    try {
      restored = await options.ports.restoreOld(attempt.oldGeneration, attempt.oldSource, attempt.capture.parentApplyToken);
    } catch {}
    if (!restored && attemptIsCurrent(attempt)) {
      try {
        options.ports.showOldGenerationFailure(attempt.oldGeneration, attempt.oldSource, attempt.capture.parentApplyToken);
      } catch {}
    }
  };

  const publish = async (attempt: Attempt): Promise<boolean> => {
    if (!attemptIsCurrent(attempt) || (attempt.activeUntil !== undefined && now() >= attempt.activeUntil)) {
      retire(attempt);
      restorePresentation(attempt);
      return false;
    }
    const staged = attempt.staged as Staged;
    try {
      attempt.touchedHost = true;
      options.ports.commit(staged, attempt.generation);
      mounted = staged;
      current = copyCapture(attempt.capture);
      currentSource = attempt.source;
      syncCaptureCounters();
      if (attempt.retrySurface === undefined) {
        status = attempt.failure === null ? "committed" : "fallback";
        fallback = attempt.failure;
      } else {
        fallback = fallback === attempt.retrySurface ? null : fallback;
        status = fallback === null ? "committed" : "fallback";
      }
      activeAttempt = undefined;
      return true;
    } catch {
      disposeOwned(attempt);
      await restore(attempt);
      retire(attempt);
      restorePresentation(attempt);
      return false;
    }
  };

  const runAll = async (source: string, activeUntil?: number, terminalLocal = false): Promise<boolean> => {
    const attempt = allocate(source, activeUntil, terminalLocal);
    await Promise.all([stageOne(attempt, "preview"), stageOne(attempt, "visual"), stageOne(attempt, "diff")]);
    return publish(attempt);
  };
  const runTerminalLocal = async (source: string): Promise<TerminalLocalApplyReceipt> => {
    const terminalLocalToken = Symbol("terminal-local");
    terminalLocalAttempt = { token: terminalLocalToken, settled: false };
    return { terminalLocalToken, applied: await runAll(source, undefined, true) };
  };

  const runRetry = async (source: string, surface: Surface): Promise<boolean> => {
    if (source !== current.currentExactSource) return false;
    const attempt = allocateRetry(source, surface);
    const stagePort = surface === "preview" ? options.ports.stagePreview : surface === "visual" ? options.ports.stageVisual : options.ports.stageDiff;
    let value: unknown;
    try {
      value = await stagePort(attempt.source, attempt.generation);
    } catch {
      disposeResource(attempt, surface, undefined);
      retire(attempt);
      restorePresentation(attempt);
      return false;
    }
    record(attempt, surface, value);
    if (!attemptIsCurrent(attempt)) {
      retire(attempt);
      restorePresentation(attempt);
      return false;
    }
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
      return guarded(autosyncApplyEntryAllowed(entry) && entry.activeUntil > now(), source, entry.activeUntil);
    },
    applyUseRemote(source, entry) {
      return guarded(useRemoteApplyEntryAllowed(entry) && entry.activeUntil > now(), source, entry.activeUntil);
    },
    applyReload(source, entry) {
      return guarded(reloadApplyEntryAllowed(entry), source);
    },
    applyTerminalLocal(source, entry) {
      return terminalLocalApplyEntryAllowed(entry) ? runTerminalLocal(source) : Promise.resolve(null);
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
      abandonActive();
      current = copyCapture(capture);
      currentSource = capture.currentExactSource;
      syncCaptureCounters();
    },
    invalidate() {
      abandonActive();
      current = { ...current, parentApplyGeneration: current.parentApplyGeneration + 1, parentApplyToken: current.parentApplyToken + 1, derivedRetryToken: current.derivedRetryToken + 1 };
      syncCaptureCounters();
    },
    remount() {
      abandonActive();
      current = { ...current, hostGeneration: current.hostGeneration + 1, parentApplyToken: current.parentApplyToken + 1, derivedRetryToken: current.derivedRetryToken + 1 };
      syncCaptureCounters();
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
    settleUseConsumedResponse(terminalLocalToken, result) {
      if (terminalLocalAttempt === null || terminalLocalAttempt.token !== terminalLocalToken || terminalLocalAttempt.settled) return null;
      terminalLocalAttempt.settled = true;
      return result === "displayed" ? "use-consumed-response-displayed" : "use-consumed-response-display-failed";
    },
  };
}
