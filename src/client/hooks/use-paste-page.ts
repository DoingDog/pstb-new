import * as React from "react";
import { createPasteApi, type ApiFailure, type ApiResult, type PasteApi } from "../api";
import { AutosaveController, type AutosaveDispatch, type AutosaveSaveRequest, type AutosaveSaveResult, type AutosaveSnapshot } from "../autosave";
import { commitPastePassword, withPastePassword, type TrustedMarkdownHtml } from "../bootstrap";
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
import { createHistoryController, createHistoryDiff, type HistoryController, type HistoryDiffController, type StagedHistoryDiff } from "../history";
import { prepareMarkdownPreview, prepareMarkdownVisual, type MarkdownPreview, type PreparedMarkdownVisual } from "../markdown";
import type { HistoryDiffState, HistoryPanelState } from "../components/HistoryPanel";
import { createPasteController, type ContentReconcileDispatch, type MetadataReconcileDispatch, type MutationDispatch, type MutationIntent, type PasteController, type PasteControllerSnapshot, type ReconcileReadFailure } from "../paste-controller";
import { PasteSync, classifyRemote, type PasteSyncCapture, type PasteSyncEvent, type PasteSyncReadResult, type RemoteApplyAttempt } from "../paste-sync";
import { createStagedSurfaceApply, type DerivedSurface, type StagedSurfaceApply, type SurfaceFallback } from "../surface-apply";
import type { DeleteFlowState } from "../components/DeleteFlow";
import type { PasswordPanelState } from "../components/PasswordPanel";
import type { SettingsPanelState } from "../components/SettingsPanel";

export interface SurfaceFallbackState {
  surface: Exclude<SurfaceFallback, null>;
  source: string;
  generation: number;
  hostGeneration?: number;
}

export interface TerminalPage {
  phase: "armed-view-once" | "consumed" | "not-found" | "delete-uncertain";
  source: string;
  currentSource: string;
  responseSource: string | null;
  consumedSource: string | null;
  choiceAvailable: boolean;
  initialMarkdown: TrustedMarkdownHtml | null;
  fallback: SurfaceFallbackState | null;
}

export interface TerminalHandoff {
  page: TerminalPage;
  records: OperationRecords;
}

export interface PastePageCallbacks {
  onRecordsChange?(records: OperationRecords): void;
  onSummaryChange?(summary: PasteSummary | null): void;
  onTerminal?(handoff: TerminalHandoff): void;
  onRootHandoff?(): void;
}

