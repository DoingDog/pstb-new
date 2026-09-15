import type {
  AcceptedPasteState,
  ActionKey,
  BaselineCapture,
  CredentialState,
  ExpirationInput,
  LastAction,
  MutationResult,
  PastePhase,
  PasteSummary,
  RemoteSnapshot,
  SourceEvent,
  TerminalOriginSettleContext,
  TerminalOutcomeKey,
} from "./contracts";

export type MutationIntent =
  | { kind: "content"; action: "autosave" | "manual-save" | "save-retry" | "overwrite"; content: string; omitVersion: boolean }
  | { kind: "settings-title"; action: "settings-title" | "settings-reconcile"; title: string }
  | { kind: "settings-format"; action: "settings-format" | "settings-reconcile"; format: "text" | "markdown" }
  | { kind: "settings-expiration"; action: "settings-expiration" | "settings-reconcile"; expiration: ExpirationInput }
  | { kind: "settings-view-once"; action: "settings-view-once" | "settings-reconcile"; viewOnce: boolean }
  | { kind: "password-set"; action: "password-set" | "password-reconcile"; newPassword: string; authorizationPassword: string | null }
  | { kind: "password-clear"; action: "password-clear" | "password-reconcile"; authorizationPassword: string | null }
  | { kind: "delete"; action: "delete"; authorizationPassword: string | null };

export type NonContentMutationIntent = Exclude<MutationIntent, { kind: "content" } | { kind: "delete" }>;

export type MutationSlot =
  | { state: "idle"; nextToken: number }
  | { state: "in-flight"; token: number; intent: MutationIntent; capture: BaselineCapture }
  | { state: "content-reconciliation"; token: number; originActionKey: "autosave" | "manual-save" | "save-retry" | "overwrite"; capture: BaselineCapture & { inFlightContent: string }; laterDraft: string; requestToken: number }
  | { state: "metadata-reconciliation"; token: number; intent: NonContentMutationIntent; capture: BaselineCapture };

export type MutationFailure = { status: number | null; mutationMayHaveApplied?: boolean };
export type MutationSuccess = MutationResult;
export type ReconcileReadFailure =
  | { kind: "forbidden" }
  | { kind: "not-found" }
  | { kind: "unavailable" }
  | { kind: "network" }
  | { kind: "malformed" }
  | { kind: "not-modified" };
export type ContentReconcileResult = { kind: "snapshot"; snapshot: RemoteSnapshot } | ReconcileReadFailure;
export type MetadataReconcileResult = { kind: "snapshot"; snapshot: RemoteSnapshot } | ReconcileReadFailure;
export type DeleteResult = MutationFailure & { status: number | null };

export type MutationEffect =
  | { type: "invalidate-sync" }
  | { type: "invalidate-history"; reason: "mutation" | "remote-apply" | "terminal" | "delete" }
  | { type: "dispatch-content"; token: number; content: string; intent: Extract<MutationIntent, { kind: "content" }>; capture: BaselineCapture }
  | { type: "dispatch-metadata-reconcile"; mutationToken: number; requestToken: number; intent: NonContentMutationIntent; credentialProbe: "authorization"; authorizationPassword: string | null }
  | { type: "dispatch-relative-expiration-retry"; token: number; intent: Extract<NonContentMutationIntent, { kind: "settings-expiration" }>; version: string; now: number }
  | { type: "autosave-slot-available" }
  | { type: "credential-commit"; credential: string | null }
  | { type: "apply-authoritative"; kind: "content" | "metadata" | "reconciled-applied" | "reconciled-not-applied" | "pause"; acceptedSource?: string; version?: string; state?: "password-required" | "not-found" | "conflict"; failureStatus?: number | null }
  | { type: "pause"; state: "password-required" | "not-found" | "conflict"; failureStatus: number | null }
  | { type: "root-handoff" }
  | { type: "dispose-server-capabilities"; phase: PastePhase }
  | { type: "terminal-settled"; key: TerminalOutcomeKey };

export type MutationDispatch = {
  kind: "dispatch";
  type: "dispatch-content" | "dispatch-metadata" | "dispatch-delete";
  token: number;
  intent: MutationIntent;
  capture: BaselineCapture;
  version: string | null;
  authorizationPassword: string | null;
};
export type MutationStart = MutationDispatch | { kind: "blocked"; reason: "slot-occupied" | "terminal" | "version-unusable" };

export type ContentReconcileDispatch =
  | { kind: "blocked"; reason: "not-reconciling" | "terminal" | "reconcile-pending" }
  | { kind: "dispatch"; type: "reconcile-content"; mutationToken: number; requestToken: number; capture: BaselineCapture & { inFlightContent: string }; authorizationPassword: string | null; cache: "no-store"; ifNoneMatch: null };
export type MetadataReconcileDispatch =
  | { kind: "blocked"; reason: "not-reconciling" | "terminal" | "reconcile-pending" }
  | { kind: "dispatch"; type: "reconcile-settings"; mutationToken: number; requestToken: number; intent: NonContentMutationIntent; credentialProbe: "intended" | "authorization" | "current"; authorizationPassword: string | null };

