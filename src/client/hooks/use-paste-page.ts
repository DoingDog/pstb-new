import * as React from "react";
import { createPasteApi, type ApiFailure, type ApiResult, type PasteApi } from "../api";
import { AutosaveController, type AutosaveDispatch, type AutosaveSaveRequest, type AutosaveSaveResult, type AutosaveSnapshot } from "../autosave";
import { commitPastePassword, type TrustedMarkdownHtml } from "../bootstrap";
import type {
  AcceptedPasteState,
  ActionKey,
  AppBootstrap,
  AutosyncStatus,
  BaselineCapture,
  LastAction,
  OperationRecords,
  PastePhase,
  PasteSummary,
  RemoteSnapshot,
  SourceEvent,
} from "../contracts";
import { createHistoryController, createHistoryDiff, type HistoryController, type HistoryDiffController } from "../history";
import type { HistoryDiffState, HistoryPanelState } from "../components/HistoryPanel";
import { createPasteController, type ContentReconcileDispatch, type MetadataReconcileDispatch, type MutationDispatch, type MutationIntent, type PasteController, type PasteControllerSnapshot, type ReconcileReadFailure } from "../paste-controller";
import { PasteSync, type PasteSyncCapture, type PasteSyncEvent, type PasteSyncReadResult } from "../paste-sync";
import { createStagedSurfaceApply, type StagedSurfaceApply } from "../surface-apply";
import type { DeleteFlowState } from "../components/DeleteFlow";
import type { PasswordPanelState } from "../components/PasswordPanel";
import type { SettingsPanelState } from "../components/SettingsPanel";

export interface TerminalPage {
  phase: "armed-view-once" | "consumed" | "not-found" | "delete-uncertain";
  source: string;
  initialMarkdown: TrustedMarkdownHtml | null;
}

export interface PastePageCallbacks {
  onRecordsChange?(records: OperationRecords): void;
  onTerminal?(page: TerminalPage): void;
  onRootHandoff?(): void;
}

export interface PastePageActions {
  sourceEvent(event: SourceEvent): void;
  activity(eventAt: number): void;
  autosaveInput(content: string, eventAt: number): void;
  compositionStart(): void;
  compositionEnd(content: string, eventAt: number): void;
  retry(credential: string | null): void;
  reconcile(): void;
  reload(): void;
  discard(): void;
  saveTitle(value: string): void;
  saveFormat(value: "text" | "markdown"): void;
  saveExpiration(value: number | string | null): void;
  saveViewOnce(value: boolean): void;
  setPassword(newPassword: string, authorizationPassword: string | null): void;
  clearPassword(authorizationPassword: string | null): void;
  deletePaste(authorizationPassword: string | null): void;
  openHistory(): void;
  selectRevision(revision: number): void;
  computeDiff(): void;
  back(): void;
  useRemote(): void;
  keepCurrent(): void;
  retrySync(): void;
}

export interface PastePageCandidate {
  source: string;
  kind: "remote" | "terminal" | "forbidden";
}

export interface PastePageSnapshot {
  paste: Readonly<PasteControllerSnapshot>;
  autosave: Readonly<AutosaveSnapshot>;
  records: OperationRecords;
  history: HistoryPanelState;
  settings: SettingsPanelState;
  password: PasswordPanelState;
  deleteFlow: DeleteFlowState;
  candidate: PastePageCandidate | null;
  source: string;
  acceptedSource: string;
  version: string | null;
  autosaveAcceptedSource: string;
  lastSavedContent: string;
}

export interface UsePastePageResult {
  snapshot: PastePageSnapshot;
  actions: PastePageActions;
}

type OrdinaryInitialPage = {
  ok: true;
  bootstrap: Extract<AppBootstrap, { page: "paste"; consumed: false }>;
  exactSource: string;
  initialMarkdown: TrustedMarkdownHtml | null;
  password: string | null;
};
type ActiveSnapshot = Extract<PasteControllerSnapshot, { resource: "active" }>;
type Candidate = {
  kind: "remote" | "terminal" | "forbidden";
  snapshot?: RemoteSnapshot;
  source: string;
};

type Runtime = {
  api: PasteApi;
  paste: PasteController;
  autosave: AutosaveController;
  sync: PasteSync;
  history: HistoryController;
  historyDiff: HistoryDiffController;
  surface: StagedSurfaceApply;
  records: OperationRecords;
  activeUntil: number;
  validator: `"sha256-${string}"` | null;
  candidate: Candidate | null;
  composing: boolean;
  disposed: boolean;
  terminalSignalled: boolean;
  requestControllers: Set<AbortController>;
  lastIntent: MutationIntent | null;
  reloadToken: number;
  diff: HistoryDiffState;
};

function now(): number {
  return performance.now();
}

function displayTime(): string {
  return new Date().toISOString();
}

function active(snapshot: Readonly<PasteControllerSnapshot>): snapshot is Readonly<ActiveSnapshot> {
  return snapshot.resource === "active";
}

function acceptedFrom(initialPage: OrdinaryInitialPage): AcceptedPasteState {
  const paste = initialPage.bootstrap.paste;
  return {
    acceptedSource: initialPage.exactSource,
    draft: initialPage.exactSource,
    summary: paste,
    version: paste.version,
    versionUsable: true,
    contentRevision: paste.contentRevision,
    updatedAt: paste.updatedAt,
    responseEtag: null,
    acceptedApplyGeneration: 0,
    localGeneration: 0,
    displayGeneration: 0,
  };
}

function initialRecords(): OperationRecords {
  return {
    autosave: { state: "clean", confirmedAt: null, failedAt: null },
    autosync: { state: "waiting", stateChangedAt: null, checkedAt: null, appliedAt: null },
    network: { state: navigator.onLine === false ? "offline" : "online", changedAt: displayTime() },
    lastAction: { state: "idle" },
  };
}

function baseline(snapshot: ActiveSnapshot): BaselineCapture {
  const separator = snapshot.version.lastIndexOf(".");
  return {
    acceptedApplyGeneration: snapshot.acceptedApplyGeneration,
    localGeneration: snapshot.localGeneration,
    generation: snapshot.version === "legacy" ? "legacy" : separator > 0 ? snapshot.version.slice(0, separator) : snapshot.version,
    version: snapshot.version,
    contentRevision: snapshot.contentRevision,
    updatedAt: snapshot.updatedAt,
    acceptedSource: snapshot.acceptedSource,
  };
}

function sameBaseline(left: BaselineCapture, right: BaselineCapture): boolean {
  return left.acceptedApplyGeneration === right.acceptedApplyGeneration
    && left.localGeneration === right.localGeneration
    && left.generation === right.generation
    && left.version === right.version
    && left.contentRevision === right.contentRevision
    && left.updatedAt === right.updatedAt
    && left.acceptedSource === right.acceptedSource;
}