export interface PastePageActions {
  sourceEvent(event: SourceEvent): void;
  activity(eventAt: number, kind?: "recovery-credential"): void;
  draftState(owner: "settings" | "password", dirty: boolean, eventAt?: number): void;
  autosaveInput(content: string, eventAt: number): void;
  compositionStart(): void;
  compositionEnd(content: string, eventAt: number): void;
  retry(credential: string | null): void;
  reconcile(): void;
  overwrite(): void;
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
  retrySync(credential: string | null): void;
  retryPreview(): void;
  retryVisual(): void;
  retryDiff(): void;
  setSurfaceMounted(surface: DerivedSurface, mounted: boolean): void;
  localAction(action: {
    key: "copy" | "download";
    state: "pending" | "succeeded" | "failed";
    attempt: number;
    startedAt: string;
    settledAt?: string;
  }): void;
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
  derivedSource: string;
  derivedGeneration: number;
  derivedPreview: MarkdownPreview | null;
  derivedVisual: PreparedMarkdownVisual | null;
  derivedFallback: SurfaceFallbackState | null;
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
type LocalWorkOwner = "content" | "settings" | "password";
type Candidate = {
  kind: "remote" | "terminal" | "forbidden";
  snapshot?: RemoteSnapshot;
  source: string;
  capture?: PasteSyncCapture;
  baseline?: BaselineCapture;
  ordinaryTokenCurrent?: boolean;
  terminalDisplay?: "ready" | "failed";
  terminalPreview?: MarkdownPreview | null;
  terminalFallback?: SurfaceFallbackState | null;
};
type PendingRemoteApply = {
  mode: "autosync" | "candidate";
  attempt: RemoteApplyAttempt;
  capture: PasteSyncCapture;
  candidate: Candidate | null;
  action: { attempt: number; startedAt: string } | null;
};

type DerivedResources = {
  preview: unknown;
  visual: unknown;
  diff: unknown;
  generation: number;
};

type Runtime = {
  api: PasteApi;
  paste: PasteController;
  autosave: AutosaveController;
  sync: PasteSync;
  history: HistoryController;
  historyDiff: HistoryDiffController;
  surface: StagedSurfaceApply;
  mountedSurfaces: Set<DerivedSurface>;
  derivedResources: DerivedResources | null;
  previousDerivedResources: DerivedResources | null;
  records: OperationRecords;
  activeUntil: number;
  validator: `"sha256-${string}"` | null;
  candidate: Candidate | null;
  pendingRemoteApply: PendingRemoteApply | null;
  useRemoteAction: { attempt: number; startedAt: string } | null;
  reloadAction: { attempt: number; startedAt: string } | null;
  composing: boolean;
  disposed: boolean;
  terminalSignalled: boolean;
  requestControllers: Set<AbortController>;
  lastIntent: MutationIntent | null;
  suppressedRecovery: { key: ActionKey; attempt: number } | null;
  reloadToken: number;
  reloadController: AbortController | null;
  diff: HistoryDiffState;
  dirtyDraftOwners: Set<LocalWorkOwner>;
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

function locallyClean(runtime: Runtime): boolean {
  const save = runtime.autosave.snapshot();
  return runtime.dirtyDraftOwners.size === 0 && save.draft === save.acceptedSource && save.inFlightContent === null && save.dueAt === null;
}

function markLocalWorkChanged(runtime: Runtime, owner: LocalWorkOwner): boolean {
  if (runtime.dirtyDraftOwners.has(owner)) return false;
  runtime.dirtyDraftOwners.add(owner);
  runtime.sync.localWorkChanged();
  return true;
}

function settleLocalWork(runtime: Runtime, owner: LocalWorkOwner): boolean {
  if (!runtime.dirtyDraftOwners.delete(owner)) return false;
  if (locallyClean(runtime)) runtime.sync.localWorkSettled(now());
  return true;
}

function settleLocalWorkIfClean(runtime: Runtime): void {
  if (locallyClean(runtime)) runtime.sync.localWorkSettled(now());
}

function mutationOwner(snapshot: Readonly<PasteControllerSnapshot>): LocalWorkOwner | null {
  if (!active(snapshot) || snapshot.mutation.state === "idle") return null;
  if (snapshot.mutation.state === "content-reconciliation") return "content";
  const intent = snapshot.mutation.intent;
  if (intent.kind === "content") return "content";
  if (intent.kind === "settings-title" || intent.kind === "settings-format" || intent.kind === "settings-expiration" || intent.kind === "settings-view-once") return "settings";
  if (intent.kind === "password-set" || intent.kind === "password-clear") return "password";
  return null;
}

function isMarkdownPreview(value: unknown): value is MarkdownPreview {
  return typeof value === "object" && value !== null
    && "source" in value && typeof value.source === "string"
    && "html" in value && typeof value.html === "string";
}

function isPreparedMarkdownVisual(value: unknown): value is PreparedMarkdownVisual {
  return typeof HTMLElement !== "undefined" && typeof value === "object" && value !== null
    && "root" in value && value.root instanceof HTMLElement
    && "source" in value && typeof value.source === "object" && value.source !== null
    && "dispose" in value && typeof value.dispose === "function";
}

function isStagedHistoryDiff(value: unknown): value is StagedHistoryDiff {
  return typeof value === "object" && value !== null
    && "id" in value && typeof value.id === "number"
    && "previous" in value && typeof value.previous === "string"
    && "current" in value && typeof value.current === "string"
    && "lines" in value && Array.isArray(value.lines);
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

function sameSummary(left: PasteSummary, right: PasteSummary): boolean {
  return left.id === right.id
    && left.title === right.title
    && left.format === right.format
    && left.viewOnce === right.viewOnce
    && left.protected === right.protected
    && left.createdAt === right.createdAt
    && left.updatedAt === right.updatedAt
    && left.expiresAt === right.expiresAt
    && left.expiration.kind === right.expiration.kind
    && (left.expiration.kind !== "relative" || right.expiration.kind !== "relative" || left.expiration.seconds === right.expiration.seconds)
    && left.version === right.version
    && left.contentRevision === right.contentRevision
    && left.contentBytes === right.contentBytes
    && left.createdCountry === right.createdCountry
    && left.links.view === right.links.view
    && left.links.raw === right.links.raw
    && left.links.html === right.links.html
    && left.links.markdown === right.links.markdown
    && left.links.file === right.links.file;
}

function sameResourceIdentity(remote: RemoteSnapshot, current: ActiveSnapshot): boolean {
  return remote.etag === current.responseEtag
    && remote.source === current.acceptedSource
    && remote.summary.version === current.version
    && remote.contentRevision === current.contentRevision
    && remote.summary.updatedAt === current.updatedAt
    && sameSummary(remote.summary, current.summary);
}

function mutationFlag(value: boolean | null | undefined): {} | { mutationMayHaveApplied: boolean } {
  return typeof value === "boolean" ? { mutationMayHaveApplied: value } : {};
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
  return { status: result.failure.status ?? 0, ...(result.failure.kind === "network" ? { transport: "network" as const } : {}) };
}

function cloneIntentWithCredential(intent: MutationIntent, credential: string | null): MutationIntent {
  switch (intent.kind) {
    case "password-set": return { ...intent, authorizationPassword: credential };
    case "password-clear": return { ...intent, authorizationPassword: credential };
    case "delete": return { ...intent, authorizationPassword: credential };
    default: return intent;
  }
}

function intentOwner(intent: MutationIntent): LocalWorkOwner {
  if (intent.kind === "content") return "content";
  if (intent.kind === "password-set" || intent.kind === "password-clear") return "password";
  return "settings";
}

function actionBelongsToOwner(key: ActionKey, owner: LocalWorkOwner): boolean {
  if (owner === "content") return key === "autosave" || key === "manual-save" || key === "save-retry" || key === "overwrite" || key === "content-reconcile";
  if (owner === "password") return key === "password-set" || key === "password-clear" || key === "password-reconcile";
  return key === "settings-title" || key === "settings-format" || key === "settings-expiration" || key === "settings-view-once" || key === "settings-reconcile";
}

function statusFor(lastAction: LastAction, keys: readonly ActionKey[], snapshot: ActiveSnapshot, suppressedRecovery: { key: ActionKey; attempt: number } | null): "idle" | "pending" | "succeeded" | "validation-error" | "credential-required" | "conflict" | "retryable" | "reconciliation-required" {
  if (lastAction.state !== "idle" && suppressedRecovery?.key === lastAction.key && suppressedRecovery.attempt === lastAction.attempt) return "idle";
  if (snapshot.reconciliationRequired) return "reconciliation-required";
  if (lastAction.state === "idle" || !keys.includes(lastAction.key)) return "idle";
  if (lastAction.state === "pending") return "pending";
  if (lastAction.state === "succeeded") return "succeeded";
  if (snapshot.originalMutationFailure?.status === 403 || snapshot.autosave.state === "password-required") return "credential-required";
  if (snapshot.originalMutationFailure?.status === 413 || snapshot.originalMutationFailure?.status === 422) return "validation-error";
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

function replaceHistoryCurrent(runtime: Runtime, source: string): void {
  const state = runtime.historyDiff.replaceCurrent(source);
  if (state !== "unchanged" && state !== "failed") runtime.diff = { state, lines: [] };
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
    mutationPending: false,
    result: { field: null, state: "idle", message: null },
  };
  return {
    paste: { ...accepted, resource: "active", lastSavedContent: accepted.acceptedSource, mutation: { state: "idle", nextToken: 0 }, coalescedSource: null, phase: "ordinary", credential: { committed: initialPage.password, pending: null }, autosave: { state: "clean", confirmedAt: null, failedAt: null }, lastAction: { state: "idle" }, conflictCandidate: null, terminalResponseSource: null, terminalOrigin: null, originalMutationFailure: null, reconciliationRequired: false, reconciliation: { owner: null, requestPending: false }, serverCapabilities: true },
    autosave,
    records: initialRecords(),
    history: emptyHistory(),
    settings,
    password: { protected: accepted.summary.protected, versionUsable: true, mutationPending: false, result: { action: null, state: "idle", message: null }, currentUrl: location.href, representations: [] },
    deleteFlow: { phase: "ordinary", result: { state: "idle", message: null }, mutationPending: false, versionUsable: true },
    candidate: null,
    source: accepted.draft,
    acceptedSource: accepted.acceptedSource,
    version: accepted.version,
    autosaveAcceptedSource: accepted.acceptedSource,
    lastSavedContent: accepted.acceptedSource,
    derivedSource: accepted.acceptedSource,
    derivedGeneration: accepted.displayGeneration,
    derivedPreview: null,
    derivedVisual: null,
    derivedFallback: null,
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
    const surface = runtime.surface.snapshot();
    const derivedSource = surface.status === "staging" ? surface.source : paste.draft;
    const derivedGeneration = surface.status === "staging"
      ? surface.capture.currentDisplayGeneration
      : active(paste) ? paste.displayGeneration : surface.capture.currentDisplayGeneration;
    const derivedPreview = isMarkdownPreview(runtime.derivedResources?.preview) && runtime.derivedResources.preview.source === surface.source
      ? runtime.derivedResources.preview
      : null;
    const derivedVisual = isPreparedMarkdownVisual(runtime.derivedResources?.visual) && runtime.derivedResources.visual.source.value === surface.source
      ? runtime.derivedResources.visual
      : null;
    const derivedFallback = surface.status === "fallback" && surface.fallback !== null
      ? { surface: surface.fallback, source: surface.source, generation: surface.capture.currentDisplayGeneration }
      : null;
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
        derivedSource,
        derivedGeneration,
        derivedPreview,
        derivedVisual,
        derivedFallback,
      };
    }

    const settingsOwnsReconciliation = paste.reconciliation.owner === "title" || paste.reconciliation.owner === "format" || paste.reconciliation.owner === "expiration" || paste.reconciliation.owner === "viewOnce";
    const passwordOwnsReconciliation = paste.reconciliation.owner === "password";
    const settingsState = paste.reconciliationRequired
      ? settingsOwnsReconciliation ? "reconciliation-required" : "idle"
      : statusFor(paste.lastAction, ["settings-title", "settings-format", "settings-expiration", "settings-view-once", "settings-reconcile"], paste, runtime.suppressedRecovery);
    const passwordState = paste.reconciliationRequired
      ? passwordOwnsReconciliation ? "reconciliation-required" : "idle"
      : statusFor(paste.lastAction, ["password-set", "password-clear", "password-reconcile"], paste, runtime.suppressedRecovery);
    const deleteState = statusFor(paste.lastAction, ["delete"], paste, runtime.suppressedRecovery);
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
        mutationPending: paste.lastAction.state === "pending",
        mutationOccupied: paste.mutation.state !== "idle",
        reconciliationOwner: paste.reconciliation.owner,
        reconciliationRequestPending: paste.reconciliation.requestPending,
        resultIdentity: paste.lastAction,
        result: {
          field: settingsState === "idle" ? null : settingsState === "reconciliation-required" && settingsOwnsReconciliation ? paste.reconciliation.owner : lastActionKey === "settings-format" ? "format" : lastActionKey === "settings-expiration" ? "expiration" : lastActionKey === "settings-view-once" ? "viewOnce" : "title",
          state: settingsState,
          message: null,
          ...(settingsState === "reconciliation-required" && paste.mutation.state === "metadata-reconciliation" && paste.mutation.intent.kind === "settings-expiration" && typeof paste.mutation.intent.expiration === "number" ? { reconciliationIntent: "relative" as const } : {}),
        } as SettingsPanelState["result"],
      },
      password: {
        protected: paste.summary.protected,
        versionUsable: paste.versionUsable,
        mutationPending: paste.lastAction.state === "pending",
        mutationOccupied: paste.mutation.state !== "idle",
        reconciliationOwner: paste.reconciliation.owner,
        reconciliationRequestPending: paste.reconciliation.requestPending,
        resultIdentity: paste.lastAction,
        result: { action: passwordAction, state: passwordState, message: null },
        currentUrl: location.href,
        representations: [
          { label: "Raw", href: withPastePassword(new URL(paste.summary.links.raw, location.href), paste.credential.committed).toString() },
          { label: "HTML", href: withPastePassword(new URL(paste.summary.links.html, location.href), paste.credential.committed).toString() },
          { label: "Markdown", href: withPastePassword(new URL(paste.summary.links.markdown, location.href), paste.credential.committed).toString() },
          { label: "File", href: withPastePassword(new URL(paste.summary.links.file, location.href), paste.credential.committed).toString() },
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
      derivedSource,
      derivedGeneration,
      derivedPreview,
      derivedVisual,
      derivedFallback,
    };
  // The empty dependency keeps a single coordinator closure for a mounted paste.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const publish = React.useCallback((runtime: Runtime | null = runtimeRef.current) => {
    if (runtime === null || runtime.disposed) return;
    const next = makeView(runtime);
    setView(next);
    callbacksRef.current.onRecordsChange?.(next.records);
    callbacksRef.current.onSummaryChange?.(active(next.paste) ? next.paste.summary : null);
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

  function updateNetworkRecord(runtime: Runtime, state: "online" | "offline" | "degraded"): void {
    if (runtime.records.network.state === state) return;
    runtime.records = { ...runtime.records, network: { state, changedAt: displayTime() } };
  }

  function updateSyncRecord(runtime: Runtime, event: PasteSyncEvent): void {
    const instant = displayTime();
    const current = runtime.records.autosync;
    switch (event.type) {
      case "state":
        runtime.records = { ...runtime.records, autosync: { ...current, state: event.state, stateChangedAt: event.at === null ? null : instant } };
        return;
      case "unchanged":
        if (navigator.onLine !== false) updateNetworkRecord(runtime, "online");
        runtime.validator = event.etag;
        runtime.records = { ...runtime.records, autosync: { ...current, state: "unchanged", checkedAt: instant } };
        return;
      case "candidate":
      case "proven-newer":
        if (navigator.onLine !== false) updateNetworkRecord(runtime, "online");
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
        if (event.transport === "network" && navigator.onLine !== false) updateNetworkRecord(runtime, "degraded");
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
      locallyClean: locallyClean(runtime),
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
    cancelPendingRemoteApply(runtime, "terminal");
    if (runtime.reloadAction !== null) {
      runtime.reloadToken += 1;
      runtime.reloadController?.abort();
      runtime.reloadController = null;
      settleReloadAction(runtime, "failed");
    }
    runtime.disposed = true;
    if (isPreparedMarkdownVisual(runtime.derivedResources?.visual)) void runtime.derivedResources.visual.dispose();
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
    if (runtime.reloadController === controller) runtime.reloadController = null;
    return runtime.requestControllers.delete(controller) && !runtime.disposed && runtimeRef.current === runtime;
  }

  function clearExpiringCandidate(runtime: Runtime): void {
    if (runtime.candidate === null || runtime.candidate.kind === "terminal") return;
    runtime.candidate = null;
    settleUseRemoteAction(runtime, "failed");
  }

  function settleUseRemoteAction(runtime: Runtime, state: "succeeded" | "failed", expected?: { attempt: number }): void {
    const action = runtime.useRemoteAction;
    if (action === null || (expected !== undefined && action.attempt !== expected.attempt)) return;
    runtime.useRemoteAction = null;
    runtime.paste.recordLocalAction({ key: "use-remote", state, attempt: action.attempt, startedAt: action.startedAt, settledAt: displayTime() });
  }

  function cancelPendingRemoteApply(runtime: Runtime, reason: "local" | "offline" | "surface" | "deadline" | "terminal" | "authoritative"): boolean {
    const pending = runtime.pendingRemoteApply;
    if (pending === null) return false;

    runtime.surface.invalidate();
    const restored = reason === "surface" && runtime.sync.cancelRemoteApply(pending.attempt, now());
    const retired = restored || runtime.sync.retireRemoteApply(pending.attempt, now());
    if (pending.mode === "candidate") {
      runtime.candidate = restored ? pending.candidate : null;
      if (pending.action !== null) settleUseRemoteAction(runtime, "failed", pending.action);
    }
    runtime.pendingRemoteApply = null;
    return retired;
  }

  function settleReloadAction(runtime: Runtime, state: "succeeded" | "failed"): void {
    const action = runtime.reloadAction;
    if (action === null) return;
    runtime.reloadAction = null;
    runtime.paste.recordLocalAction({ key: "reload-server", state, attempt: action.attempt, startedAt: action.startedAt, settledAt: displayTime() });
  }

  function scheduleSyncRetry(runtime: Runtime, credential: string | null): void {
    const snapshot = runtime.paste.snapshot();
    const attempt = snapshot.lastAction.state === "idle" ? 1 : snapshot.lastAction.attempt + 1;
    const startedAt = displayTime();
    runtime.paste.recordLocalAction({ key: "retry-sync", state: "pending", attempt, startedAt });
    const state = active(snapshot) && runtime.sync.retrySync(now(), credential) ? "succeeded" : "failed";
    runtime.paste.recordLocalAction({ key: "retry-sync", state, attempt, startedAt, settledAt: displayTime() });
  }

  function completeTerminal(runtime: Runtime, page: TerminalPage): void {
    if (runtime.disposed || runtime.terminalSignalled) return;
    runtime.terminalSignalled = true;
    callbacksRef.current.onTerminal?.({
      page,
      records: { ...runtime.records, lastAction: runtime.paste.snapshot().lastAction },
    });
  }

  function terminalPage(phase: TerminalPage["phase"], source: string, currentSource: string, responseSource: string | null, choiceAvailable: boolean, initialMarkdown: TrustedMarkdownHtml | null = source === initial.exactSource ? initial.initialMarkdown : null, fallback: SurfaceFallbackState | null = null): TerminalPage {
    return {
      phase,
      source,
      currentSource,
      responseSource,
      consumedSource: choiceAvailable ? responseSource : null,
      choiceAvailable,
      initialMarkdown,
      fallback,
    };
  }

  function terminalFromEffect(runtime: Runtime, phase: PastePhase): void {
    const snapshot = runtime.paste.snapshot();
    if (!active(snapshot)) return;
    if (phase === "armed-view-once" || phase === "not-found" || phase === "delete-uncertain") {
      completeTerminal(runtime, terminalPage(phase, snapshot.draft, snapshot.draft, null, false));
      return;
    }
    const candidate = runtime.candidate?.kind === "terminal" ? runtime.candidate : null;
    const responseSource = candidate?.source ?? snapshot.terminalResponseSource;
    const terminalBaseline = candidate?.capture?.baseline ?? candidate?.baseline;
    const responseIsDefinitelyNewer = candidate?.snapshot !== undefined
      && terminalBaseline !== undefined
      && candidate.ordinaryTokenCurrent === true
      && classifyRemote(candidate.snapshot, terminalBaseline) === "definitely-newer";
    const currentSource = snapshot.draft;
    let source = currentSource;
    let choiceAvailable = responseSource !== null && responseSource !== currentSource;
    const origin = snapshot.terminalOrigin;
    if (origin?.actionKey === "reload-server") {
      const result = responseSource === currentSource
        ? "current-unchanged"
        : responseIsDefinitelyNewer
          ? candidate?.terminalDisplay === "failed" ? "display-failed" : "displayed"
          : "current-kept-choice";
      if (result === "displayed" && responseSource !== null) {
        source = responseSource;
        choiceAvailable = false;
      }
      const outcome = runtime.surface.settleTerminal(origin, result);
      if (outcome !== null) runtime.paste.settleTerminal(outcome, now());
    } else if (origin?.actionKey === "content-reconcile") {
      const outcome = runtime.surface.settleTerminal(origin, "current-kept-choice");
      if (outcome !== null) runtime.paste.settleTerminal(outcome, now());
    } else if (responseIsDefinitelyNewer && responseSource !== null && candidate?.terminalDisplay !== "failed") {
      source = responseSource;
      choiceAvailable = false;
    }
    const preparedPreview = source === responseSource && isMarkdownPreview(candidate?.terminalPreview)
      ? candidate.terminalPreview.html as TrustedMarkdownHtml
      : undefined;
    completeTerminal(runtime, terminalPage("consumed", source, currentSource, responseSource, choiceAvailable, preparedPreview, candidate?.terminalFallback?.source === source ? candidate.terminalFallback : null));
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
      const before = runtime.paste.snapshot();
      const decoded = result.kind === "snapshot" ? { kind: "snapshot", snapshot: result.snapshot } as const : reconcileFailure(result.kind === "failure" ? result.failure : { kind: "malformed", status: 304, code: "MALFORMED_RESPONSE", mutationMayHaveApplied: false });
      const accepted = runtime.paste.acceptContentReconcile(dispatch.requestToken, decoded, now());
      if (accepted && active(before)) {
        const current = runtime.paste.snapshot();
        if (result.kind === "snapshot" && active(current)) replaceHistoryCurrent(runtime, current.draft);
        retainHistoryAfterAcceptance(runtime, baseline(before));
      }
      if (accepted && result.kind === "snapshot" && navigator.onLine !== false) updateNetworkRecord(runtime, "online");
      if (accepted && result.kind === "failure" && result.failure.kind === "network" && navigator.onLine !== false) updateNetworkRecord(runtime, "degraded");
      drainEffects(runtime);
      publish(runtime);
    }, () => {
      if (!settleRequest(runtime, controller)) return;
      const accepted = runtime.paste.acceptContentReconcile(dispatch.requestToken, { kind: "network" }, now());
      if (accepted && navigator.onLine !== false) updateNetworkRecord(runtime, "degraded");
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
      const before = runtime.paste.snapshot();
      const accepted = runtime.paste.acceptMetadataReconcile(dispatch.requestToken, result.ok ? { kind: "summary", summary: result.value } : reconcileFailure(result.failure), now());
      if (accepted && active(before)) retainHistoryAfterAcceptance(runtime, baseline(before));
      if (accepted && result.ok && navigator.onLine !== false) updateNetworkRecord(runtime, "online");
      if (accepted && !result.ok && result.failure.kind === "network" && navigator.onLine !== false) updateNetworkRecord(runtime, "degraded");
      drainEffects(runtime);
      publish(runtime);
    }, () => {
      if (!settleRequest(runtime, controller)) return;
      const accepted = runtime.paste.acceptMetadataReconcile(dispatch.requestToken, { kind: "network" }, now());
      if (accepted && navigator.onLine !== false) updateNetworkRecord(runtime, "degraded");
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
      if (result.ok && navigator.onLine !== false) updateNetworkRecord(runtime, "online");
      if (!result.ok && result.failure.kind === "network" && navigator.onLine !== false) updateNetworkRecord(runtime, "degraded");
      if (dispatch.intent.kind === "delete") {
        runtime.paste.acceptDeleteMutation(dispatch.token, result.ok ? { status: 204 } : { status: result.failure.status, ...mutationFlag(result.failure.mutationMayHaveApplied) }, now());
      } else if (result.ok) {
        const before = runtime.paste.snapshot();
        const accepted = runtime.paste.acceptMetadataMutation(dispatch.token, result.value as import("../contracts").MutationResult, now());
        if (accepted && active(before)) retainHistoryAfterAcceptance(runtime, baseline(before));
      } else {
        runtime.paste.failMutation(dispatch.token, { status: result.failure.status, ...mutationFlag(result.failure.mutationMayHaveApplied) }, now());
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
    runtime.suppressedRecovery = null;
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
        if (navigator.onLine !== false) updateNetworkRecord(runtime, "online");
        const before = runtime.paste.snapshot();
        const accepted = runtime.paste.acceptContentMutation(start.token, result.value, now());
        if (!accepted) return { status: 0, mutationMayHaveApplied: false };
        if (active(before)) {
          const current = runtime.paste.snapshot();
          if (active(current)) replaceHistoryCurrent(runtime, current.draft);
          retainHistoryAfterAcceptance(runtime, baseline(before));
        }
        // Update both controller authorities before the autosave promise publishes a render.
        drainEffects(runtime);
        publish(runtime);
        return { status: 200, changed: result.value.changed, paste: result.value.paste };
      }
      if (result.failure.kind === "network" && navigator.onLine !== false) updateNetworkRecord(runtime, "degraded");
      runtime.paste.failMutation(start.token, { status: result.failure.status, ...mutationFlag(result.failure.mutationMayHaveApplied) }, now());
      drainEffects(runtime);
      publish(runtime);
      return { status: result.failure.status ?? 0, ...mutationFlag(result.failure.mutationMayHaveApplied) };
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
          cancelPendingRemoteApply(runtime, "authoritative");
          clearExpiringCandidate(runtime);
          const snapshot = runtime.paste.snapshot();
          const owner = mutationOwner(snapshot);
          if (owner !== null) markLocalWorkChanged(runtime, owner);
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
            const acknowledged = effect.kind === "content"
              && runtime.autosave.acknowledgeAcceptedContent(effect.acceptedSource!, effect.version!);
            if (!acknowledged) {
              runtime.autosave.applyAuthoritative({
                kind: effect.kind === "content" || effect.kind === "remote" ? "replace" : effect.kind,
                acceptedSource: effect.acceptedSource!,
                version: effect.version!,
              });
            }
            clearExpiringCandidate(runtime);
            const snapshot = runtime.paste.snapshot();
            if (active(snapshot)) {
              runtime.validator = effect.kind === "remote" ? snapshot.responseEtag : null;
              runtime.surface.replaceCapture(surfaceCapture(snapshot));
              if (effect.kind === "content" || effect.kind === "reconciled-applied") settleLocalWork(runtime, "content");
              else if (effect.kind !== "remote") settleLocalWorkIfClean(runtime);
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
          cancelPendingRemoteApply(runtime, "terminal");
          if (runtime.reloadAction !== null) {
            runtime.reloadToken += 1;
            runtime.reloadController?.abort();
            runtime.reloadController = null;
            settleReloadAction(runtime, "failed");
          }
          runtime.autosave.dispose();
          runtime.sync.dispose();
          runtime.history.destroy();
          runtime.historyDiff.destroy();
          runtime.surface.invalidate();
          if (isPreparedMarkdownVisual(runtime.derivedResources?.visual)) void runtime.derivedResources.visual.dispose();
          runtime.derivedResources = null;
          runtime.previousDerivedResources = null;
          for (const request of runtime.requestControllers) request.abort();
          runtime.requestControllers.clear();
          terminalFromEffect(runtime, effect.phase);
          continue;
        }
        if (effect.type === "root-handoff") {
          cancelPendingRemoteApply(runtime, "terminal");
          if (runtime.reloadAction !== null) {
            runtime.reloadToken += 1;
            runtime.reloadController?.abort();
            runtime.reloadController = null;
            settleReloadAction(runtime, "failed");
          }
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
    runtime.suppressedRecovery = null;
    cancelPendingRemoteApply(runtime, "authoritative");
    clearExpiringCandidate(runtime);
    runtime.surface.invalidate();
    drainEffects(runtime);
    dispatchMutation(runtime, start);
    publish(runtime);
  }

  function openHistory(runtime: Runtime): void {
    const snapshot = runtime.paste.snapshot();
    if (!active(snapshot) || snapshot.phase !== "ordinary" || snapshot.mutation.state !== "idle") return;
    const capture = baseline(snapshot);
    const request = runtime.history.open(capture);
    const startedAt = displayTime();
    runtime.paste.recordLocalAction({ key: "history-list", state: "pending", attempt: request.token, startedAt });
    void runtime.api.listHistory({ id: snapshot.summary.id, password: snapshot.credential.pending ?? snapshot.credential.committed, signal: request.signal }).then((result) => {
      if (runtime.disposed || runtimeRef.current !== runtime) return;
      const accepted = result.ok
        ? runtime.history.acceptList(request.token, capture, result.value)
        : runtime.history.failList(request.token, capture, { status: result.failure.status, code: result.failure.code });
      if (accepted) runtime.paste.recordLocalAction({ key: "history-list", state: result.ok ? "succeeded" : "failed", attempt: request.token, startedAt, settledAt: displayTime() });
      if (accepted && result.ok && navigator.onLine !== false) updateNetworkRecord(runtime, "online");
      if (accepted && !result.ok && result.failure.kind === "network" && navigator.onLine !== false) updateNetworkRecord(runtime, "degraded");
      publish(runtime);
    }, () => {
      if (runtime.disposed || runtimeRef.current !== runtime) return;
      const accepted = runtime.history.failList(request.token, capture, { status: null, code: "NETWORK_ERROR" });
      if (accepted) runtime.paste.recordLocalAction({ key: "history-list", state: "failed", attempt: request.token, startedAt, settledAt: displayTime() });
      if (accepted && navigator.onLine !== false) updateNetworkRecord(runtime, "degraded");
      publish(runtime);
    });
    publish(runtime);
  }

  function selectHistory(runtime: Runtime, revision: number): void {
    const snapshot = runtime.paste.snapshot();
    if (!active(snapshot) || snapshot.phase !== "ordinary" || snapshot.mutation.state !== "idle") return;
    const capture = baseline(snapshot);
    const request = runtime.history.select(revision, capture);
    const startedAt = displayTime();
    runtime.paste.recordLocalAction({ key: "history-snapshot", state: "pending", attempt: request.token, startedAt });
    void runtime.api.getHistory({ id: snapshot.summary.id, revision, password: snapshot.credential.pending ?? snapshot.credential.committed, signal: request.signal }).then((result) => {
      if (runtime.disposed || runtimeRef.current !== runtime) return;
      const accepted = result.ok
        ? runtime.history.acceptSnapshot(request.token, capture, result.value)
        : runtime.history.failSnapshot(request.token, capture, { status: result.failure.status, code: result.failure.code });
      if (accepted) runtime.paste.recordLocalAction({ key: "history-snapshot", state: result.ok ? "succeeded" : "failed", attempt: request.token, startedAt, settledAt: displayTime() });
      if (accepted && result.ok) {
        const current = runtime.paste.snapshot();
        if (active(current)) {
          runtime.diff = { state: "idle", lines: [] };
          const mode = runtime.historyDiff.selectRevision(revision, result.value.content, current.draft);
          if (runtime.diff.state !== "failed") runtime.diff = { state: mode === "automatic" ? "computing" : "manual", lines: [] };
        }
        if (navigator.onLine !== false) updateNetworkRecord(runtime, "online");
      }
      if (accepted && !result.ok && result.failure.kind === "network" && navigator.onLine !== false) updateNetworkRecord(runtime, "degraded");
      publish(runtime);
    }, () => {
      if (runtime.disposed || runtimeRef.current !== runtime) return;
      const accepted = runtime.history.failSnapshot(request.token, capture, { status: null, code: "NETWORK_ERROR" });
      if (accepted) runtime.paste.recordLocalAction({ key: "history-snapshot", state: "failed", attempt: request.token, startedAt, settledAt: displayTime() });
      if (accepted && navigator.onLine !== false) updateNetworkRecord(runtime, "degraded");
      publish(runtime);
    });
    publish(runtime);
  }

  function retainHistoryAfterAcceptance(runtime: Runtime, previous: BaselineCapture): void {
    const current = runtime.paste.snapshot();
    if (active(current)) runtime.history.retainAfterApply(previous, baseline(current));
  }

  function applyRemoteSnapshot(runtime: Runtime, remote: RemoteSnapshot, attempt?: RemoteApplyAttempt): boolean {
    const previous = runtime.paste.snapshot();
    if (!active(previous) || runtime.disposed || runtimeRef.current !== runtime) return false;
    if (attempt !== undefined && !runtime.sync.isRemoteApplyCurrent(attempt)) return false;
    if (!runtime.paste.applyRemoteSnapshot(remote)) return false;

    const current = runtime.paste.snapshot() as ActiveSnapshot;
    replaceHistoryCurrent(runtime, current.draft);
    runtime.history.retainAfterApply(baseline(previous), baseline(current));
    runtime.validator = remote.etag;
    settleUseRemoteAction(runtime, "succeeded");
    runtime.candidate = null;
    if (attempt !== undefined) {
      drainEffects(runtime);
      runtime.sync.completeRemoteApply(attempt, now());
      runtime.records = { ...runtime.records, autosync: { ...runtime.records.autosync, state: "remote-applied", appliedAt: displayTime() } };
    } else {
      settleLocalWork(runtime, "content");
      drainEffects(runtime);
    }
    publish(runtime);
    return true;
  }

  async function applyRemote(runtime: Runtime, remote: RemoteSnapshot, mode: "autosync" | "candidate", attempt?: RemoteApplyAttempt, originCapture?: PasteSyncCapture, candidateOverride?: Candidate | null): Promise<void> {
    const candidate = mode === "candidate" ? candidateOverride ?? runtime.candidate : null;
    const capture = mode === "candidate" ? candidate?.capture : originCapture;
    if (capture === undefined || attempt === undefined) return;
    const pendingCurrent = (): boolean => {
      const pending = runtime.pendingRemoteApply;
      return pending !== null
        && pending.attempt === attempt
        && pending.mode === mode
        && pending.capture === capture
        && pending.candidate === candidate;
    };
    if (!pendingCurrent()) return;
    const current = (): ActiveSnapshot | null => {
      const snapshot = runtime.paste.snapshot();
      return active(snapshot) ? snapshot : null;
    };
    const commitCurrent = (): boolean => {
      const snapshot = current();
      if (snapshot === null || runtime.disposed || runtimeRef.current !== runtime || !pendingCurrent()) return false;
      const save = runtime.autosave.snapshot();
      const captureNow = captureForSync(runtime);
      const baselineCurrent = sameBaseline(capture.baseline, baseline(snapshot));
      const localGenerationCurrent = capture.localGeneration === snapshot.localGeneration;
      const activeCurrent = now() < capture.activeUntil && captureNow.activeUntil === capture.activeUntil;
      const shared = runtime.sync.isRemoteApplyCurrent(attempt)
        && captureNow.offline === false
        && baselineCurrent
        && localGenerationCurrent
        && snapshot.phase === "ordinary"
        && activeCurrent
        && !runtime.composing
        && save.dueAt === null
        && save.inFlightContent === null
        && !save.coalescedIntent
        && snapshot.mutation.state === "idle"
        && !snapshot.reconciliationRequired;
      if (mode === "autosync") return shared && save.draft === save.acceptedSource;
      return shared
        && candidate?.snapshot === remote
        && save.draft === save.acceptedSource;
    };
    const snapshot = current();
    if (snapshot === null) return;
    const save = runtime.autosave.snapshot();
    const baselineCurrent = sameBaseline(capture.baseline, baseline(snapshot));
    const localGenerationCurrent = capture.localGeneration === snapshot.localGeneration;
    const activeCurrent = now() < capture.activeUntil && runtime.activeUntil === capture.activeUntil;
    const schedulerCurrent = runtime.sync.isRemoteApplyCurrent(attempt);
    const applied = mode === "autosync"
      ? await runtime.surface.applyAutosync(remote.source, {
        requestCurrent: pendingCurrent() && schedulerCurrent,
        acceptedBaselineCurrent: baselineCurrent,
        localGenerationCurrent,
        active: activeCurrent,
        activeUntil: capture.activeUntil,
        composing: runtime.composing,
        autosaveTimer: save.dueAt !== null,
        autosaveInFlight: save.inFlightContent !== null,
        coalescedIntent: save.coalescedIntent,
        mutationOccupied: snapshot.mutation.state !== "idle",
        unresolvedMutation: snapshot.reconciliationRequired,
        localSourceWork: save.draft !== save.acceptedSource,
        commitCurrent,
      })
      : await runtime.surface.applyUseRemote(remote.source, {
        candidateCurrent: pendingCurrent() && schedulerCurrent && candidate?.snapshot === remote,
        acceptedBaselineCurrent: baselineCurrent,
        localGenerationCurrent,
        ordinary: snapshot.phase === "ordinary",
        active: activeCurrent,
        activeDeadlineCurrent: runtime.activeUntil === capture.activeUntil,
        activeUntil: capture.activeUntil,
        draftMatchesAccepted: save.draft === save.acceptedSource,
        composing: runtime.composing,
        autosaveTimer: save.dueAt !== null,
        autosaveInFlight: save.inFlightContent !== null,
        coalescedIntent: save.coalescedIntent,
        mutationOccupied: snapshot.mutation.state !== "idle",
        unresolvedMutation: snapshot.reconciliationRequired,
        conflictCausedByCandidate: candidate !== null,
        commitCurrent,
      });
    if (runtime.disposed || runtimeRef.current !== runtime || !pendingCurrent()) return;
    if (applied && commitCurrent() && applyRemoteSnapshot(runtime, remote, attempt)) {
      runtime.pendingRemoteApply = null;
      return;
    }
    const latest = runtime.paste.snapshot();
    const invalidated = !active(latest)
      || now() >= capture.activeUntil
      || navigator.onLine === false
      || latest.localGeneration !== capture.localGeneration
      || !sameBaseline(capture.baseline, baseline(latest));
    cancelPendingRemoteApply(runtime, invalidated ? now() >= capture.activeUntil ? "deadline" : navigator.onLine === false ? "offline" : "local" : "surface");
    publish(runtime);
  }

  function handleSyncEvent(runtime: Runtime, event: PasteSyncEvent): void {
    if (runtime.disposed || runtimeRef.current !== runtime) return;
    if (event.type === "remote-apply-invalidated") {
      cancelPendingRemoteApply(runtime, "deadline");
      return;
    }
    updateSyncRecord(runtime, event);
    if (event.type === "terminal-view-once" && navigator.onLine !== false) updateNetworkRecord(runtime, "online");
    if (event.type === "state" && event.state === "inactive") {
      runtime.candidate = null;
      settleUseRemoteAction(runtime, "failed");
    }
    if (event.type === "credential-proved") {
      runtime.paste.setPendingCredential(event.password);
      runtime.paste.commitProvenCredential(event.password);
      drainEffects(runtime);
    } else if (event.type === "candidate") {
      runtime.candidate = { kind: "remote", source: event.snapshot.source, snapshot: event.snapshot, capture: event.capture };
    } else if (event.type === "proven-newer") {
      cancelPendingRemoteApply(runtime, "authoritative");
      runtime.pendingRemoteApply = { mode: "autosync", attempt: event.attempt, capture: event.capture, candidate: null, action: null };
      void applyRemote(runtime, event.snapshot, "autosync", event.attempt, event.capture);
    } else if (event.type === "terminal-view-once") {
      const current = (): boolean => {
        const snapshot = runtime.paste.snapshot();
        return event.ordinaryTokenCurrent
          && !runtime.disposed
          && runtimeRef.current === runtime
          && active(snapshot)
          && snapshot.phase === "ordinary"
          && snapshot.mutation.state === "idle"
          && snapshot.draft === snapshot.acceptedSource
          && snapshot.localGeneration === event.capture.localGeneration
          && sameBaseline(event.capture.baseline, baseline(snapshot))
          && now() < event.capture.activeUntil;
      };
      const enter = (ordinaryTokenCurrent: boolean, terminalDisplay?: Candidate["terminalDisplay"], terminalFallback: SurfaceFallbackState | null = null): void => {
        if (runtime.disposed || runtimeRef.current !== runtime) return;
        cancelPendingRemoteApply(runtime, "terminal");
        runtime.candidate = {
          kind: "terminal",
          source: event.snapshot.source,
          snapshot: event.snapshot,
          capture: event.capture,
          ordinaryTokenCurrent,
          ...(terminalDisplay === undefined ? {} : { terminalDisplay }),
          ...(terminalFallback === null ? {} : { terminalFallback }),
        };
        runtime.paste.enterTerminal("consumed", now());
        drainEffects(runtime);
        publish(runtime);
      };
      const automaticallySelected = current()
        && event.snapshot.source !== event.capture.baseline.acceptedSource
        && classifyRemote(event.snapshot, event.capture.baseline) === "definitely-newer";
      const mounted = Array.from(runtime.mountedSurfaces);
      const terminalFallback = automaticallySelected && mounted.length > 0
        ? { surface: mounted[0]!, source: event.snapshot.source, generation: (runtime.paste.snapshot() as ActiveSnapshot).displayGeneration + 1 }
        : null;
      enter(event.ordinaryTokenCurrent, automaticallySelected ? terminalFallback === null ? "ready" : "failed" : undefined, terminalFallback);
      return;
    } else if (event.type === "forbidden") {
      runtime.candidate = { kind: "forbidden", source: "" };
    } else if (event.type === "not-found") {
      runtime.paste.enterTerminal("not-found", now());
      drainEffects(runtime);
    }
    publish(runtime);
  }

  function createRuntime(accepted: AcceptedPasteState, credential: { committed: string | null; pending: string | null }, loadAt: number, api: PasteApi | null = null, carriedRecords: OperationRecords | null = null): Runtime {
    const runtime = {} as Runtime;
    runtime.api = api ?? createPasteApi({ fetch: globalThis.fetch, crypto: globalThis.crypto });
    runtime.records = carriedRecords ?? initialRecords();
    runtime.activeUntil = loadAt + 300_000;
    runtime.validator = accepted.responseEtag;
    runtime.candidate = null;
    runtime.pendingRemoteApply = null;
    runtime.useRemoteAction = null;
    runtime.reloadAction = null;
    runtime.composing = false;
    runtime.disposed = false;
    runtime.terminalSignalled = false;
    runtime.requestControllers = new Set();
    runtime.lastIntent = null;
    runtime.suppressedRecovery = null;
    runtime.reloadToken = 0;
    runtime.reloadController = null;
    runtime.mountedSurfaces = new Set();
    runtime.derivedResources = null;
    runtime.previousDerivedResources = null;
    runtime.diff = { state: "idle", lines: [] };
    runtime.dirtyDraftOwners = new Set();
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
        stagePreview: (source) => prepareMarkdownPreview(source),
        stageVisual: async (source, generation) => {
          const visual = await prepareMarkdownVisual(source, document);
          visual.root.dataset.stagedVisual = String(generation);
          return visual;
        },
        stageDiff: (source) => runtime.historyDiff.stageCurrent(source),
        mounted: () => Array.from(runtime.mountedSurfaces),
        commit: (staged, generation) => {
          const previous = runtime.derivedResources;
          runtime.previousDerivedResources = previous;
          runtime.derivedResources = { ...staged, generation };
          if (isStagedHistoryDiff(staged.diff) && runtime.historyDiff.adoptStaged(staged.diff)) {
            runtime.diff = { state: "ready", lines: staged.diff.lines };
          } else if (staged.diff === null) {
            runtime.diff = { state: "manual", lines: [] };
          } else if (staged.diff !== undefined) {
            runtime.diff = { state: "failed", lines: [], error: "Unable to calculate diff" };
          }
          if (
            isPreparedMarkdownVisual(previous?.visual)
            && previous.visual !== staged.visual
            && !previous.visual.root.isConnected
          ) {
            void previous.visual.dispose();
          }
        },
        restoreOld: async (generation) => {
          const previous = runtime.derivedResources?.generation === generation
            ? runtime.derivedResources
            : runtime.previousDerivedResources?.generation === generation
              ? runtime.previousDerivedResources
              : null;
          if (previous === null) return false;
          runtime.derivedResources = previous;
          return true;
        },
        showOldGenerationFailure: (generation, source) => {
          runtime.derivedResources = {
            preview: { kind: "fallback", surface: "preview", source, generation },
            visual: { kind: "fallback", surface: "visual", source, generation },
            diff: { kind: "fallback", surface: "diff", source, generation },
            generation,
          };
          if (runtime.mountedSurfaces.has("diff")) runtime.diff = { state: "failed", lines: [], error: "Unable to calculate diff" };
          queuePublish();
        },
        disposeAttemptResources: (attempt) => {
          const staged = (attempt as { staged?: Record<string, unknown> }).staged;
          if (isPreparedMarkdownVisual(staged?.visual)) void staged.visual.dispose();
        },
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
      onCoalescedIntent: () => markLocalWorkChanged(runtime, "content"),
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
    const loadAt = now();
    const runtime = createRuntime(acceptedFrom(initial), { committed: initial.password, pending: null }, loadAt);
    runtimeRef.current = runtime;
    runtime.sync.start(loadAt);
    publish(runtime);
    const online = () => {
      updateNetworkRecord(runtime, "online");
      runtime.sync.setOnline(true, now());
      publish(runtime);
    };
    const offline = () => {
      updateNetworkRecord(runtime, "offline");
      cancelPendingRemoteApply(runtime, "offline");
      clearExpiringCandidate(runtime);
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
      const snapshot = runtime.paste.snapshot();
      if (active(snapshot)) replaceHistoryCurrent(runtime, snapshot.draft);
      cancelPendingRemoteApply(runtime, "local");
      clearExpiringCandidate(runtime);
      runtime.surface.invalidate();
      if (event.type !== "composition-start" && event.type !== "composition-input") {
        runtime.activeUntil = event.eventAt + 300_000;
        runtime.sync.recordUserActivity(event.eventAt);
      }
      markLocalWorkChanged(runtime, "content");
      queuePublish();
    },
    activity(eventAt, kind) {
      const runtime = runtimeRef.current;
      if (runtime === null || runtime.disposed) return;
      runtime.paste.recordLocalActivity();
      cancelPendingRemoteApply(runtime, "local");
      runtime.surface.invalidate();
      runtime.activeUntil = eventAt + 300_000;
      runtime.sync.recordUserActivity(eventAt);
      if (kind !== "recovery-credential") {
        clearExpiringCandidate(runtime);
        settleLocalWorkIfClean(runtime);
      }
      publish(runtime);
    },
    draftState(owner, dirty, eventAt) {
      const runtime = runtimeRef.current;
      if (runtime === null || runtime.disposed) return;
      if (dirty) cancelPendingRemoteApply(runtime, "local");
      if (eventAt !== undefined) {
        runtime.paste.recordLocalActivity();
        runtime.surface.invalidate();
        runtime.activeUntil = eventAt + 300_000;
        runtime.sync.recordUserActivity(eventAt);
        clearExpiringCandidate(runtime);
      }
      const changed = dirty ? markLocalWorkChanged(runtime, owner) : settleLocalWork(runtime, owner);
      if (changed) publish(runtime);
    },
    autosaveInput(content, eventAt) {
      const runtime = runtimeRef.current;
      if (runtime === null || runtime.disposed) return;
      runtime.autosave.input(content, eventAt);
      if (runtime.autosave.snapshot().state === "clean") settleLocalWork(runtime, "content");
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
      if (runtime.autosave.snapshot().state === "clean") settleLocalWork(runtime, "content");
    },
    retry(credential) {
      const runtime = runtimeRef.current;
      if (runtime === null || runtime.disposed) return;
      const snapshot = runtime.paste.snapshot();
      if (!active(snapshot)) return;
      runtime.paste.setPendingCredential(credential);
      if (runtime.candidate?.kind === "forbidden") {
        runtime.candidate = null;
        settleUseRemoteAction(runtime, "failed");
        scheduleSyncRetry(runtime, credential);
      } else if (snapshot.mutation.state === "content-reconciliation") {
        dispatchContentReconcile(runtime, runtime.paste.startContentReconcile(now()));
      } else if (snapshot.mutation.state === "metadata-reconciliation") {
        dispatchMetadataReconcile(runtime, runtime.paste.startMetadataReconcile(now()));
      } else if ((runtime.autosave.snapshot().state === "password-required" || runtime.autosave.snapshot().state === "error") && runtime.lastIntent?.kind === "content") {
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
    overwrite() {
      const runtime = runtimeRef.current;
      if (runtime === null || runtime.disposed) return;
      runtime.autosave.overwrite();
      publish(runtime);
    },
    reload() {
      const runtime = runtimeRef.current;
      if (runtime === null || runtime.disposed) return;
      const snapshot = runtime.paste.snapshot();
      if (!active(snapshot) || snapshot.mutation.state !== "idle") return;
      cancelPendingRemoteApply(runtime, "authoritative");
      settleReloadAction(runtime, "failed");
      const token = ++runtime.reloadToken;
      const capture = baseline(snapshot);
      const draft = snapshot.draft;
      const credential = snapshot.credential.pending ?? snapshot.credential.committed;
      const controller = signal(runtime);
      if (controller === null) return;
      runtime.reloadController = controller;
      const startedAt = displayTime();
      runtime.reloadAction = { attempt: token, startedAt };
      runtime.paste.recordLocalAction({ key: "reload-server", state: "pending", attempt: token, startedAt });
      void runtime.api.readResource({ id: snapshot.summary.id, password: credential, ifNoneMatch: null, signal: controller.signal }).then(async (result) => {
        if (!settleRequest(runtime, controller)) return;
        const current = runtime.paste.snapshot();
        const reloadCurrent = (): boolean => {
          const latest = runtime.paste.snapshot();
          return !runtime.disposed
            && runtimeRef.current === runtime
            && token === runtime.reloadToken
            && active(latest)
            && latest.phase === "ordinary"
            && latest.mutation.state === "idle"
            && latest.draft === draft
            && sameBaseline(capture, baseline(latest));
        };
        if (result.kind === "snapshot" && result.snapshot.summary.viewOnce) {
          if (navigator.onLine !== false) updateNetworkRecord(runtime, "online");
          const ordinaryTokenCurrent = reloadCurrent();
          const automaticallySelected = ordinaryTokenCurrent
            && result.snapshot.source !== draft
            && classifyRemote(result.snapshot, capture) === "definitely-newer";
          const mounted = Array.from(runtime.mountedSurfaces);
          const terminalFallback = automaticallySelected && mounted.length > 0
            ? { surface: mounted[0]!, source: result.snapshot.source, generation: (runtime.paste.snapshot() as ActiveSnapshot).displayGeneration + 1 }
            : null;
          runtime.candidate = {
            kind: "terminal",
            source: result.snapshot.source,
            snapshot: result.snapshot,
            baseline: capture,
            ordinaryTokenCurrent,
            ...(automaticallySelected ? { terminalDisplay: terminalFallback === null ? "ready" as const : "failed" as const } : {}),
            ...(terminalFallback === null ? {} : { terminalFallback }),
          };
          if (runtime.reloadAction?.attempt === token) runtime.reloadAction = null;
          runtime.paste.enterTerminal("consumed", now(), { actionKey: "reload-server", actionAttempt: token, startedAt });
          drainEffects(runtime);
          publish(runtime);
          return;
        }
        if (token !== runtime.reloadToken) return;
        if (!active(current) || !sameBaseline(capture, baseline(current)) || current.draft !== draft) {
          settleReloadAction(runtime, "failed");
          publish(runtime);
          return;
        }
        if ((result.kind === "snapshot" || result.kind === "not-modified") && navigator.onLine !== false) updateNetworkRecord(runtime, "online");
        if (result.kind === "failure" && result.failure.kind === "network" && navigator.onLine !== false) updateNetworkRecord(runtime, "degraded");
        if (result.kind === "failure") {
          settleReloadAction(runtime, "failed");
          publish(runtime);
          return;
        }
        if (credential !== null && (result.kind === "snapshot" || result.kind === "not-modified")) {
          runtime.paste.commitProvenCredential(credential);
          drainEffects(runtime);
        }
        if (result.kind !== "snapshot") {
          settleReloadAction(runtime, "succeeded");
          publish(runtime);
          return;
        }
        if (sameResourceIdentity(result.snapshot, current)) {
          settleReloadAction(runtime, "succeeded");
          runtime.records = { ...runtime.records, autosync: { ...runtime.records.autosync, checkedAt: displayTime() } };
          publish(runtime);
          return;
        }
        const applied = await runtime.surface.applyReload(result.snapshot.source, {
          requestCurrent: reloadCurrent(),
          acceptedBaselineCurrent: sameBaseline(capture, baseline(current)),
          draftCurrent: current.draft === draft,
          localGenerationCurrent: capture.localGeneration === current.localGeneration,
          mutationOccupied: current.mutation.state !== "idle",
          terminal: current.phase !== "ordinary",
          commitCurrent: reloadCurrent,
        });
        if (applied && reloadCurrent()) {
          settleReloadAction(runtime, "succeeded");
          if (applyRemoteSnapshot(runtime, result.snapshot)) return;
        }
        settleReloadAction(runtime, "failed");
        publish(runtime);
      }, () => {
        if (!settleRequest(runtime, controller)) return;
        settleReloadAction(runtime, "failed");
        publish(runtime);
      });
      publish(runtime);
    },
    discard() {
      const runtime = runtimeRef.current;
      if (runtime === null || runtime.disposed) return;
      const before = runtime.paste.snapshot();
      const owner = active(before) ? before.reconciliation.owner : null;
      if (owner === null || before.reconciliation.requestPending || !runtime.paste.discardReconciliation()) return;
      const discardedOwner: LocalWorkOwner = owner === "content" ? "content" : owner === "password" ? "password" : "settings";
      if (runtime.lastIntent !== null && intentOwner(runtime.lastIntent) === discardedOwner) runtime.lastIntent = null;
      if (before.lastAction.state !== "idle" && actionBelongsToOwner(before.lastAction.key, discardedOwner)) {
        runtime.suppressedRecovery = { key: before.lastAction.key, attempt: before.lastAction.attempt };
      }
      const snapshot = runtime.paste.snapshot();
      if (owner === "content" && active(snapshot)) {
        runtime.autosave.applyAuthoritative({
          kind: "replace",
          acceptedSource: snapshot.acceptedSource,
          version: snapshot.version,
        });
        replaceHistoryCurrent(runtime, snapshot.draft);
        runtime.surface.replaceCapture(surfaceCapture(snapshot));
        settleLocalWork(runtime, "content");
      }
      drainEffects(runtime);
      updateAutosaveRecord(runtime);
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
      const state = runtime.historyDiff.computeDiff();
      if (state !== "failed" && state !== "unchanged") runtime.diff = { ...runtime.diff, state };
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
      const snapshot = runtime?.paste.snapshot();
      if (runtime === null || runtime.disposed || candidate?.snapshot === undefined || snapshot === undefined || !active(snapshot) || runtime.useRemoteAction !== null) return;
      if (candidate.kind === "terminal") return;
      const remoteAttempt = candidate.capture === undefined ? null : runtime.sync.startCandidateApply(candidate.snapshot, candidate.capture);
      const attempt = snapshot.lastAction.state === "idle" ? 1 : snapshot.lastAction.attempt + 1;
      const startedAt = displayTime();
      runtime.useRemoteAction = { attempt, startedAt };
      runtime.paste.recordLocalAction({ key: "use-remote", state: "pending", attempt, startedAt });
      if (remoteAttempt === null || candidate.capture === undefined) {
        settleUseRemoteAction(runtime, "failed");
        publish(runtime);
        return;
      }
      runtime.pendingRemoteApply = { mode: "candidate", attempt: remoteAttempt, capture: candidate.capture, candidate, action: runtime.useRemoteAction };
      runtime.candidate = null;
      void applyRemote(runtime, candidate.snapshot, "candidate", remoteAttempt, candidate.capture, candidate);
      publish(runtime);
    },
    keepCurrent() {
      const runtime = runtimeRef.current;
      const candidate = runtime?.candidate ?? null;
      if (runtime === null || runtime.disposed || candidate === null || candidate.kind === "terminal") return;
      runtime.candidate = null;
      settleUseRemoteAction(runtime, "failed");
      runtime.sync.keepCurrent(now());
      publish(runtime);
    },
    retrySync(credential) {
      const runtime = runtimeRef.current;
      const candidate = runtime?.candidate ?? null;
      if (runtime === null || runtime.disposed) return;
      const snapshot = runtime.paste.snapshot();
      if (!active(snapshot) || candidate === null || candidate.kind === "terminal") return;
      runtime.paste.setPendingCredential(credential);
      runtime.candidate = null;
      settleUseRemoteAction(runtime, "failed");
      scheduleSyncRetry(runtime, credential);
      publish(runtime);
    },
    retryPreview() {
      const runtime = runtimeRef.current;
      const fallback = runtime?.surface.snapshot();
      if (runtime === null || runtime.disposed || fallback === undefined || fallback.status !== "fallback" || fallback.fallback !== "preview") return;
      void runtime.surface.retryPreview(fallback.source).then(() => publish(runtime));
    },
    retryVisual() {
      const runtime = runtimeRef.current;
      const fallback = runtime?.surface.snapshot();
      if (runtime === null || runtime.disposed || fallback === undefined || fallback.status !== "fallback" || fallback.fallback !== "visual") return;
      void runtime.surface.retryVisual(fallback.source).then(() => publish(runtime));
    },
    retryDiff() {
      const runtime = runtimeRef.current;
      const fallback = runtime?.surface.snapshot();
      if (runtime === null || runtime.disposed || fallback === undefined || fallback.status !== "fallback" || fallback.fallback !== "diff") return;
      void runtime.surface.retryDiff(fallback.source).then(() => publish(runtime));
    },
    setSurfaceMounted(surface, mounted) {
      const runtime = runtimeRef.current;
      if (runtime === null || runtime.disposed) return;
      if (mounted) runtime.mountedSurfaces.add(surface);
      else runtime.mountedSurfaces.delete(surface);
      if (surface === "diff") {
        const state = runtime.historyDiff.setMounted(mounted);
        if (state !== "unchanged" && state !== "failed") runtime.diff = { state, lines: [] };
      }
      cancelPendingRemoteApply(runtime, "surface");
      runtime.surface.remount();
      publish(runtime);
    },
    localAction(action) {
      const runtime = runtimeRef.current;
      if (runtime === null || runtime.disposed) return;
      runtime.paste.recordLocalAction(action);
      publish(runtime);
    },
  // The runtime is intentionally mutable; the callback set must stay stable for child editors.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [queuePublish, publish]);

  return { snapshot: view, actions };
}