type OriginalMutationFailure = { key: ActionKey; status: number | null; failedAt: string };
type ConflictCandidate = { source: string; paste: PasteSummary; snapshot: RemoteSnapshot; capture: BaselineCapture & { inFlightContent: string }; originalTarget: string };

interface PasteControllerSnapshotBase {
  lastSavedContent: string;
  mutation: MutationSlot;
  coalescedSource: string | null;
  phase: PastePhase;
  credential: CredentialState;
  autosave: { state: "clean" | "waiting" | "saving" | "saved" | "error" | "password-required" | "not-found" | "conflict"; confirmedAt: string | null; failedAt: string | null };
  lastAction: LastAction;
  conflictCandidate: ConflictCandidate | null;
  terminalResponseSource: string | null;
  terminalOrigin: TerminalOriginSettleContext | null;
  originalMutationFailure: OriginalMutationFailure | null;
  reconciliationRequired: boolean;
  serverCapabilities: boolean;
}

export interface ActivePasteControllerSnapshot extends AcceptedPasteState, PasteControllerSnapshotBase {
  resource: "active";
}

export interface DeletedRootHandoffSnapshot extends PasteControllerSnapshotBase {
  resource: "deleted-root-handoff";
  acceptedSource: "";
  draft: "";
  summary: null;
  version: null;
  versionUsable: false;
  contentRevision: null;
  updatedAt: null;
  responseEtag: null;
  acceptedApplyGeneration: null;
  localGeneration: null;
  displayGeneration: null;
  lastSavedContent: "";
  coalescedSource: null;
  credential: { committed: null; pending: null };
  conflictCandidate: null;
  terminalResponseSource: null;
  terminalOrigin: null;
  originalMutationFailure: null;
  reconciliationRequired: false;
  serverCapabilities: false;
}

export type PasteControllerSnapshot = ActivePasteControllerSnapshot | DeletedRootHandoffSnapshot;

export interface PasteControllerOptions {
  accepted: AcceptedPasteState;
  credential?: CredentialState | string | null;
  onSourceActivity?(eventAt: number): void;
}

export interface PasteController {
  snapshot(): Readonly<PasteControllerSnapshot>;
  effects(): readonly MutationEffect[];
  takeEffects(): MutationEffect[];
  sourceEvent(event: SourceEvent): void;
  startMutation(intent: MutationIntent, at?: number): MutationStart;
  acceptContentMutation(token: number, result: MutationSuccess, at?: number): boolean;
  acceptMetadataMutation(token: number, result: MutationSuccess, at?: number): boolean;
  failMutation(token: number, failure: MutationFailure, at?: number): boolean;
  startContentReconcile(at?: number): ContentReconcileDispatch;
  acceptContentReconcile(token: number, result: ContentReconcileResult, at?: number): boolean;
  startMetadataReconcile(at?: number): MetadataReconcileDispatch;
  acceptMetadataReconcile(token: number, result: MetadataReconcileResult, at?: number): boolean;
  acceptDeleteMutation(token: number, result: DeleteResult, at?: number): boolean;
  setPendingCredential(value: string | null): void;
  retireForRemoteApply(): void;
  enterTerminal(phase: Extract<PastePhase, "consumed" | "not-found" | "delete-uncertain">, at?: number, origin?: TerminalOriginSettleContext): void;
  settleTerminal(outcome: TerminalOutcomeKey, at?: number): boolean;
}

const sourceActivityEvents = new Set<SourceEvent["type"]>(["input", "composition-end", "crepe-change"]);
type InternalState = Omit<ActivePasteControllerSnapshot, "mutation">;
type MetadataRequest = { requestToken: number; token: number; probe: "intended" | "authorization" | "current"; credential: string | null };

function instant(at: number | undefined): string {
  return new Date(at ?? Date.now()).toISOString();
}

function generationOf(version: string): string | "legacy" {
  if (version === "legacy") return "legacy";
  const separator = version.lastIndexOf(".");
  return separator > 0 ? version.slice(0, separator) : version;
}

function capture(state: InternalState): BaselineCapture {
  return {
    acceptedApplyGeneration: state.acceptedApplyGeneration,
    localGeneration: state.localGeneration,
    generation: generationOf(state.version),
    version: state.version,
    contentRevision: state.contentRevision,
    updatedAt: state.updatedAt,
    acceptedSource: state.acceptedSource,
  };
}

function sameAcceptedBaseline(left: BaselineCapture, state: InternalState): boolean {
  return left.acceptedApplyGeneration === state.acceptedApplyGeneration
    && left.generation === generationOf(state.version)
    && left.version === state.version
    && left.contentRevision === state.contentRevision
    && left.updatedAt === state.updatedAt
    && left.acceptedSource === state.acceptedSource;
}

function sameMetadataMarkers(baseline: BaselineCapture, snapshot: RemoteSnapshot): boolean {
  const generation = snapshot.identity.kind === "legacy" ? "legacy" : snapshot.identity.generation;
  return snapshot.source === baseline.acceptedSource
    && generation === baseline.generation
    && snapshot.contentRevision === baseline.contentRevision
    && snapshot.summary.contentRevision === baseline.contentRevision;
}