function reconcileFailure(failure: ApiFailure): ReconcileReadFailure {
  if (failure.status === 403) return { kind: "forbidden" };
  if (failure.status === 404) return { kind: "not-found" };
  if (failure.kind === "network") return { kind: "network" };
  if (failure.kind === "malformed") return { kind: "malformed" };
  return { kind: "unavailable" };
}

function syncResult(result: Awaited<ReturnType<PasteApi["readResource"]>>): PasteSyncReadResult {
  if (result.kind === "snapshot") return { status: 200, snapshot: result.snapshot };
  if (result.kind === "not-modified") return { status: 304, etag: result.etag };
  return { status: result.failure.status ?? 0 };
}

function cloneIntentWithCredential(intent: MutationIntent, credential: string | null): MutationIntent {
  switch (intent.kind) {
    case "password-set": return { ...intent, authorizationPassword: credential };
    case "password-clear": return { ...intent, authorizationPassword: credential };
    case "delete": return { ...intent, authorizationPassword: credential };
    default: return intent;
  }
}

function statusFor(lastAction: LastAction, keys: readonly ActionKey[], snapshot: ActiveSnapshot): "idle" | "pending" | "succeeded" | "validation-error" | "credential-required" | "conflict" | "retryable" | "reconciliation-required" {
  if (snapshot.reconciliationRequired) return "reconciliation-required";
  if (lastAction.state === "idle" || !keys.includes(lastAction.key)) return "idle";
  if (lastAction.state === "pending") return "pending";
  if (lastAction.state === "succeeded") return "succeeded";
  if (snapshot.originalMutationFailure?.status === 403 || snapshot.autosave.state === "password-required") return "credential-required";
  if (snapshot.originalMutationFailure?.status === 409 || snapshot.autosave.state === "conflict" || !snapshot.versionUsable) return "conflict";
  return "retryable";
}

function emptyHistory(): HistoryPanelState {
  return {
    listState: "idle",
    snapshotState: "idle",
    list: null,
    selected: null,
    failure: null,
    diff: { state: "idle", lines: [] },
  };
}

function shallowHistory(runtime: Runtime): HistoryPanelState {
  const state = runtime.history.snapshot();
  return {
    listState: state.listState,
    snapshotState: state.snapshotState,
    list: state.list,
    selected: state.selected,
    failure: state.failure,
    diff: runtime.diff,
  };
}

function initialView(initialPage: OrdinaryInitialPage): PastePageSnapshot {
  const accepted = acceptedFrom(initialPage);
  const autosave: AutosaveSnapshot = {
    state: "clean",
    draft: accepted.draft,
    acceptedSource: accepted.acceptedSource,
    lastSavedContent: accepted.acceptedSource,
    version: accepted.version,
    lastInputAt: null,
    dueAt: null,
    inFlightContent: null,
    dirtyWhileSaving: false,
    failureStatus: null,
    requiresExplicitRetry: false,
    coalescedIntent: false,
  };
  const settings: SettingsPanelState = {
    accepted: { id: accepted.summary.id, title: accepted.summary.title, format: accepted.summary.format, expiration: accepted.summary.expiresAt ?? null, viewOnce: accepted.summary.viewOnce },
    versionUsable: true,
    result: { field: null, state: "idle", message: null },
  };
  return {
    paste: { ...accepted, resource: "active", lastSavedContent: accepted.acceptedSource, mutation: { state: "idle", nextToken: 0 }, coalescedSource: null, phase: "ordinary", credential: { committed: initialPage.password, pending: null }, autosave: { state: "clean", confirmedAt: null, failedAt: null }, lastAction: { state: "idle" }, conflictCandidate: null, terminalResponseSource: null, terminalOrigin: null, originalMutationFailure: null, reconciliationRequired: false, serverCapabilities: true },
    autosave,
    records: initialRecords(),
    history: emptyHistory(),
    settings,
    password: { protected: accepted.summary.protected, versionUsable: true, result: { action: null, state: "idle", message: null }, currentUrl: location.href, representations: [] },
    deleteFlow: { phase: "ordinary", result: { state: "idle", message: null }, mutationPending: false, versionUsable: true },
    candidate: null,
    source: accepted.draft,
    acceptedSource: accepted.acceptedSource,
    version: accepted.version,
    autosaveAcceptedSource: accepted.acceptedSource,
    lastSavedContent: accepted.acceptedSource,
  };
}

