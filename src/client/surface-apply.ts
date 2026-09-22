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

export type DerivedSurface = "preview" | "visual" | "diff";
export type SurfaceFallback = DerivedSurface | null;
export type StagedSurfaces = { preview: unknown; visual: unknown; diff: unknown };

export interface SurfaceCommitContext {
  readonly source: string;
  readonly target: Readonly<DerivedSurfaceCapture>;
  readonly staged: Readonly<StagedSurfaces>;
}

export type SurfaceReleaseWork = () => void;

export interface PreparedSurfaceCommit {
  commit(): SurfaceReleaseWork | void;
  fail(): SurfaceReleaseWork | void;
}

export interface GuardedSurfaceOperation {
  enter(): boolean;
  prepare(context: SurfaceCommitContext): PreparedSurfaceCommit | null;
  reject(): void;
}

export interface SurfaceRollback {
  readonly failedGeneration: number;
  readonly oldGeneration: number;
  readonly oldSource: string;
  readonly parentApplyToken: number;
  readonly hostGeneration: number;
}

export interface StagedSurfacePorts {
  stagePreview(source: string, generation: number): Promise<unknown>;
  stageVisual(source: string, generation: number): Promise<unknown>;
  stageDiff(source: string, generation: number): Promise<unknown>;
  mounted(): readonly DerivedSurface[];
  prepareCommit?(context: SurfaceCommitContext): () => void;
  commit(staged: Readonly<StagedSurfaces>, generation: number): SurfaceReleaseWork | void;
  restoreOld(rollback: SurfaceRollback): Promise<boolean>;
  showOldGenerationFailure(rollback: SurfaceRollback): SurfaceReleaseWork | void;
  disposeAttemptResources(attempt: unknown): void;
}

export interface StagedSurfaceSnapshot {
  capture: DerivedSurfaceCapture;
  source: string;
  status: "idle" | "staging" | "committed" | "fallback";
  fallback: SurfaceFallback;
  complete: boolean;
}

export interface StagedSurfaceApplyOptions {
  ports: StagedSurfacePorts;
  capture: DerivedSurfaceCapture;
}

export interface TerminalLocalApplyEntry {
  terminalEpochCurrent: boolean;
  displayGenerationCurrent: boolean;
  selectedSourceCurrent: boolean;
  commitCurrent?(): boolean;
}

export type TerminalLocalToken = symbol;
export interface TerminalLocalApplyReceipt {
  terminalLocalToken: TerminalLocalToken;
  outcome: "complete" | "fallback" | "failed";
  fallback: SurfaceFallback;
}