function isUncertain(failure: MutationFailure): boolean {
  return failure.mutationMayHaveApplied === true
    || failure.status === null
    || (failure.status >= 500 && failure.mutationMayHaveApplied !== false);
}

function actionKey(intent: MutationIntent): ActionKey {
  return intent.action;
}

function isRelativeExpiration(intent: NonContentMutationIntent): boolean {
  return intent.kind === "settings-expiration" && typeof intent.expiration === "number";
}

function matchesExpiration(input: ExpirationInput, paste: PasteSummary): boolean {
  if (input === null || input === "never") return paste.expiration.kind === "permanent";
  if (typeof input !== "string" || paste.expiration.kind !== "absolute" || paste.expiresAt === null) return false;
  const expected = Date.parse(input);
  const actual = Date.parse(paste.expiresAt);
  return Number.isFinite(expected) && expected === actual;
}

function targetsMetadata(intent: NonContentMutationIntent, paste: PasteSummary): boolean {
  switch (intent.kind) {
    case "settings-title": return paste.title === intent.title;
    case "settings-format": return paste.format === intent.format;
    case "settings-view-once": return paste.viewOnce === intent.viewOnce;
    case "settings-expiration": return !isRelativeExpiration(intent) && matchesExpiration(intent.expiration, paste);
    case "password-set": return paste.protected === (intent.newPassword !== "");
    case "password-clear": return !paste.protected;
  }
}

function initialCredential(value: PasteControllerOptions["credential"]): CredentialState {
  if (typeof value === "string" || value === null) return { committed: value ?? null, pending: null };
  return value === undefined ? { committed: null, pending: null } : { ...value };
}