/** The only React-side interpreter for paste controller effects. */
export function usePastePage(initialPage: OrdinaryInitialPage, callbacks: PastePageCallbacks = {}): UsePastePageResult {
  const initial = React.useRef(initialPage).current;
  const callbacksRef = React.useRef(callbacks);
  callbacksRef.current = callbacks;
  const runtimeRef = React.useRef<Runtime | null>(null);
  const publishQueued = React.useRef(false);
  const [view, setView] = React.useState<PastePageSnapshot>(() => initialView(initial));

  const makeView = React.useCallback((runtime: Runtime): PastePageSnapshot => {
    const paste = runtime.paste.snapshot();
    const autosave = runtime.autosave.snapshot();
    if (!active(paste)) {
      return {
        ...view,
        paste,
        autosave,
        records: { ...runtime.records, lastAction: paste.lastAction },
        history: shallowHistory(runtime),
        candidate: runtime.candidate === null ? null : { kind: runtime.candidate.kind, source: runtime.candidate.source },
        source: paste.draft,
        acceptedSource: paste.acceptedSource,
        version: paste.version,
        autosaveAcceptedSource: autosave.acceptedSource,
        lastSavedContent: paste.lastSavedContent,
      };
    }

    const settingsState = statusFor(paste.lastAction, ["settings-title", "settings-format", "settings-expiration", "settings-view-once", "settings-reconcile"], paste);
    const passwordState = statusFor(paste.lastAction, ["password-set", "password-clear", "password-reconcile"], paste);
    const deleteState = statusFor(paste.lastAction, ["delete"], paste);
    const expiration = paste.summary.expiration.kind === "permanent"
      ? null
      : paste.summary.expiration.kind === "relative"
        ? paste.summary.expiration.seconds
        : paste.summary.expiresAt ?? null;
    const passwordAction = paste.lastAction.state === "idle" || !["password-set", "password-clear", "password-reconcile"].includes(paste.lastAction.key)
      ? null
      : paste.lastAction.key === "password-clear" ? "clear" : "set";
    const deletePhase: DeleteFlowState["phase"] = paste.phase === "not-found" || paste.phase === "delete-uncertain"
      ? paste.phase
      : "ordinary";
    const lastActionKey = paste.lastAction.state === "idle" ? null : paste.lastAction.key;

    return {
      paste,
      autosave,
      records: { ...runtime.records, autosave: { ...runtime.records.autosave }, autosync: { ...runtime.records.autosync }, network: { ...runtime.records.network }, lastAction: paste.lastAction },
      history: shallowHistory(runtime),
      settings: {
        accepted: { id: paste.summary.id, title: paste.summary.title, format: paste.summary.format, expiration, viewOnce: paste.summary.viewOnce },
        versionUsable: paste.versionUsable,
        result: {
          field: settingsState === "idle" ? null : lastActionKey === "settings-format" ? "format" : lastActionKey === "settings-expiration" ? "expiration" : lastActionKey === "settings-view-once" ? "viewOnce" : "title",
          state: settingsState,
          message: null,
          ...(settingsState === "reconciliation-required" && paste.mutation.state === "metadata-reconciliation" && paste.mutation.intent.kind === "settings-expiration" && typeof paste.mutation.intent.expiration === "number" ? { reconciliationIntent: "relative" as const } : {}),
        } as SettingsPanelState["result"],
      },
      password: {
        protected: paste.summary.protected,
        versionUsable: paste.versionUsable,
        result: { action: passwordAction, state: passwordState, message: null },
        currentUrl: location.href,
        representations: [
          { label: "Raw", href: paste.summary.links.raw },
          { label: "HTML", href: paste.summary.links.html },
          { label: "Markdown", href: paste.summary.links.markdown },
          { label: "File", href: paste.summary.links.file },
        ],
      },
      deleteFlow: {
        phase: deletePhase,
        result: {
          state: deleteState === "idle" ? "idle" : deleteState === "pending" ? "pending" : deleteState === "succeeded" ? "succeeded" : deleteState === "credential-required" ? "credential-required" : deleteState === "conflict" ? "conflict" : paste.phase === "not-found" ? "not-found" : paste.phase === "delete-uncertain" ? "uncertain" : "idle",
          message: null,
        },
        mutationPending: paste.mutation.state !== "idle",
        versionUsable: paste.versionUsable,
      },
      candidate: runtime.candidate === null ? null : { kind: runtime.candidate.kind, source: runtime.candidate.source },
      source: paste.draft,
      acceptedSource: paste.acceptedSource,
      version: paste.version,
      autosaveAcceptedSource: autosave.acceptedSource,
      lastSavedContent: paste.lastSavedContent,
    };
  // The empty dependency keeps a single coordinator closure for a mounted paste.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const publish = React.useCallback((runtime: Runtime | null = runtimeRef.current) => {
    if (runtime === null || runtime.disposed) return;
    const next = makeView(runtime);
    setView(next);
    callbacksRef.current.onRecordsChange?.(next.records);
  }, [makeView]);

  const queuePublish = React.useCallback(() => {
    if (publishQueued.current) return;
    publishQueued.current = true;
    queueMicrotask(() => {
      publishQueued.current = false;
      publish();
    });
  }, [publish]);

  function updateAutosaveRecord(runtime: Runtime): void {
    const snapshot = runtime.autosave.snapshot();
    const previous = runtime.records.autosave.state;
    const next = snapshot.state;
    if (previous === next) return;
    const instant = displayTime();
    runtime.records = {
      ...runtime.records,
      autosave: {
        state: next,
        confirmedAt: next === "saved" ? instant : runtime.records.autosave.confirmedAt,
        failedAt: next === "error" || next === "password-required" || next === "not-found" || next === "conflict" ? instant : runtime.records.autosave.failedAt,
      },
    };
  }

  function updateSyncRecord(runtime: Runtime, event: PasteSyncEvent): void {
    const instant = displayTime();
    const current = runtime.records.autosync;
    switch (event.type) {
      case "state":
        runtime.records = { ...runtime.records, autosync: { ...current, state: event.state, stateChangedAt: event.at === null ? null : instant } };
        return;
      case "unchanged":
        runtime.validator = event.etag;
        runtime.records = { ...runtime.records, autosync: { ...current, state: "unchanged", checkedAt: instant } };
        return;
      case "candidate":
      case "proven-newer":
        runtime.records = { ...runtime.records, autosync: { ...current, state: "checking", checkedAt: instant } };
        return;
      case "forbidden":
        runtime.records = { ...runtime.records, autosync: { ...current, state: "forbidden", stateChangedAt: instant } };
        return;
      case "not-found":
        runtime.records = { ...runtime.records, autosync: { ...current, state: "not-found", stateChangedAt: instant } };
        return;
      case "conflict":
        runtime.records = { ...runtime.records, autosync: { ...current, state: "conflict", stateChangedAt: instant } };
        return;
      case "error":
        runtime.records = { ...runtime.records, autosync: { ...current, state: "error", stateChangedAt: instant } };
        return;
      case "credential-proved":
      case "terminal-view-once":
        return;
    }
  }

  function surfaceCapture(snapshot: ActiveSnapshot) {
    return {
      localGeneration: snapshot.localGeneration,
      currentExactSource: snapshot.acceptedSource,
      currentDisplayGeneration: snapshot.displayGeneration,
      hostGeneration: 0,
      parentApplyGeneration: snapshot.acceptedApplyGeneration,
      parentApplyToken: snapshot.acceptedApplyGeneration,
      derivedRetryToken: 0,
    };
  }

  function captureForSync(runtime: Runtime): PasteSyncCapture {
    const snapshot = runtime.paste.snapshot();
    if (!active(snapshot)) throw new Error("Cannot capture a terminal paste for sync");
    const save = runtime.autosave.snapshot();
    return {
      phase: snapshot.phase,
      activeUntil: runtime.activeUntil,
      locallyClean: save.draft === save.acceptedSource && save.inFlightContent === null && save.dueAt === null,
      offline: navigator.onLine === false,
      localGeneration: snapshot.localGeneration,
      acceptedApplyGeneration: snapshot.acceptedApplyGeneration,
      baseline: baseline(snapshot),
      acceptedSummary: snapshot.summary,
      responseEtag: runtime.validator,
    };
  }

  function disposeRuntime(runtime: Runtime): void {
    if (runtime.disposed) return;
    runtime.disposed = true;
    runtime.autosave.dispose();
    runtime.sync.dispose();
    runtime.history.destroy();
    runtime.historyDiff.destroy();
    for (const controller of runtime.requestControllers) controller.abort();
    runtime.requestControllers.clear();
  }

  function signal(runtime: Runtime): AbortController | null {
    if (runtime.disposed) return null;
    const controller = new AbortController();
    runtime.requestControllers.add(controller);
    return controller;
  }

  function settleRequest(runtime: Runtime, controller: AbortController): boolean {
    runtime.requestControllers.delete(controller);
    return !runtime.disposed && runtimeRef.current === runtime;
  }

  function completeTerminal(runtime: Runtime, phase: TerminalPage["phase"], source: string): void {
    if (runtime.disposed || runtime.terminalSignalled) return;
    runtime.terminalSignalled = true;
    callbacksRef.current.onTerminal?.({ phase, source, initialMarkdown: source === initial.exactSource ? initial.initialMarkdown : null });
  }

  async function stageTerminal(runtime: Runtime, phase: TerminalPage["phase"], source: string): Promise<void> {
    const snapshot = runtime.paste.snapshot();
    const activeSnapshot = active(snapshot) ? snapshot : null;
    const receipt = await runtime.surface.applyTerminalLocal(source, {
      terminalEpochCurrent: !runtime.disposed,
      displayGenerationCurrent: activeSnapshot === null || activeSnapshot.displayGeneration === snapshot.displayGeneration,
      selectedSourceCurrent: true,
    });
    if (runtime.disposed || runtimeRef.current !== runtime || receipt === null) return;
    const current = runtime.paste.snapshot();
    if (active(current) && current.terminalOrigin !== null) {
      const outcome = runtime.surface.settleTerminal(current.terminalOrigin, receipt.applied ? "displayed" : "display-failed");
      if (outcome !== null) current && runtime.paste.settleTerminal(outcome, now());
    }
    completeTerminal(runtime, phase, receipt.applied ? source : (active(current) ? current.draft : source));
    publish(runtime);
  }

  function terminalFromEffect(runtime: Runtime, phase: PastePhase): void {
    const snapshot = runtime.paste.snapshot();
    if (!active(snapshot)) return;
    if (phase === "armed-view-once") {
      completeTerminal(runtime, "armed-view-once", snapshot.acceptedSource);
      return;
    }
    if (phase === "not-found") {
      completeTerminal(runtime, "not-found", snapshot.draft);
      return;
    }
    if (phase === "delete-uncertain") {
      completeTerminal(runtime, "delete-uncertain", snapshot.draft);
      return;
    }
    const source = snapshot.terminalResponseSource ?? snapshot.draft;
    void stageTerminal(runtime, "consumed", source);
  }

  function dispatchContentReconcile(runtime: Runtime, dispatch: ContentReconcileDispatch): void {
    if (dispatch.kind !== "dispatch") return;
    const controller = signal(runtime);
    if (controller === null) return;
    void runtime.api.readResource({
      id: initial.bootstrap.paste.id,
      password: dispatch.authorizationPassword,
      ifNoneMatch: null,
      signal: controller.signal,
    }).then((result) => {
      if (!settleRequest(runtime, controller)) return;
      const decoded = result.kind === "snapshot" ? { kind: "snapshot", snapshot: result.snapshot } as const : reconcileFailure(result.kind === "failure" ? result.failure : { kind: "malformed", status: 304, code: "MALFORMED_RESPONSE", mutationMayHaveApplied: false });
      runtime.paste.acceptContentReconcile(dispatch.requestToken, decoded, now());
      drainEffects(runtime);
      publish(runtime);
    }, () => {
      if (!settleRequest(runtime, controller)) return;
      runtime.paste.acceptContentReconcile(dispatch.requestToken, { kind: "network" }, now());
      drainEffects(runtime);
      publish(runtime);
    });
  }

  function dispatchMetadataReconcile(runtime: Runtime, dispatch: MetadataReconcileDispatch): void {
    if (dispatch.kind !== "dispatch") return;
    const controller = signal(runtime);
    if (controller === null) return;
    void runtime.api.getSettings({ id: initial.bootstrap.paste.id, password: dispatch.authorizationPassword, signal: controller.signal }).then((result) => {
      if (!settleRequest(runtime, controller)) return;
      runtime.paste.acceptMetadataReconcile(dispatch.requestToken, result.ok ? { kind: "summary", summary: result.value } : reconcileFailure(result.failure), now());
      drainEffects(runtime);
      publish(runtime);
    }, () => {
      if (!settleRequest(runtime, controller)) return;
      runtime.paste.acceptMetadataReconcile(dispatch.requestToken, { kind: "network" }, now());
      drainEffects(runtime);
      publish(runtime);
    });
  }

  function dispatchMutation(runtime: Runtime, dispatch: MutationDispatch): void {
    const controller = signal(runtime);
    if (controller === null) return;
    const password = dispatch.authorizationPassword;
    let request: Promise<ApiResult<PasteSummary | import("../contracts").MutationResult | null>>;
    if (dispatch.intent.kind === "settings-title") {
      request = runtime.api.updateSettings({ id: initial.bootstrap.paste.id, change: { field: "title", value: dispatch.intent.title }, password, version: dispatch.version!, signal: controller.signal });
    } else if (dispatch.intent.kind === "settings-format") {
      request = runtime.api.updateSettings({ id: initial.bootstrap.paste.id, change: { field: "format", value: dispatch.intent.format }, password, version: dispatch.version!, signal: controller.signal });
    } else if (dispatch.intent.kind === "settings-expiration") {
      request = runtime.api.updateSettings({ id: initial.bootstrap.paste.id, change: { field: "expiration", value: dispatch.intent.expiration }, password, version: dispatch.version!, signal: controller.signal });
    } else if (dispatch.intent.kind === "settings-view-once") {
      request = runtime.api.updateSettings({ id: initial.bootstrap.paste.id, change: { field: "viewOnce", value: dispatch.intent.viewOnce }, password, version: dispatch.version!, signal: controller.signal });
    } else if (dispatch.intent.kind === "password-set") {
      request = runtime.api.updatePassword({ id: initial.bootstrap.paste.id, password, newPassword: dispatch.intent.newPassword, version: dispatch.version!, signal: controller.signal });
    } else if (dispatch.intent.kind === "password-clear") {
      request = runtime.api.clearPassword({ id: initial.bootstrap.paste.id, password, version: dispatch.version!, signal: controller.signal });
    } else if (dispatch.intent.kind === "delete") {
      request = runtime.api.deletePaste({ id: initial.bootstrap.paste.id, password, version: dispatch.version!, signal: controller.signal });
    } else {
      controller.abort();
      runtime.requestControllers.delete(controller);
      return;
    }
    void request.then((result) => {
      if (!settleRequest(runtime, controller)) return;
      if (dispatch.intent.kind === "delete") {
        runtime.paste.acceptDeleteMutation(dispatch.token, result.ok ? { status: 204 } : { status: result.failure.status, mutationMayHaveApplied: result.failure.mutationMayHaveApplied === true }, now());
      } else if (result.ok) {
        runtime.paste.acceptMetadataMutation(dispatch.token, result.value as import("../contracts").MutationResult, now());
      } else {
        runtime.paste.failMutation(dispatch.token, { status: result.failure.status, mutationMayHaveApplied: result.failure.mutationMayHaveApplied === true }, now());
      }
      drainEffects(runtime);
      publish(runtime);
    }, () => {
      if (!settleRequest(runtime, controller)) return;
      if (dispatch.intent.kind === "delete") runtime.paste.acceptDeleteMutation(dispatch.token, { status: null, mutationMayHaveApplied: true }, now());
      else runtime.paste.failMutation(dispatch.token, { status: null, mutationMayHaveApplied: true }, now());
      drainEffects(runtime);
      publish(runtime);
    });
  }

  function dispatchAutosave(runtime: Runtime, request: AutosaveSaveRequest): AutosaveDispatch {
    const start = runtime.paste.startMutation({ kind: "content", action: request.action, content: request.content, omitVersion: request.action === "overwrite" }, now());
    if (start.kind !== "dispatch") return { kind: "blocked" };
    runtime.lastIntent = start.intent;
    drainEffects(runtime);
    const controller = signal(runtime);
    if (controller === null) return { kind: "blocked" };
    const completion = runtime.api.saveContent({
      id: initial.bootstrap.paste.id,
      content: request.content,
      password: request.password ?? start.authorizationPassword,
      version: start.version,
      signal: controller.signal,
    }).then((result): AutosaveSaveResult => {
      if (!settleRequest(runtime, controller)) return { status: 0, mutationMayHaveApplied: false };
      if (result.ok) {
        const accepted = runtime.paste.acceptContentMutation(start.token, result.value, now());
        if (!accepted) return { status: 0, mutationMayHaveApplied: false };
        // Update both controller authorities before the autosave promise publishes a render.
        drainEffects(runtime);
        publish(runtime);
        return { status: 200, changed: result.value.changed, paste: result.value.paste };
      }
      runtime.paste.failMutation(start.token, { status: result.failure.status, mutationMayHaveApplied: result.failure.mutationMayHaveApplied === true }, now());
      drainEffects(runtime);
      publish(runtime);
      return { status: result.failure.status ?? 0, mutationMayHaveApplied: result.failure.mutationMayHaveApplied === true };
    }, (): AutosaveSaveResult => {
      if (!settleRequest(runtime, controller)) return { status: 0, mutationMayHaveApplied: false };
      runtime.paste.failMutation(start.token, { status: null, mutationMayHaveApplied: true }, now());
      drainEffects(runtime);
      publish(runtime);
      return { status: 0, mutationMayHaveApplied: true };
    });
    return { kind: "started", completion };
  }

  function drainEffects(runtime: Runtime): void {
    if (runtime.disposed || runtimeRef.current !== runtime) return;
    for (;;) {
      const effects = runtime.paste.takeEffects();
      if (effects.length === 0) break;
      for (const effect of effects) {
        if (runtime.disposed || runtimeRef.current !== runtime) return;
        if (effect.type === "invalidate-sync") {
          runtime.sync.localWorkChanged();
          continue;
        }
        if (effect.type === "invalidate-history") {
          runtime.history.invalidate(effect.reason);
          continue;
        }
        if (effect.type === "autosave-slot-available") {
          runtime.autosave.slotAvailable();
          continue;
        }
        if (effect.type === "credential-commit") {
          commitPastePassword(new URL(location.href), effect.credential);
          continue;
        }
        if (effect.type === "apply-authoritative") {
          if (effect.kind === "pause") {
            runtime.autosave.applyAuthoritative({ kind: "pause", state: effect.state!, failureStatus: effect.failureStatus ?? null });
          } else {
            runtime.autosave.applyAuthoritative({
              kind: effect.kind === "content" ? "replace" : effect.kind,
              acceptedSource: effect.acceptedSource!,
              version: effect.version!,
            });
            const snapshot = runtime.paste.snapshot();
            if (active(snapshot)) {
              runtime.validator = null;
              runtime.surface.replaceCapture(surfaceCapture(snapshot));
              runtime.sync.localWorkSettled(now());
            }
          }
          updateAutosaveRecord(runtime);
          continue;
        }
        if (effect.type === "pause") {
          runtime.autosave.applyAuthoritative({ kind: "pause", state: effect.state, failureStatus: effect.failureStatus });
          updateAutosaveRecord(runtime);
          continue;
        }
        if (effect.type === "dispatch-metadata-reconcile") {
          dispatchMetadataReconcile(runtime, { kind: "dispatch", type: "reconcile-settings", mutationToken: effect.mutationToken, requestToken: effect.requestToken, intent: effect.intent, credentialProbe: effect.credentialProbe, authorizationPassword: effect.authorizationPassword });
          continue;
        }
        if (effect.type === "dispatch-relative-expiration-retry") {
          dispatchMutation(runtime, { kind: "dispatch", type: "dispatch-metadata", token: effect.token, intent: effect.intent, capture: baseline(runtime.paste.snapshot() as ActiveSnapshot), version: effect.version, authorizationPassword: (runtime.paste.snapshot() as ActiveSnapshot).credential.pending ?? (runtime.paste.snapshot() as ActiveSnapshot).credential.committed });
          continue;
        }
        if (effect.type === "dispose-server-capabilities") {
          runtime.autosave.dispose();
          runtime.sync.dispose();
          runtime.history.destroy();
          for (const request of runtime.requestControllers) request.abort();
          runtime.requestControllers.clear();
          terminalFromEffect(runtime, effect.phase);
          continue;
        }
        if (effect.type === "root-handoff") {
          runtime.autosave.dispose();
          runtime.sync.dispose();
          runtime.history.destroy();
          history.replaceState(null, "", "/");
          callbacksRef.current.onRootHandoff?.();
          continue;
        }
      }
    }
    updateAutosaveRecord(runtime);
  }

  function beginMutation(runtime: Runtime, intent: MutationIntent): void {
    if (runtime.disposed) return;
    const start = runtime.paste.startMutation(intent, now());
    if (start.kind !== "dispatch") {
      publish(runtime);
      return;
    }
    runtime.lastIntent = intent;
    drainEffects(runtime);
    dispatchMutation(runtime, start);
    publish(runtime);
  }

  function openHistory(runtime: Runtime): void {
    const snapshot = runtime.paste.snapshot();
    if (!active(snapshot) || snapshot.phase !== "ordinary") return;
    const capture = baseline(snapshot);
    const request = runtime.history.open(capture);
    const controller = signal(runtime);
    if (controller === null) return;
    void runtime.api.listHistory({ id: snapshot.summary.id, password: snapshot.credential.pending ?? snapshot.credential.committed, signal: controller.signal }).then((result) => {
      if (!settleRequest(runtime, controller)) return;
      if (result.ok) runtime.history.acceptList(request.token, capture, result.value);
      else runtime.history.failList(request.token, capture, { status: result.failure.status, code: result.failure.code });
      publish(runtime);
    }, () => {
      if (!settleRequest(runtime, controller)) return;
      runtime.history.failList(request.token, capture, { status: null, code: "NETWORK_ERROR" });
      publish(runtime);
    });
    publish(runtime);
  }

  function selectHistory(runtime: Runtime, revision: number): void {
    const snapshot = runtime.paste.snapshot();
    if (!active(snapshot) || snapshot.phase !== "ordinary") return;
    const capture = baseline(snapshot);
    const request = runtime.history.select(revision, capture);
    const controller = signal(runtime);
    if (controller === null) return;
    void runtime.api.getHistory({ id: snapshot.summary.id, revision, password: snapshot.credential.pending ?? snapshot.credential.committed, signal: controller.signal }).then((result) => {
      if (!settleRequest(runtime, controller)) return;
      if (result.ok && runtime.history.acceptSnapshot(request.token, capture, result.value)) {
        runtime.historyDiff.selectRevision(revision, snapshot.acceptedSource, result.value.content);
      } else if (!result.ok) {
        runtime.history.failSnapshot(request.token, capture, { status: result.failure.status, code: result.failure.code });
      }
      publish(runtime);
    }, () => {
      if (!settleRequest(runtime, controller)) return;
      runtime.history.failSnapshot(request.token, capture, { status: null, code: "NETWORK_ERROR" });
      publish(runtime);
    });
    publish(runtime);
  }

  function replaceRemote(runtime: Runtime, remote: RemoteSnapshot, attempt?: import("../paste-sync").RemoteApplyAttempt): void {
    const old = runtime.paste.snapshot();
    if (!active(old) || runtime.disposed || runtimeRef.current !== runtime) return;
    if (attempt !== undefined) runtime.sync.completeRemoteApply(attempt, now());
    runtime.records = { ...runtime.records, autosync: { ...runtime.records.autosync, state: "remote-applied", appliedAt: displayTime() } };
    const credential = old.credential;
    const api = runtime.api;
    disposeRuntime(runtime);
    const next = createRuntime({
      acceptedSource: remote.source,
      draft: remote.source,
      summary: remote.summary,
      version: remote.summary.version,
      versionUsable: true,
      contentRevision: remote.contentRevision,
      updatedAt: remote.summary.updatedAt,
      responseEtag: remote.etag,
      acceptedApplyGeneration: old.acceptedApplyGeneration + 1,
      localGeneration: old.localGeneration,
      displayGeneration: old.displayGeneration + 1,
    }, credential, api, runtime.records);
    next.validator = remote.etag;
    runtimeRef.current = next;
    next.sync.start(now());
    publish(next);
  }

  async function applyRemote(runtime: Runtime, remote: RemoteSnapshot, mode: "autosync" | "candidate", attempt?: import("../paste-sync").RemoteApplyAttempt): Promise<void> {
    const snapshot = runtime.paste.snapshot();
    if (!active(snapshot) || runtime.disposed) return;
    const save = runtime.autosave.snapshot();
    const current = captureForSync(runtime);
    const applied = mode === "autosync"
      ? await runtime.surface.applyAutosync(remote.source, {
        requestCurrent: true,
        acceptedBaselineCurrent: sameBaseline(current.baseline, baseline(snapshot)),
        localGenerationCurrent: true,
        active: now() < runtime.activeUntil,
        activeUntil: runtime.activeUntil,
        composing: runtime.composing,
        autosaveTimer: save.dueAt !== null,
        autosaveInFlight: save.inFlightContent !== null,
        coalescedIntent: save.coalescedIntent,
        mutationOccupied: snapshot.mutation.state !== "idle",
        unresolvedMutation: snapshot.reconciliationRequired,
        localSourceWork: save.draft !== save.acceptedSource,
      })
      : await runtime.surface.applyUseRemote(remote.source, {
        candidateCurrent: runtime.candidate?.snapshot === remote,
        acceptedBaselineCurrent: true,
        localGenerationCurrent: true,
        ordinary: snapshot.phase === "ordinary",
        active: now() < runtime.activeUntil,
        activeDeadlineCurrent: true,
        activeUntil: runtime.activeUntil,
        draftMatchesAccepted: save.draft === save.acceptedSource,
        composing: runtime.composing,
        autosaveTimer: save.dueAt !== null,
        autosaveInFlight: save.inFlightContent !== null,
        coalescedIntent: save.coalescedIntent,
        mutationOccupied: snapshot.mutation.state !== "idle",
        unresolvedMutation: snapshot.reconciliationRequired,
        conflictCausedByCandidate: true,
      });
    if (runtime.disposed || runtimeRef.current !== runtime) return;
    if (applied) replaceRemote(runtime, remote, attempt);
    else if (attempt !== undefined) runtime.sync.cancelRemoteApply(attempt, now());
    else publish(runtime);
  }

  function handleSyncEvent(runtime: Runtime, event: PasteSyncEvent): void {
    if (runtime.disposed || runtimeRef.current !== runtime) return;
    updateSyncRecord(runtime, event);
    if (event.type === "credential-proved") {
      runtime.paste.setPendingCredential(event.password);
    } else if (event.type === "candidate") {
      runtime.candidate = { kind: "remote", source: event.snapshot.source, snapshot: event.snapshot };
    } else if (event.type === "proven-newer") {
      void applyRemote(runtime, event.snapshot, "autosync", event.attempt);
    } else if (event.type === "terminal-view-once") {
      const snapshot = runtime.paste.snapshot();
      if (!active(snapshot)) return;
      if (event.ordinaryTokenCurrent && event.snapshot.source !== snapshot.acceptedSource) {
        runtime.paste.enterTerminal("consumed", now(), { actionKey: "reload-server", actionAttempt: 0, startedAt: displayTime() });
        // Keep the selected remote source in the controller-owned terminal field via a candidate until staging.
        runtime.candidate = { kind: "terminal", source: event.snapshot.source, snapshot: event.snapshot };
        drainEffects(runtime);
      } else {
        runtime.candidate = { kind: "terminal", source: event.snapshot.source, snapshot: event.snapshot };
      }
    } else if (event.type === "forbidden") {
      runtime.candidate = { kind: "forbidden", source: "" };
    } else if (event.type === "not-found") {
      runtime.paste.enterTerminal("not-found", now());
      drainEffects(runtime);
    }
    publish(runtime);
  }

  function createRuntime(accepted: AcceptedPasteState, credential: { committed: string | null; pending: string | null }, api: PasteApi | null = null, carriedRecords: OperationRecords | null = null): Runtime {
    const runtime = {} as Runtime;
    runtime.api = api ?? createPasteApi({ fetch: globalThis.fetch, crypto: globalThis.crypto });
    runtime.records = carriedRecords ?? initialRecords();
    runtime.activeUntil = now() + 300_000;
    runtime.validator = accepted.responseEtag;
    runtime.candidate = null;
    runtime.composing = false;
    runtime.disposed = false;
    runtime.terminalSignalled = false;
    runtime.requestControllers = new Set();
    runtime.lastIntent = null;
    runtime.reloadToken = 0;
    runtime.diff = { state: "idle", lines: [] };
    runtime.paste = createPasteController({ accepted, credential });
    runtime.history = createHistoryController();
    runtime.historyDiff = createHistoryDiff({
      onLines: (lines) => {
        if (runtime.disposed) return;
        runtime.diff = { state: "ready", lines };
        queuePublish();
      },
      onError: (error) => {
        if (runtime.disposed) return;
        runtime.diff = { state: "failed", lines: [], error };
        queuePublish();
      },
    });
    runtime.surface = createStagedSurfaceApply({
      capture: surfaceCapture(runtime.paste.snapshot() as ActiveSnapshot),
      now,
      ports: {
        stagePreview: async (source) => source,
        stageVisual: async (source) => source,
        stageDiff: async (source) => source,
        commit: () => undefined,
        restoreOld: async () => true,
        showOldGenerationFailure: () => undefined,
        disposeAttemptResources: () => undefined,
      },
    });
    runtime.autosave = new AutosaveController({
      content: accepted.draft,
      version: accepted.version,
      now,
      setTimer: (callback, delay) => setTimeout(() => {
        callback();
        queuePublish();
      }, delay),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      tryDispatch: (request) => dispatchAutosave(runtime, request),
      onCoalescedIntent: () => runtime.sync.localWorkChanged(),
      getPassword: () => {
        const snapshot = runtime.paste.snapshot();
        return active(snapshot) ? snapshot.credential.pending ?? snapshot.credential.committed : null;
      },
      onStateChange: () => {
        if (runtime.autosave === undefined) return;
        updateAutosaveRecord(runtime);
        queuePublish();
      },
    });
    runtime.sync = new PasteSync({
      now,
      timer: {
        setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay as number | undefined),
        clearTimeout: (handle) => globalThis.clearTimeout(handle as number | undefined),
      },
      AbortController,
      capture: () => captureForSync(runtime),
      read: async (request) => {
        const snapshot = runtime.paste.snapshot();
        const password = request.password ?? (active(snapshot) ? snapshot.credential.pending ?? snapshot.credential.committed : null);
        return syncResult(await runtime.api.readResource({ id: initial.bootstrap.paste.id, password, ifNoneMatch: request.ifNoneMatch ?? null, signal: request.signal }));
      },
      emit: (event) => handleSyncEvent(runtime, event),
    });
    return runtime;
  }

  React.useEffect(() => {
    const runtime = createRuntime(acceptedFrom(initial), { committed: initial.password, pending: null });
    runtimeRef.current = runtime;
    runtime.sync.start(now());
    publish(runtime);
    const online = () => {
      runtime.records = { ...runtime.records, network: { state: "online", changedAt: displayTime() } };
      runtime.sync.setOnline(true, now());
      publish(runtime);
    };
    const offline = () => {
      runtime.records = { ...runtime.records, network: { state: "offline", changedAt: displayTime() } };
      runtime.sync.setOnline(false, now());
      publish(runtime);
    };
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
      disposeRuntime(runtime);
      if (runtimeRef.current === runtime) runtimeRef.current = null;
    };
  // A route change remounts OrdinaryPage by paste identity; this hook owns one lifecycle per mount.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const actions = React.useMemo<PastePageActions>(() => ({
    sourceEvent(event) {
      const runtime = runtimeRef.current;
      if (runtime === null || runtime.disposed) return;
      runtime.composing = event.type === "composition-start" ? true : event.type === "composition-end" ? false : runtime.composing;
      runtime.paste.sourceEvent(event);
      runtime.sync.recordUserActivity(event.eventAt);
      runtime.sync.localWorkChanged();
      queuePublish();
    },
    activity(eventAt) {
      const runtime = runtimeRef.current;
      if (runtime === null || runtime.disposed) return;
      runtime.sync.recordUserActivity(eventAt);
    },
    autosaveInput(content, eventAt) {
      const runtime = runtimeRef.current;
      if (runtime === null || runtime.disposed) return;
      runtime.autosave.input(content, eventAt);
    },
    compositionStart() {
      const runtime = runtimeRef.current;
      if (runtime === null || runtime.disposed) return;
      runtime.autosave.compositionStart();
    },
    compositionEnd(content, eventAt) {
      const runtime = runtimeRef.current;
      if (runtime === null || runtime.disposed) return;
      runtime.autosave.compositionEnd(content, eventAt);
    },
    retry(credential) {
      const runtime = runtimeRef.current;
      if (runtime === null || runtime.disposed) return;
      const snapshot = runtime.paste.snapshot();
      if (!active(snapshot)) return;
      runtime.paste.setPendingCredential(credential);
      if (runtime.candidate?.kind === "forbidden") {
        runtime.candidate = null;
        runtime.sync.retrySync(now(), credential);
      } else if (snapshot.mutation.state === "content-reconciliation") {
        dispatchContentReconcile(runtime, runtime.paste.startContentReconcile(now()));
      } else if (snapshot.mutation.state === "metadata-reconciliation") {
        dispatchMetadataReconcile(runtime, runtime.paste.startMetadataReconcile(now()));
      } else if (runtime.autosave.snapshot().state === "password-required") {
        runtime.autosave.retry();
      } else if (runtime.lastIntent !== null) {
        beginMutation(runtime, cloneIntentWithCredential(runtime.lastIntent, credential));
      }
      drainEffects(runtime);
      publish(runtime);
    },
    reconcile() {
      const runtime = runtimeRef.current;
      if (runtime === null || runtime.disposed) return;
      const snapshot = runtime.paste.snapshot();
      if (!active(snapshot)) return;
      if (snapshot.mutation.state === "content-reconciliation") dispatchContentReconcile(runtime, runtime.paste.startContentReconcile(now()));
      if (snapshot.mutation.state === "metadata-reconciliation") dispatchMetadataReconcile(runtime, runtime.paste.startMetadataReconcile(now()));
      drainEffects(runtime);
      publish(runtime);
    },
    reload() {
      const runtime = runtimeRef.current;
      if (runtime === null || runtime.disposed) return;
      const snapshot = runtime.paste.snapshot();
      if (!active(snapshot)) return;
      const token = ++runtime.reloadToken;
      const capture = baseline(snapshot);
      const draft = snapshot.draft;
      const controller = signal(runtime);
      if (controller === null) return;
      void runtime.api.readResource({ id: snapshot.summary.id, password: snapshot.credential.pending ?? snapshot.credential.committed, ifNoneMatch: null, signal: controller.signal }).then(async (result) => {
        if (!settleRequest(runtime, controller) || token !== runtime.reloadToken) return;
        const current = runtime.paste.snapshot();
        if (!active(current) || !sameBaseline(capture, baseline(current)) || current.draft !== draft) return;
        if (result.kind !== "snapshot") {
          publish(runtime);
          return;
        }
        if (result.snapshot.summary.viewOnce) {
          runtime.candidate = { kind: "terminal", source: result.snapshot.source, snapshot: result.snapshot };
          runtime.paste.enterTerminal("consumed", now(), { actionKey: "reload-server", actionAttempt: token, startedAt: displayTime() });
          drainEffects(runtime);
          publish(runtime);
          return;
        }
        if (result.snapshot.source === current.acceptedSource && result.snapshot.summary.version === current.version) {
          runtime.records = { ...runtime.records, autosync: { ...runtime.records.autosync, checkedAt: displayTime() } };
          publish(runtime);
          return;
        }
        const saved = runtime.autosave.snapshot();
        const applied = await runtime.surface.applyReload(result.snapshot.source, {
          requestCurrent: token === runtime.reloadToken,
          acceptedBaselineCurrent: sameBaseline(capture, baseline(current)),
          draftCurrent: current.draft === draft,
          localGenerationCurrent: true,
          mutationOccupied: current.mutation.state !== "idle",
          terminal: current.phase !== "ordinary",
        });
        if (applied && saved.draft === saved.acceptedSource) replaceRemote(runtime, result.snapshot);
        else {
          runtime.candidate = { kind: "remote", source: result.snapshot.source, snapshot: result.snapshot };
          publish(runtime);
        }
      }, () => {
        if (settleRequest(runtime, controller)) publish(runtime);
      });
      publish(runtime);
    },
    discard() {
      const runtime = runtimeRef.current;
      if (runtime === null || runtime.disposed) return;
      publish(runtime);
    },
    saveTitle(value) {
      const runtime = runtimeRef.current;
      if (runtime !== null) beginMutation(runtime, { kind: "settings-title", action: "settings-title", title: value });
    },
    saveFormat(value) {
      const runtime = runtimeRef.current;
      if (runtime !== null) beginMutation(runtime, { kind: "settings-format", action: "settings-format", format: value });
    },
    saveExpiration(value) {
      const runtime = runtimeRef.current;
      if (runtime !== null) beginMutation(runtime, { kind: "settings-expiration", action: "settings-expiration", expiration: value });
    },
    saveViewOnce(value) {
      const runtime = runtimeRef.current;
      if (runtime !== null) beginMutation(runtime, { kind: "settings-view-once", action: "settings-view-once", viewOnce: value });
    },
    setPassword(newPassword, authorizationPassword) {
      const runtime = runtimeRef.current;
      if (runtime === null) return;
      const current = runtime.paste.snapshot();
      const authorization = authorizationPassword ?? (active(current) ? current.credential.pending ?? current.credential.committed : null);
      beginMutation(runtime, { kind: "password-set", action: "password-set", newPassword, authorizationPassword: authorization });
    },
    clearPassword(authorizationPassword) {
      const runtime = runtimeRef.current;
      if (runtime === null) return;
      const current = runtime.paste.snapshot();
      const authorization = authorizationPassword ?? (active(current) ? current.credential.pending ?? current.credential.committed : null);
      beginMutation(runtime, { kind: "password-clear", action: "password-clear", authorizationPassword: authorization });
    },
    deletePaste(authorizationPassword) {
      const runtime = runtimeRef.current;
      if (runtime === null) return;
      const current = runtime.paste.snapshot();
      const authorization = authorizationPassword ?? (active(current) ? current.credential.pending ?? current.credential.committed : null);
      beginMutation(runtime, { kind: "delete", action: "delete", authorizationPassword: authorization });
    },
    openHistory() {
      const runtime = runtimeRef.current;
      if (runtime !== null) openHistory(runtime);
    },
    selectRevision(revision) {
      const runtime = runtimeRef.current;
      if (runtime !== null) selectHistory(runtime, revision);
    },
    computeDiff() {
      const runtime = runtimeRef.current;
      if (runtime === null || runtime.disposed) return;
      runtime.diff = { ...runtime.diff, state: "computing" };
      if (!runtime.historyDiff.computeDiff()) runtime.diff = { ...runtime.diff, state: "manual" };
      publish(runtime);
    },
    back() {
      const runtime = runtimeRef.current;
      if (runtime === null || runtime.disposed) return;
      runtime.historyDiff.clearSelection();
      runtime.diff = { state: "idle", lines: [] };
      publish(runtime);
    },
    useRemote() {
      const runtime = runtimeRef.current;
      const candidate = runtime?.candidate;
      if (runtime === null || runtime.disposed || candidate?.snapshot === undefined) return;
      if (candidate.kind === "terminal") {
        const current = runtime.paste.snapshot();
        if (!active(current)) return;
        runtime.paste.enterTerminal("consumed", now(), { actionKey: "reload-server", actionAttempt: ++runtime.reloadToken, startedAt: displayTime() });
        drainEffects(runtime);
        void stageTerminal(runtime, "consumed", candidate.snapshot.source);
        return;
      }
      void applyRemote(runtime, candidate.snapshot, "candidate");
    },
    keepCurrent() {
      const runtime = runtimeRef.current;
      if (runtime === null || runtime.disposed) return;
      if (runtime.candidate?.kind === "terminal") {
        const snapshot = runtime.paste.snapshot();
        if (active(snapshot)) {
          runtime.paste.enterTerminal("consumed", now(), { actionKey: "reload-server", actionAttempt: ++runtime.reloadToken, startedAt: displayTime() });
          runtime.candidate = null;
          drainEffects(runtime);
          void stageTerminal(runtime, "consumed", snapshot.draft);
        }
      } else {
        runtime.candidate = null;
        runtime.sync.keepCurrent(now());
        publish(runtime);
      }
    },
    retrySync() {
      const runtime = runtimeRef.current;
      if (runtime === null || runtime.disposed) return;
      const snapshot = runtime.paste.snapshot();
      const credential = active(snapshot) ? snapshot.credential.pending : null;
      runtime.candidate = null;
      runtime.sync.retrySync(now(), credential);
      publish(runtime);
    },
  // The runtime is intentionally mutable; the callback set must stay stable for child editors.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [queuePublish, publish]);

  return { snapshot: view, actions };
}