export interface StagedSurfaceApply {
  snapshot(): Readonly<StagedSurfaceSnapshot>;
  apply(source: string, operation: GuardedSurfaceOperation): Promise<boolean>;
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

type Attempt = {
  base: DerivedSurfaceCapture;
  target: DerivedSurfaceCapture;
  source: string;
  generation: number;
  staged: StagedSurfaces;
  failure: SurfaceFallback;
  retrySurface?: DerivedSurface;
  retired: boolean;
  cancelled: Promise<void>;
  cancel(): void;
  owned: Set<DerivedSurface>;
  disposed: Set<DerivedSurface>;
  touchedHost: boolean;
  oldStatus: StagedSurfaceSnapshot["status"];
  oldFallback: SurfaceFallback;
};

type QueueEntry = {
  run(): Promise<boolean>;
  resolve(value: boolean): void;
  reject(reason: unknown): void;
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

function fallbackResource(surface: DerivedSurface, source: string, generation: number): unknown {
  return { kind: "fallback", surface, source, generation };
}

export function createStagedSurfaceApply(options: StagedSurfaceApplyOptions): StagedSurfaceApply {
  let current = copyCapture(options.capture);
  let currentSource = current.currentExactSource;
  let status: StagedSurfaceSnapshot["status"] = "idle";
  let fallback: SurfaceFallback = null;
  let mounted: StagedSurfaces | undefined;
  let activeAttempt: Attempt | undefined;
  let blocked = false;
  let draining = false;
  let poisoned: unknown = null;
  const queue: QueueEntry[] = [];
  const retryTokens: Record<DerivedSurface, number> = {
    preview: current.derivedRetryToken,
    visual: current.derivedRetryToken,
    diff: current.derivedRetryToken,
  };
  let terminalSettled = false;
  let terminalLocalAttempt: { token: TerminalLocalToken; settled: boolean } | null = null;

  const snapshot = (): Readonly<StagedSurfaceSnapshot> => ({
    capture: copyCapture(current),
    source: currentSource,
    status,
    fallback,
    complete: status === "committed",
  });
  const stale = (attempt: Attempt): boolean => !sameCapture(attempt.base, current);
  const syncCounters = (): void => {
    for (const surface of ["preview", "visual", "diff"] as const) {
      retryTokens[surface] = Math.max(retryTokens[surface], current.derivedRetryToken);
    }
  };
  const dispose = (attempt: Attempt, surface: DerivedSurface, value: unknown): void => {
    if (attempt.disposed.has(surface)) return;
    attempt.disposed.add(surface);
    try {
      options.ports.disposeAttemptResources({ ...attempt, staged: { [surface]: value } });
    } catch {}
  };
  const retire = (attempt: Attempt): void => {
    if (attempt.retired) return;
    attempt.retired = true;
    attempt.cancel();
    for (const surface of attempt.owned) dispose(attempt, surface, attempt.staged[surface]);
  };

  const restorePresentation = (attempt: Attempt): void => {
    if (activeAttempt !== attempt) return;
    status = attempt.oldStatus;
    fallback = attempt.oldFallback;
    activeAttempt = undefined;
  };
  const poison = (error: unknown): void => {
    if (poisoned !== null) return;
    poisoned = error;
    while (queue.length !== 0) queue.shift()!.reject(error);
  };
  const release = (work: SurfaceReleaseWork | void): void => {
    try {
      work?.();
    } catch {}
  };
  const drain = async (): Promise<void> => {
    if (draining || blocked || poisoned !== null) return;
    draining = true;
    try {
      while (!blocked && poisoned === null && queue.length !== 0) {
        const entry = queue.shift()!;
        try {
          entry.resolve(await entry.run());
        } catch (error) {
          entry.reject(error);
        }
      }
    } finally {
      draining = false;
      if (!blocked && poisoned === null && queue.length !== 0) void drain();
    }
  };
  const enqueue = (run: () => Promise<boolean>): Promise<boolean> => {
    if (poisoned !== null) return Promise.reject(poisoned);
    const promise = new Promise<boolean>((resolve, reject) => {
      queue.push({ run, resolve, reject });
    });
    void drain();
    return promise;
  };
  const enqueueVoid = (run: () => void): void => {
    if (poisoned !== null) return;
    void enqueue(async () => {
      run();
      return false;
    }).catch(() => undefined);
  };
  const finishCritical = (attempt: Attempt): void => {
    if (activeAttempt === attempt) activeAttempt = undefined;
    blocked = false;
    void drain();
  };

  const allocate = (source: string, retrySurface?: DerivedSurface): Attempt => {
    const base = copyCapture(current);
    const retryToken = retrySurface === undefined
      ? Math.max(current.derivedRetryToken, retryTokens.preview, retryTokens.visual, retryTokens.diff)
      : Math.max(current.derivedRetryToken, retryTokens.preview, retryTokens.visual, retryTokens.diff) + 1;
    if (retrySurface !== undefined) retryTokens[retrySurface] = retryToken;
    const generation = retrySurface === undefined ? current.currentDisplayGeneration + 1 : current.currentDisplayGeneration;
    const target = retrySurface === undefined
      ? {
        ...base,
        currentExactSource: source,
        currentDisplayGeneration: generation,
        parentApplyGeneration: current.parentApplyGeneration + 1,
        parentApplyToken: current.parentApplyToken + 1,
        derivedRetryToken: retryToken,
      }
      : { ...base, derivedRetryToken: retryToken };
    let cancel!: () => void;
    const cancelled = new Promise<void>((resolve) => { cancel = resolve; });
    const attempt: Attempt = {
      base,
      target,
      source,
      generation,
      staged: { preview: undefined, visual: undefined, diff: undefined },
      failure: null,
      ...(retrySurface === undefined ? {} : { retrySurface }),
      retired: false,
      cancelled,
      cancel,
      owned: new Set(),
      disposed: new Set(),
      touchedHost: false,
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

  const stagePort = (surface: DerivedSurface) => surface === "preview"
    ? options.ports.stagePreview
    : surface === "visual" ? options.ports.stageVisual : options.ports.stageDiff;

  const stageOne = async (attempt: Attempt, surface: DerivedSurface): Promise<void> => {
    let pending: Promise<unknown>;
    try {
      pending = Promise.resolve(stagePort(surface)(attempt.source, attempt.generation));
    } catch (error) {
      pending = Promise.reject(error);
    }
    const result = await Promise.race([
      pending.then((value) => ({ kind: "value" as const, value }), () => ({ kind: "failure" as const })),
      attempt.cancelled.then(() => ({ kind: "cancelled" as const })),
    ]);
    if (result.kind === "cancelled") {
      void pending.then((value) => dispose(attempt, surface, value), () => undefined);
      return;
    }
    const value = result.kind === "failure"
      ? fallbackResource(surface, attempt.source, attempt.generation)
      : result.value;
    if (result.kind === "failure") attempt.failure ??= surface;
    attempt.staged[surface] = value;
    attempt.owned.add(surface);
    if (attempt.retired) dispose(attempt, surface, value);
  };
  const stageAll = async (attempt: Attempt): Promise<void> => {
    await Promise.all(options.ports.mounted().map((surface) => stageOne(attempt, surface)));
  };
  const rollback = (attempt: Attempt): SurfaceRollback => ({
    failedGeneration: attempt.generation,
    oldGeneration: attempt.base.currentDisplayGeneration,
    oldSource: attempt.base.currentExactSource,
    parentApplyToken: attempt.target.parentApplyToken,
    hostGeneration: attempt.base.hostGeneration,
  });
  const restore = async (attempt: Attempt): Promise<{ restored: boolean; release: SurfaceReleaseWork | void }> => {
    if (!attempt.touchedHost) return { restored: true, release: undefined };
    const rollbackState = rollback(attempt);
    try {
      if (await options.ports.restoreOld(rollbackState)) return { restored: true, release: undefined };
    } catch {}
    try {
      return { restored: false, release: options.ports.showOldGenerationFailure(rollbackState) };
    } catch {
      return { restored: false, release: undefined };
    }
  };

  const reject = (operation: GuardedSurfaceOperation): void => {
    try {
      operation.reject();
    } catch {}
  };
  const execute = async (source: string, operation: GuardedSurfaceOperation, retrySurface?: DerivedSurface): Promise<boolean> => {
    if (poisoned !== null) throw poisoned;
    let entered = false;
    try {
      entered = operation.enter();
    } catch (error) {
      poison(error);
      throw error;
    }
    if (!entered) {
      reject(operation);
      return false;
    }

    const attempt = allocate(source, retrySurface);
    if (retrySurface === undefined) {
      await stageAll(attempt);
    } else {
      attempt.staged = {
        ...(mounted ?? {
          preview: fallbackResource("preview", source, attempt.generation),
          visual: fallbackResource("visual", source, attempt.generation),
          diff: fallbackResource("diff", source, attempt.generation),
        }),
      };
      await stageOne(attempt, retrySurface);
      if (attempt.failure !== null) {
        retire(attempt);
        restorePresentation(attempt);
        reject(operation);
        return false;
      }
    }
    if (attempt.retired || activeAttempt !== attempt || stale(attempt)) {
      retire(attempt);
      restorePresentation(attempt);
      reject(operation);
      return false;
    }

    blocked = true;
    try {
      const context: SurfaceCommitContext = { source, target: attempt.target, staged: attempt.staged };
      let prepared: PreparedSurfaceCommit | null;
      try {
        prepared = operation.prepare(context);
      } catch (error) {
        poison(error);
        throw error;
      }
      if (prepared === null) {
        retire(attempt);
        restorePresentation(attempt);
        reject(operation);
        return false;
      }

      let preparePort: () => void;
      try {
        preparePort = options.ports.prepareCommit?.(context) ?? (() => {});
      } catch (error) {
        poison(error);
        throw error;
      }

      let resourceRelease: SurfaceReleaseWork | void;
      try {
        attempt.touchedHost = true;
        resourceRelease = options.ports.commit(attempt.staged, attempt.generation);
      } catch {
        let failureRelease: SurfaceReleaseWork | void;
        try {
          failureRelease = prepared.fail();
        } catch (error) {
          poison(error);
          throw error;
        }
        const restored = await restore(attempt);
        if (restored.restored) restorePresentation(attempt);
        else {
          status = "fallback";
          fallback = "preview";
          activeAttempt = undefined;
        }
        retire(attempt);
        release(failureRelease);
        release(restored.release);
        return false;
      }

      let preparedRelease: SurfaceReleaseWork | void;
      try {
        preparePort();
        preparedRelease = prepared.commit();
      } catch (error) {
        poison(error);
        throw error;
      }
      mounted = attempt.staged;
      attempt.owned.clear();
      current = copyCapture(attempt.target);
      currentSource = attempt.source;
      syncCounters();
      if (retrySurface === undefined) {
        status = attempt.failure === null ? "committed" : "fallback";
        fallback = attempt.failure;
      } else {
        fallback = fallback === retrySurface ? null : fallback;
        status = fallback === null ? "committed" : "fallback";
      }
      release(preparedRelease);
      release(resourceRelease);
      return true;
    } finally {
      finishCritical(attempt);
    }
  };

  const queueApply = (source: string, operation: GuardedSurfaceOperation, retrySurface?: DerivedSurface): Promise<boolean> =>
    enqueue(() => execute(source, operation, retrySurface));
  const retryOperation = (source: string, surface: DerivedSurface): GuardedSurfaceOperation => ({
    enter: () => source === current.currentExactSource,
    prepare: () => ({ commit: () => undefined, fail: () => undefined }),
    reject: () => undefined,
  });
  const replaceCaptureNow = (capture: DerivedSurfaceCapture): void => {
    current = copyCapture(capture);
    currentSource = capture.currentExactSource;
    syncCounters();
  };
  const invalidateNow = (): void => {
    current = {
      ...current,
      parentApplyGeneration: current.parentApplyGeneration + 1,
      parentApplyToken: current.parentApplyToken + 1,
      derivedRetryToken: current.derivedRetryToken + 1,
    };
    syncCounters();
  };
  const remountNow = (): void => {
    current = {
      ...current,
      hostGeneration: current.hostGeneration + 1,
      parentApplyToken: current.parentApplyToken + 1,
      derivedRetryToken: current.derivedRetryToken + 1,
    };
    syncCounters();
  };

  return {
    snapshot,
    apply(source, operation) {
      return queueApply(source, operation);
    },
    applyTerminalLocal(source, entry) {
      const token = Symbol("terminal-local");
      const currentEntry = (): boolean => entry.terminalEpochCurrent
        && entry.displayGenerationCurrent
        && entry.selectedSourceCurrent
        && (entry.commitCurrent?.() ?? true);
      if (!currentEntry()) return Promise.resolve(null);
      terminalLocalAttempt = { token, settled: false };
      return queueApply(source, {
        enter: currentEntry,
        prepare: () => currentEntry()
          ? { commit: () => undefined, fail: () => undefined }
          : null,
        reject: () => undefined,
      }).then((committed) => ({
        terminalLocalToken: token,
        outcome: !committed ? "failed" : fallback === null ? "complete" : "fallback",
        fallback: committed ? fallback : null,
      }));
    },
    retry(source) {
      return queueApply(source, retryOperation(source, fallback ?? "preview"), fallback ?? "preview");
    },
    retryPreview(source) {
      return queueApply(source, retryOperation(source, "preview"), "preview");
    },
    retryVisual(source) {
      return queueApply(source, retryOperation(source, "visual"), "visual");
    },
    retryDiff(source) {
      return queueApply(source, retryOperation(source, "diff"), "diff");
    },
    replaceCapture(capture) {
      if (!blocked && activeAttempt !== undefined) retire(activeAttempt);
      enqueueVoid(() => replaceCaptureNow(copyCapture(capture)));
    },
    invalidate() {
      if (!blocked && activeAttempt !== undefined) retire(activeAttempt);
      enqueueVoid(invalidateNow);
    },
    remount() {
      if (!blocked && activeAttempt !== undefined) retire(activeAttempt);
      enqueueVoid(remountNow);
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
    settleUseConsumedResponse(token, result) {
      if (terminalLocalAttempt === null || terminalLocalAttempt.token !== token || terminalLocalAttempt.settled) return null;
      terminalLocalAttempt.settled = true;
      return result === "displayed" ? "use-consumed-response-displayed" : "use-consumed-response-display-failed";
    },
  };
}