export function createPasteController(options: PasteControllerOptions): PasteController {
  const initial = options.accepted;
  let state: InternalState = {
    ...initial,
    resource: "active",
    lastSavedContent: initial.acceptedSource,
    coalescedSource: null,
    phase: "ordinary",
    credential: initialCredential(options.credential),
    autosave: { state: "clean", confirmedAt: null, failedAt: null },
    lastAction: { state: "idle" },
    conflictCandidate: null,
    terminalResponseSource: null,
    terminalOrigin: null,
    originalMutationFailure: null,
    reconciliationRequired: false,
    serverCapabilities: true,
  };
  let nextToken = 0;
  let nextReconcileToken = 0;
  let slot: MutationSlot = { state: "idle", nextToken };
  let metadataRequest: MetadataRequest | undefined;
  let effects: MutationEffect[] = [];
  let rootHandoffSnapshot: DeletedRootHandoffSnapshot | null = null;
  const mutationCredentials = new Map<number, string | null>();
  const reconcileCredentials = new Map<number, string | null>();

  const snapshot = (): Readonly<PasteControllerSnapshot> => rootHandoffSnapshot ?? { ...state, mutation: slot };

  const setLastAction = (intent: MutationIntent, at: number | undefined, attempt = nextToken): void => {
    state = { ...state, lastAction: { state: "pending", key: actionKey(intent), attempt, startedAt: instant(at) } };
  };
  const setReconcileAction = (key: "content-reconcile" | "settings-reconcile" | "password-reconcile", attempt: number, at: number | undefined): void => {
    state = { ...state, lastAction: { state: "pending", key, attempt, startedAt: instant(at) } };
  };
  const settleLastAction = (stateName: "succeeded" | "failed", at: number | undefined, outcomeKey: TerminalOutcomeKey | null = null): void => {
    if (state.lastAction.state !== "pending") return;
    state = { ...state, lastAction: { state: stateName, key: state.lastAction.key, attempt: state.lastAction.attempt, startedAt: state.lastAction.startedAt, settledAt: instant(at), outcomeKey } };
  };
  const recordFailure = (intent: MutationIntent, failure: MutationFailure, at: number | undefined): void => {
    state = { ...state, originalMutationFailure: { key: actionKey(intent), status: failure.status, failedAt: instant(at) } };
  };
  const invalidate = (reason: "mutation" | "remote-apply" | "terminal" | "delete"): void => {
    effects.push({ type: "invalidate-sync" }, { type: "invalidate-history", reason });
  };
  const commitCredential = (credential: string | null): void => {
    state = { ...state, credential: { committed: credential, pending: null } };
    effects.push({ type: "credential-commit", credential });
  };
  const clearRequestOwnership = (): void => {
    metadataRequest = undefined;
    mutationCredentials.clear();
    reconcileCredentials.clear();
  };
  const release = (eligibleForAutosave: boolean): void => {
    slot = { state: "idle", nextToken };
    clearRequestOwnership();
    state = { ...state, coalescedSource: null };
    if (eligibleForAutosave) effects.push({ type: "autosave-slot-available" });
  };
  const handoffToRoot = (): void => {
    state = { ...state, serverCapabilities: false };
    rootHandoffSnapshot = {
      resource: "deleted-root-handoff",
      acceptedSource: "",
      draft: "",
      summary: null,
      version: null,
      versionUsable: false,
      contentRevision: null,
      updatedAt: null,
      responseEtag: null,
      acceptedApplyGeneration: null,
      localGeneration: null,
      displayGeneration: null,
      lastSavedContent: "",
      mutation: slot,
      coalescedSource: null,
      phase: "ordinary",
      credential: { committed: null, pending: null },
      autosave: { state: "clean", confirmedAt: null, failedAt: null },
      lastAction: state.lastAction,
      conflictCandidate: null,
      terminalResponseSource: null,
      terminalOrigin: null,
      originalMutationFailure: null,
      reconciliationRequired: false,
      serverCapabilities: false,
    };
  };
  const requestCredential = (intent: MutationIntent): string | null => {
    if (intent.kind === "password-set" || intent.kind === "password-clear" || intent.kind === "delete") return intent.authorizationPassword;
    return state.credential.pending ?? state.credential.committed;
  };

  const begin = (intent: MutationIntent, at: number | undefined): MutationDispatch => {
    state = { ...state, localGeneration: state.localGeneration + 1, conflictCandidate: null };
    invalidate(intent.kind === "delete" ? "delete" : "mutation");
    const token = ++nextToken;
    const baseline = capture(state);
    const authorizationPassword = requestCredential(intent);
    mutationCredentials.set(token, authorizationPassword);
    slot = { state: "in-flight", token, intent, capture: baseline };
    setLastAction(intent, at, token);
    return { kind: "dispatch", type: intent.kind === "content" ? "dispatch-content" : intent.kind === "delete" ? "dispatch-delete" : "dispatch-metadata", token, intent, capture: baseline, version: intent.kind === "content" && intent.omitVersion ? null : state.version, authorizationPassword };
  };

  const startMutation = (intent: MutationIntent, at?: number): MutationStart => {
    if (intent.kind === "content" && intent.omitVersion !== (intent.action === "overwrite")) throw new TypeError("content omitVersion must match overwrite action");
    if (state.phase !== "ordinary" || !state.serverCapabilities) return { kind: "blocked", reason: "terminal" };
    if (slot.state !== "idle") {
      if (intent.kind === "content") state = { ...state, coalescedSource: intent.content };
      return { kind: "blocked", reason: "slot-occupied" };
    }
    if (!state.versionUsable && !(intent.kind === "content" && intent.omitVersion)) return { kind: "blocked", reason: "version-unusable" };
    return begin(intent, at);
  };

  const sourceEvent = (event: SourceEvent): void => {
    state = { ...state, draft: event.content, localGeneration: state.localGeneration + 1 };
    if (slot.state !== "idle") {
      state = { ...state, coalescedSource: event.content };
      if (slot.state === "content-reconciliation") slot = { ...slot, laterDraft: event.content };
    }
    if (sourceActivityEvents.has(event.type)) options.onSourceActivity?.(event.eventAt);
  };

  const adoptMutationMetadata = (result: MutationSuccess): void => {
    state = { ...state, summary: result.paste, version: result.paste.version, versionUsable: true, contentRevision: result.paste.contentRevision, updatedAt: result.paste.updatedAt, responseEtag: null, reconciliationRequired: false };
  };
  const adoptSnapshotMetadata = (snapshotResult: RemoteSnapshot): void => {
    state = { ...state, summary: snapshotResult.summary, version: snapshotResult.summary.version, versionUsable: true, contentRevision: snapshotResult.contentRevision, updatedAt: snapshotResult.summary.updatedAt, responseEtag: snapshotResult.etag, reconciliationRequired: false };
  };
  const acceptsMetadata = (baseline: BaselineCapture, result: MutationSuccess): boolean => {
    return sameAcceptedBaseline(baseline, state)
      && generationOf(result.paste.version) === baseline.generation
      && result.paste.contentRevision === baseline.contentRevision;
  };
  const enterArmedViewOnce = (): void => {
    if (state.phase !== "ordinary") return;
    nextToken += 1;
    slot = { state: "idle", nextToken };
    clearRequestOwnership();
    state = { ...state, phase: "armed-view-once", serverCapabilities: false, coalescedSource: null, responseEtag: null, reconciliationRequired: false };
    invalidate("terminal");
    effects.push({ type: "dispose-server-capabilities", phase: "armed-view-once" });
  };

  const acceptContentMutation = (token: number, result: MutationSuccess, at?: number): boolean => {
    if (slot.state !== "in-flight" || slot.token !== token || slot.intent.kind !== "content" || !sameAcceptedBaseline(slot.capture, state)) return false;
    const intent = slot.intent;
    const credential = mutationCredentials.get(token) ?? null;
    state = {
      ...state,
      acceptedSource: intent.content,
      lastSavedContent: intent.content,
      summary: result.paste,
      version: result.paste.version,
      versionUsable: true,
      contentRevision: result.paste.contentRevision,
      updatedAt: result.paste.updatedAt,
      responseEtag: null,
      autosave: { state: state.draft === intent.content ? "saved" : "waiting", confirmedAt: instant(at), failedAt: null },
      reconciliationRequired: false,
    };
    commitCredential(credential);
    settleLastAction("succeeded", at);
    effects.push({ type: "apply-authoritative", kind: "content", acceptedSource: intent.content, version: result.paste.version });
    release(true);
    return true;
  };

  const acceptMetadata = (token: number, intent: NonContentMutationIntent, baseline: BaselineCapture, result: MutationSuccess, at?: number): boolean => {
    if (!acceptsMetadata(baseline, result)) {
      slot = { state: "metadata-reconciliation", token, intent, capture: baseline };
      clearRequestOwnership();
      state = { ...state, responseEtag: null, reconciliationRequired: true };
      recordFailure(intent, { status: null }, at);
      settleLastAction("failed", at);
      return false;
    }
    adoptMutationMetadata(result);
    if (intent.kind === "password-set") commitCredential(intent.newPassword === "" ? null : intent.newPassword);
    else if (intent.kind === "password-clear") commitCredential(null);
    else commitCredential(mutationCredentials.get(token) ?? null);
    settleLastAction("succeeded", at);
    effects.push({ type: "apply-authoritative", kind: "metadata", acceptedSource: state.acceptedSource, version: result.paste.version });
    if (result.paste.viewOnce) enterArmedViewOnce();
    else release(true);
    return true;
  };

  const acceptMetadataMutation = (token: number, result: MutationSuccess, at?: number): boolean => {
    if (slot.state !== "in-flight" || slot.token !== token || slot.intent.kind === "content" || slot.intent.kind === "delete") return false;
    return acceptMetadata(token, slot.intent, slot.capture, result, at);
  };

  const settleContentFailure = (current: Extract<MutationSlot, { state: "in-flight" }>, failure: MutationFailure, at?: number): boolean => {
    const intent = current.intent as Extract<MutationIntent, { kind: "content" }>;
    recordFailure(intent, failure, at);
    if (failure.status === 404) {
      settleLastAction("failed", at);
      enterTerminal("not-found", at);
      return true;
    }
    if (failure.status === 409) {
      state = { ...state, versionUsable: false, autosave: { state: "conflict", confirmedAt: state.autosave.confirmedAt, failedAt: instant(at) } };
      settleLastAction("failed", at);
      effects.push({ type: "apply-authoritative", kind: "pause", state: "conflict", failureStatus: 409 });
      release(false);
      return true;
    }
    if (isUncertain(failure)) {
      slot = { state: "content-reconciliation", token: current.token, originActionKey: intent.action, capture: { ...current.capture, inFlightContent: intent.content }, laterDraft: state.draft, requestToken: 0 };
      state = { ...state, responseEtag: null, reconciliationRequired: true, autosave: { state: "error", confirmedAt: state.autosave.confirmedAt, failedAt: instant(at) } };
      settleLastAction("failed", at);
      return true;
    }
    const autosaveState = failure.status === 403 ? "password-required" : "error";
    state = { ...state, autosave: { state: autosaveState, confirmedAt: state.autosave.confirmedAt, failedAt: instant(at) } };
    settleLastAction("failed", at);
    if (failure.status === 403) effects.push({ type: "pause", state: "password-required", failureStatus: 403 });
    release(false);
    return true;
  };

  const settleMetadataFailure = (current: Extract<MutationSlot, { state: "in-flight" }>, failure: MutationFailure, at?: number): boolean => {
    if (current.intent.kind === "delete") return acceptDeleteMutation(current.token, failure, at);
    const intent = current.intent as NonContentMutationIntent;
    recordFailure(intent, failure, at);
    if (failure.status === 404) {
      settleLastAction("failed", at);
      enterTerminal("not-found", at);
      return true;
    }
    if (failure.status === 409) {
      state = { ...state, versionUsable: false, autosave: { state: "conflict", confirmedAt: state.autosave.confirmedAt, failedAt: instant(at) } };
      settleLastAction("failed", at);
      effects.push({ type: "pause", state: "conflict", failureStatus: 409 });
      release(false);
      return true;
    }
    if (isUncertain(failure)) {
      slot = { state: "metadata-reconciliation", token: current.token, intent, capture: current.capture };
      clearRequestOwnership();
      state = { ...state, responseEtag: null, reconciliationRequired: true };
      settleLastAction("failed", at);
      return true;
    }
    settleLastAction("failed", at);
    if (failure.status === 403) {
      state = { ...state, autosave: { state: "password-required", confirmedAt: state.autosave.confirmedAt, failedAt: instant(at) } };
      effects.push({ type: "pause", state: "password-required", failureStatus: 403 });
      release(false);
      return true;
    }
    release(failure.mutationMayHaveApplied === false);
    return true;
  };

  const failMutation = (token: number, failure: MutationFailure, at?: number): boolean => {
    if (slot.state !== "in-flight" || slot.token !== token || !sameAcceptedBaseline(slot.capture, state)) return false;
    return slot.intent.kind === "content" ? settleContentFailure(slot, failure, at) : settleMetadataFailure(slot, failure, at);
  };

  const startContentReconcile = (at?: number): ContentReconcileDispatch => {
    if (state.phase !== "ordinary") return { kind: "blocked", reason: "terminal" };
    if (slot.state !== "content-reconciliation") return { kind: "blocked", reason: "not-reconciling" };
    if (slot.requestToken !== 0) return { kind: "blocked", reason: "reconcile-pending" };
    const requestToken = ++nextReconcileToken;
    const credential = state.credential.pending ?? state.credential.committed;
    reconcileCredentials.set(requestToken, credential);
    slot = { ...slot, requestToken };
    setReconcileAction("content-reconcile", requestToken, at);
    return { kind: "dispatch", type: "reconcile-content", mutationToken: slot.token, requestToken, capture: slot.capture, authorizationPassword: credential, cache: "no-store", ifNoneMatch: null };
  };

  const settleContentReadFailure = (result: ReconcileReadFailure, at: number | undefined): boolean => {
    if (result.kind === "forbidden") {
      state = { ...state, autosave: { state: "password-required", confirmedAt: state.autosave.confirmedAt, failedAt: instant(at) } };
      effects.push({ type: "pause", state: "password-required", failureStatus: 403 });
    } else if (result.kind === "not-found") {
      effects.push({ type: "pause", state: "not-found", failureStatus: 404 });
      settleLastAction("failed", at);
      enterTerminal("not-found", at);
      return true;
    }
    settleLastAction("failed", at);
    return true;
  };

  const acceptContentReconcile = (requestToken: number, result: ContentReconcileResult, at?: number): boolean => {
    if (slot.state !== "content-reconciliation" || slot.requestToken !== requestToken || !sameAcceptedBaseline(slot.capture, state)) return false;
    const current = slot;
    const credential = reconcileCredentials.get(requestToken) ?? null;
    const decoded = result;
    reconcileCredentials.delete(requestToken);
    slot = { ...current, requestToken: 0 };
    if (decoded.kind !== "snapshot") return settleContentReadFailure(decoded, at);
    const remote = decoded.snapshot;
    if (remote.summary.viewOnce) {
      state = { ...state, terminalResponseSource: remote.source };
      commitCredential(credential);
      const origin: TerminalOriginSettleContext = { actionKey: "content-reconcile", actionAttempt: requestToken, startedAt: state.lastAction.state === "pending" ? state.lastAction.startedAt : instant(at) };
      enterTerminal("consumed", at, origin);
      return true;
    }
    if (remote.source === current.capture.inFlightContent) {
      state = {
        ...state,
        acceptedSource: remote.source,
        lastSavedContent: remote.source,
        summary: remote.summary,
        version: remote.summary.version,
        versionUsable: true,
        contentRevision: remote.contentRevision,
        updatedAt: remote.summary.updatedAt,
        responseEtag: remote.etag,
        reconciliationRequired: false,
        autosave: { state: state.draft === remote.source ? "saved" : "waiting", confirmedAt: instant(at), failedAt: null },
      };
      commitCredential(credential);
      settleLastAction("succeeded", at);
      effects.push({ type: "apply-authoritative", kind: "reconciled-applied", acceptedSource: remote.source, version: remote.summary.version });
      release(true);
      return true;
    }
    const baselineMatches = remote.source === current.capture.acceptedSource
      && remote.summary.version === current.capture.version
      && remote.contentRevision === current.capture.contentRevision
      && remote.summary.updatedAt === current.capture.updatedAt;
    if (current.capture.inFlightContent !== current.capture.acceptedSource && baselineMatches) {
      adoptSnapshotMetadata(remote);
      state = { ...state, autosave: { state: "error", confirmedAt: state.autosave.confirmedAt, failedAt: state.autosave.failedAt ?? instant(at) } };
      commitCredential(credential);
      settleLastAction("succeeded", at);
      effects.push({ type: "apply-authoritative", kind: "reconciled-not-applied", acceptedSource: remote.source, version: remote.summary.version });
      release(false);
      return true;
    }
    state = {
      ...state,
      conflictCandidate: { source: remote.source, paste: remote.summary, snapshot: remote, capture: current.capture, originalTarget: current.capture.inFlightContent },
      reconciliationRequired: false,
      autosave: { state: "conflict", confirmedAt: state.autosave.confirmedAt, failedAt: instant(at) },
    };
    commitCredential(credential);
    settleLastAction("succeeded", at);
    effects.push({ type: "apply-authoritative", kind: "pause", state: "conflict", failureStatus: null });
    release(false);
    return true;
  };

  const beginMetadataRead = (current: Extract<MutationSlot, { state: "metadata-reconciliation" }>, probe: MetadataRequest["probe"], credential: string | null, at: number | undefined): MetadataReconcileDispatch => {
    const requestToken = ++nextReconcileToken;
    metadataRequest = { requestToken, token: current.token, probe, credential };
    setReconcileAction(probe === "intended" || probe === "authorization" ? "password-reconcile" : "settings-reconcile", requestToken, at);
    return { kind: "dispatch", type: "reconcile-settings", mutationToken: current.token, requestToken, intent: current.intent, credentialProbe: probe, authorizationPassword: credential };
  };

  const startMetadataReconcile = (at?: number): MetadataReconcileDispatch => {
    if (state.phase !== "ordinary") return { kind: "blocked", reason: "terminal" };
    if (slot.state !== "metadata-reconciliation") return { kind: "blocked", reason: "not-reconciling" };
    if (metadataRequest !== undefined) return { kind: "blocked", reason: "reconcile-pending" };
    const probe = slot.intent.kind === "password-set" || slot.intent.kind === "password-clear" ? "intended" : "current";
    const credential = probe === "intended"
      ? slot.intent.kind === "password-set" ? slot.intent.newPassword : null
      : state.credential.pending ?? state.credential.committed;
    return beginMetadataRead(slot, probe, credential, at);
  };

  const startAuthorizationProbe = (current: Extract<MutationSlot, { state: "metadata-reconciliation" }>, at: number | undefined): void => {
    const intent = current.intent;
    if ((intent.kind !== "password-set" && intent.kind !== "password-clear") || intent.authorizationPassword === (intent.kind === "password-set" ? intent.newPassword : null)) return;
    const dispatch = beginMetadataRead(current, "authorization", intent.authorizationPassword, at);
    if (dispatch.kind === "dispatch") effects.push({ type: "dispatch-metadata-reconcile", mutationToken: dispatch.mutationToken, requestToken: dispatch.requestToken, intent: dispatch.intent, credentialProbe: "authorization", authorizationPassword: dispatch.authorizationPassword });
  };

  const failMetadataRead = (result: ReconcileReadFailure, current: Extract<MutationSlot, { state: "metadata-reconciliation" }>, request: MetadataRequest, at: number | undefined): boolean => {
    if (result.kind === "forbidden") {
      if (request.probe === "intended") {
        startAuthorizationProbe(current, at);
        if (metadataRequest !== undefined) return true;
      }
      state = { ...state, autosave: { state: "password-required", confirmedAt: state.autosave.confirmedAt, failedAt: instant(at) } };
      effects.push({ type: "pause", state: "password-required", failureStatus: 403 });
    } else if (result.kind === "not-found") {
      settleLastAction("failed", at);
      enterTerminal("not-found", at);
      return true;
    } else if (result.kind === "not-modified" && request.probe === "intended") {
      const intent = current.intent;
      if (intent.kind === "password-set") commitCredential(intent.newPassword === "" ? null : intent.newPassword);
      else if (intent.kind === "password-clear") commitCredential(null);
      else commitCredential(request.credential);
      state = { ...state, reconciliationRequired: false };
      settleLastAction("succeeded", at);
      release(false);
      return true;
    } else if (result.kind === "not-modified") {
      commitCredential(request.credential);
    }
    settleLastAction("failed", at);
    return true;
  };

  const retryRelativeExpiration = (current: Extract<MutationSlot, { state: "metadata-reconciliation" }>, remote: RemoteSnapshot, credential: string | null, at: number | undefined): boolean => {
    if (current.intent.kind !== "settings-expiration") return false;
    adoptSnapshotMetadata(remote);
    commitCredential(credential);
    slot = { state: "idle", nextToken };
    metadataRequest = undefined;
    const retryIntent: Extract<MutationIntent, { kind: "settings-expiration" }> = { kind: "settings-expiration", action: "settings-reconcile", expiration: current.intent.expiration };
    const retry = begin(retryIntent, at);
    state = { ...state, reconciliationRequired: true };
    effects.push({ type: "dispatch-relative-expiration-retry", token: retry.token, intent: retryIntent, version: retry.version ?? state.version, now: at ?? Date.now() });
    return true;
  };

  const acceptMetadataReconcile = (requestToken: number, result: MetadataReconcileResult, at?: number): boolean => {
    if (slot.state !== "metadata-reconciliation" || metadataRequest?.requestToken !== requestToken || metadataRequest.token !== slot.token) return false;
    const current = slot;
    const request = metadataRequest;
    const decoded = result;
    metadataRequest = undefined;
    if (decoded.kind !== "snapshot") return failMetadataRead(decoded, current, request, at);
    const remote = decoded.snapshot;
    if (!sameAcceptedBaseline(current.capture, state) || !sameMetadataMarkers(current.capture, remote)) {
      settleLastAction("failed", at);
      return true;
    }
    if (request.probe === "authorization") {
      commitCredential(request.credential);
      state = { ...state, reconciliationRequired: false };
      settleLastAction("failed", at);
      release(false);
      return true;
    }
    if (isRelativeExpiration(current.intent)) return retryRelativeExpiration(current, remote, request.credential, at);
    if (!targetsMetadata(current.intent, remote.summary)) {
      commitCredential(request.credential);
      state = { ...state, reconciliationRequired: false };
      settleLastAction("failed", at);
      release(false);
      return true;
    }
    adoptSnapshotMetadata(remote);
    if (current.intent.kind === "password-set") commitCredential(current.intent.newPassword === "" ? null : current.intent.newPassword);
    else if (current.intent.kind === "password-clear") commitCredential(null);
    else commitCredential(request.credential);
    settleLastAction("succeeded", at);
    effects.push({ type: "apply-authoritative", kind: "metadata", acceptedSource: state.acceptedSource, version: remote.summary.version });
    if (remote.summary.viewOnce) enterArmedViewOnce();
    else release(true);
    return true;
  };

  const acceptDeleteMutation = (token: number, result: DeleteResult, at?: number): boolean => {
    if (slot.state !== "in-flight" || slot.token !== token || slot.intent.kind !== "delete" || !sameAcceptedBaseline(slot.capture, state)) return false;
    const failure: MutationFailure = result;
    if (result.status === 204) {
      settleLastAction("succeeded", at);
      release(false);
      handoffToRoot();
      effects.push({ type: "root-handoff" });
      return true;
    }
    recordFailure(slot.intent, failure, at);
    if (result.status === 403) {
      state = { ...state, autosave: { state: "password-required", confirmedAt: state.autosave.confirmedAt, failedAt: instant(at) } };
      settleLastAction("failed", at);
      effects.push({ type: "pause", state: "password-required", failureStatus: 403 });
      release(false);
      return true;
    }
    if (result.status === 409) {
      state = { ...state, versionUsable: false, autosave: { state: "conflict", confirmedAt: state.autosave.confirmedAt, failedAt: instant(at) } };
      settleLastAction("failed", at);
      effects.push({ type: "pause", state: "conflict", failureStatus: 409 });
      release(false);
      return true;
    }
    if (result.status === 404) {
      settleLastAction("failed", at);
      enterTerminal("not-found", at);
      return true;
    }
    if (isUncertain(failure) || (result.status !== null && result.status >= 500)) {
      settleLastAction("failed", at);
      enterTerminal("delete-uncertain", at);
      return true;
    }
    settleLastAction("failed", at);
    release(false);
    return true;
  };

  const setPendingCredential = (value: string | null): void => {
    state = { ...state, credential: { ...state.credential, pending: value } };
  };

  const retireForRemoteApply = (): void => {
    nextToken += 1;
    slot = { state: "idle", nextToken };
    clearRequestOwnership();
    state = { ...state, coalescedSource: null, reconciliationRequired: false };
    invalidate("remote-apply");
  };

  const enterTerminal = (phase: Extract<PastePhase, "consumed" | "not-found" | "delete-uncertain">, at?: number, origin?: TerminalOriginSettleContext): void => {
    if (state.phase !== "ordinary") return;
    const inferredOrigin = origin ?? (state.lastAction.state === "pending" && state.lastAction.key === "content-reconcile"
      ? { actionKey: "content-reconcile" as const, actionAttempt: state.lastAction.attempt, startedAt: state.lastAction.startedAt }
      : undefined);
    nextToken += 1;
    slot = { state: "idle", nextToken };
    clearRequestOwnership();
    state = {
      ...state,
      phase,
      serverCapabilities: false,
      coalescedSource: null,
      responseEtag: null,
      reconciliationRequired: false,
      terminalOrigin: inferredOrigin ?? null,
      autosave: { state: phase === "not-found" ? "not-found" : state.autosave.state, confirmedAt: state.autosave.confirmedAt, failedAt: phase === "not-found" ? instant(at) : state.autosave.failedAt },
    };
    invalidate("terminal");
    effects.push({ type: "dispose-server-capabilities", phase });
    if (inferredOrigin === undefined) settleLastAction("failed", at);
  };

  const settleTerminal = (outcome: TerminalOutcomeKey, at?: number): boolean => {
    const origin = state.terminalOrigin;
    const valid = origin?.actionKey === "content-reconcile"
      ? outcome === "content-reconcile-terminal-current-kept"
      : outcome === "reload-terminal-response-displayed"
        || outcome === "reload-terminal-response-display-failed"
        || outcome === "reload-terminal-current-unchanged"
        || outcome === "reload-terminal-current-kept-choice";
    if (!valid || origin === null) return false;
    state = {
      ...state,
      terminalOrigin: null,
      lastAction: {
        state: outcome === "reload-terminal-response-display-failed" || outcome === "use-consumed-response-display-failed" ? "failed" : "succeeded",
        key: origin.actionKey,
        attempt: origin.actionAttempt,
        startedAt: origin.startedAt,
        settledAt: instant(at),
        outcomeKey: outcome,
      },
    };
    effects.push({ type: "terminal-settled", key: outcome });
    return true;
  };

  return {
    snapshot,
    effects: () => effects.slice(),
    takeEffects: () => {
      const pending = effects;
      effects = [];
      return pending;
    },
    sourceEvent,
    startMutation,
    acceptContentMutation,
    acceptMetadataMutation,
    failMutation,
    startContentReconcile,
    acceptContentReconcile,
    startMetadataReconcile,
    acceptMetadataReconcile,
    acceptDeleteMutation,
    setPendingCredential,
    retireForRemoteApply,
    enterTerminal,
    settleTerminal,
  };
}
