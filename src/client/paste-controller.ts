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

export type NonContentMutationIntent = Exclude<
  MutationIntent,
  { kind: "content" } | { kind: "delete" }
>;

export type MutationSlot =
  | { state: "idle"; nextToken: number }
  | { state: "in-flight"; token: number; intent: MutationIntent; capture: BaselineCapture }
  | {
      state: "content-reconciliation";
      token: number;
      originActionKey: "autosave" | "manual-save" | "save-retry" | "overwrite";
      capture: BaselineCapture & { inFlightContent: string };
      laterDraft: string;
      requestToken: number;
    }
  | { state: "metadata-reconciliation"; token: number; intent: NonContentMutationIntent; capture: BaselineCapture };

export type MutationFailure = {
  status: number | null;
  mutationMayHaveApplied?: boolean;
};

export type MutationSuccess = MutationResult & {
  etag?: `"sha256-${string}"`;
  responseEtag?: `"sha256-${string}"`;
};

export type ContentReconcileResult = {
  status: number;
  content?: string;
  source?: string;
  paste?: PasteSummary;
  etag?: `"sha256-${string}"`;
  responseEtag?: `"sha256-${string}"`;
};

export type MetadataReconcileResult = {
  status: number;
  paste?: PasteSummary;
  credentialProbe?: "intended" | "authorization";
};

export type DeleteResult = MutationFailure & { status: number };

export type MutationEffect =
  | { type: "invalidate-sync" }
  | { type: "invalidate-history"; reason: "mutation" | "remote-apply" | "terminal" | "delete" }
  | { type: "dispatch-content"; token: number; content: string; intent: Extract<MutationIntent, { kind: "content" }>; capture: BaselineCapture }
  | {
      type: "dispatch-metadata-reconcile";
      mutationToken: number;
      requestToken: number;
      intent: NonContentMutationIntent;
      credentialProbe: "authorization";
      authorizationPassword: string | null;
    }
  | { type: "autosave-slot-available" }
  | {
      type: "apply-authoritative";
      kind: "content" | "metadata" | "reconciled-applied" | "reconciled-not-applied" | "pause";
      acceptedSource?: string;
      version?: string;
      state?: "password-required" | "not-found" | "conflict";
      failureStatus?: number | null;
    }
  | { type: "pause"; state: "password-required" | "not-found" | "conflict"; failureStatus: number | null }
  | { type: "root-handoff" }
  | { type: "dispose-server-capabilities"; phase: PastePhase }
  | { type: "terminal-settled"; key: string };

export type MutationDispatch = {
  kind: "dispatch";
  type: "dispatch-content" | "dispatch-metadata" | "dispatch-delete";
  token: number;
  intent: MutationIntent;
  capture: BaselineCapture;
  version: string | null;
};

export type MutationStart = MutationDispatch | { kind: "blocked"; reason: "slot-occupied" | "terminal" | "version-unusable" };

export type ContentReconcileDispatch = {
  kind: "dispatch";
  type: "reconcile-content";
  mutationToken: number;
  requestToken: number;
  capture: BaselineCapture & { inFlightContent: string };
  authorizationPassword: string | null;
  cache: "no-store";
  ifNoneMatch: null;
};

export type MetadataReconcileDispatch =
  | { kind: "blocked"; reason: "not-reconciling" | "terminal" }
  | {
      kind: "dispatch";
      type: "reconcile-settings";
      mutationToken: number;
      requestToken: number;
      intent: NonContentMutationIntent;
      credentialProbe: "intended" | "authorization" | "current";
      authorizationPassword: string | null;
    }
  | {
      kind: "dispatch";
      type: "dispatch-relative-expiration-retry";
      token: number;
      intent: Extract<NonContentMutationIntent, { kind: "settings-expiration" }>;
      now: number;
    };

export interface PasteControllerSnapshot extends AcceptedPasteState {
  lastSavedContent: string;
  mutation: MutationSlot;
  coalescedSource: string | null;
  phase: PastePhase;
  credential: CredentialState;
  autosave: {
    state: "clean" | "waiting" | "saving" | "saved" | "error" | "password-required" | "not-found" | "conflict";
    confirmedAt: string | null;
    failedAt: string | null;
  };
  lastAction: LastAction;
  conflictCandidate: { source: string; paste: PasteSummary } | null;
  terminalResponseSource: string | null;
  reconciliationRequired: boolean;
  serverCapabilities: boolean;
}

export interface PasteControllerOptions {
  accepted: AcceptedPasteState;
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
  startContentReconcile(at?: number): ContentReconcileDispatch | { kind: "blocked"; reason: "not-reconciling" | "terminal" };
  acceptContentReconcile(token: number, result: ContentReconcileResult, at?: number): boolean;
  startMetadataReconcile(at?: number): MetadataReconcileDispatch;
  acceptMetadataReconcile(token: number, result: MetadataReconcileResult, at?: number): boolean;
  acceptDeleteMutation(token: number, result: DeleteResult, at?: number): boolean;
  setPendingCredential(value: string | null): void;
  retireForRemoteApply(): void;
  enterTerminal(phase: Extract<PastePhase, "consumed" | "not-found" | "delete-uncertain">, at?: number, origin?: TerminalOriginSettleContext): void;
}

const sourceActivityEvents = new Set<SourceEvent["type"]>(["input", "composition-end", "crepe-change"]);

type InternalState = Omit<PasteControllerSnapshot, "mutation">;

type MetadataRequest = {
  requestToken: number;
  token: number;
  probe: "intended" | "authorization" | "current";
};

function instant(at: number | undefined): string {
  return new Date(at ?? Date.now()).toISOString();
}

function generationOf(version: string): string | "legacy" {
  return version === "legacy" ? "legacy" : version;
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
  return (
    left.acceptedApplyGeneration === state.acceptedApplyGeneration &&
    left.generation === generationOf(state.version) &&
    left.version === state.version &&
    left.contentRevision === state.contentRevision &&
    left.updatedAt === state.updatedAt &&
    left.acceptedSource === state.acceptedSource
  );
}

function isUncertain(failure: MutationFailure): boolean {
  return (
    failure.mutationMayHaveApplied === true ||
    failure.status === null ||
    failure.status === 500 ||
    (failure.status === 503 && failure.mutationMayHaveApplied !== false)
  );
}

function actionKey(intent: MutationIntent): ActionKey {
  return intent.action;
}

function etagOf(result: { etag?: `"sha256-${string}"`; responseEtag?: `"sha256-${string}"` }): `"sha256-${string}"` | null {
  return result.etag ?? result.responseEtag ?? null;
}

function sourceOf(result: ContentReconcileResult): string | undefined {
  return result.content ?? result.source;
}

function isRelativeExpiration(intent: NonContentMutationIntent): boolean {
  return intent.kind === "settings-expiration" && typeof intent.expiration === "number";
}

function matchesExpiration(input: ExpirationInput, paste: PasteSummary): boolean {
  if (input === null || input === "never") return paste.expiration.kind === "permanent";
  return typeof input === "string" && paste.expiration.kind === "absolute" && paste.expiresAt === input;
}

function targetsMetadata(intent: NonContentMutationIntent, paste: PasteSummary): boolean {
  switch (intent.kind) {
    case "settings-title":
      return paste.title === intent.title;
    case "settings-format":
      return paste.format === intent.format;
    case "settings-view-once":
      return paste.viewOnce === intent.viewOnce;
    case "settings-expiration":
      return !isRelativeExpiration(intent) && matchesExpiration(intent.expiration, paste);
    case "password-set":
      return paste.protected === (intent.newPassword !== "");
    case "password-clear":
      return !paste.protected;
  }
}

export function createPasteController(options: PasteControllerOptions): PasteController {
  const initial = options.accepted;
  let state: InternalState = {
    ...initial,
    lastSavedContent: initial.acceptedSource,
    coalescedSource: null,
    phase: "ordinary",
    credential: { committed: null, pending: null },
    autosave: { state: "clean", confirmedAt: null, failedAt: null },
    lastAction: { state: "idle" },
    conflictCandidate: null,
    terminalResponseSource: null,
    reconciliationRequired: false,
    serverCapabilities: true,
  };
  let nextToken = 0;
  let nextReconcileToken = 0;
  let slot: MutationSlot = { state: "idle", nextToken };
  let metadataRequest: MetadataRequest | undefined;
  let effects: MutationEffect[] = [];

  const snapshot = (): Readonly<PasteControllerSnapshot> => ({ ...state, mutation: slot });

  const setLastAction = (intent: MutationIntent, at: number | undefined): void => {
    const startedAt = instant(at);
    state = { ...state, lastAction: { state: "pending", key: actionKey(intent), attempt: nextToken, startedAt } as LastAction };
  };

  const settleLastAction = (stateName: "succeeded" | "failed", at: number | undefined, outcomeKey: TerminalOutcomeKey | null = null): void => {
    if (state.lastAction.state !== "pending") return;
    state = {
      ...state,
      lastAction: {
        state: stateName,
        key: state.lastAction.key,
        attempt: state.lastAction.attempt,
        startedAt: state.lastAction.startedAt,
        settledAt: instant(at),
        outcomeKey,
      } as LastAction,
    };
  };

  const invalidate = (reason: "mutation" | "remote-apply" | "terminal" | "delete"): void => {
    effects.push({ type: "invalidate-sync" }, { type: "invalidate-history", reason });
  };

  const release = (eligibleForAutosave: boolean, at: number | undefined): void => {
    slot = { state: "idle", nextToken };
    metadataRequest = undefined;
    if (!eligibleForAutosave) return;
    effects.push({ type: "autosave-slot-available" });
    dispatchCoalesced(at);
  };

  const dispatchCoalesced = (at: number | undefined): void => {
    const content = state.coalescedSource;
    state = { ...state, coalescedSource: null };
    if (content === null || content === state.acceptedSource || state.phase !== "ordinary" || !state.versionUsable) return;
    const dispatched = startMutation({ kind: "content", action: "autosave", content, omitVersion: false }, at);
    if (dispatched.kind !== "dispatch") return;
    effects.push({ type: "dispatch-content", token: dispatched.token, content, intent: dispatched.intent as Extract<MutationIntent, { kind: "content" }>, capture: dispatched.capture });
  };

  const begin = (intent: MutationIntent, at: number | undefined): MutationDispatch => {
    state = { ...state, localGeneration: state.localGeneration + 1, conflictCandidate: null };
    invalidate(intent.kind === "delete" ? "delete" : "mutation");
    const token = ++nextToken;
    const baseline = capture(state);
    slot = { state: "in-flight", token, intent, capture: baseline };
    setLastAction(intent, at);
    return {
      kind: "dispatch",
      type: intent.kind === "content" ? "dispatch-content" : intent.kind === "delete" ? "dispatch-delete" : "dispatch-metadata",
      token,
      intent,
      capture: baseline,
      version: intent.kind === "content" && intent.omitVersion ? null : state.version,
    };
  };

  const startMutation = (intent: MutationIntent, at?: number): MutationStart => {
    if (intent.kind === "content" && intent.omitVersion !== (intent.action === "overwrite")) {
      throw new TypeError("content omitVersion must match overwrite action");
    }
    if (state.phase !== "ordinary" || !state.serverCapabilities) return { kind: "blocked", reason: "terminal" };
    if (slot.state !== "idle") {
      if (intent.kind === "content") state = { ...state, coalescedSource: intent.content };
      return { kind: "blocked", reason: "slot-occupied" };
    }
    if (intent.kind === "content" && !intent.omitVersion && !state.versionUsable) return { kind: "blocked", reason: "version-unusable" };
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

  const acceptContentMutation = (token: number, result: MutationSuccess, at?: number): boolean => {
    if (slot.state !== "in-flight" || slot.token !== token || slot.intent.kind !== "content" || !sameAcceptedBaseline(slot.capture, state)) return false;
    const intent = slot.intent;
    state = {
      ...state,
      acceptedSource: intent.content,
      lastSavedContent: intent.content,
      summary: result.paste,
      version: result.paste.version,
      versionUsable: true,
      contentRevision: result.paste.contentRevision,
      updatedAt: result.paste.updatedAt,
      responseEtag: etagOf(result),
      autosave: {
        state: state.draft === intent.content ? "saved" : "waiting",
        confirmedAt: instant(at),
        failedAt: null,
      },
      reconciliationRequired: false,
    };
    settleLastAction("succeeded", at);
    effects.push({ type: "apply-authoritative", kind: "content", acceptedSource: intent.content, version: result.paste.version });
    release(true, at);
    return true;
  };

  const acceptMetadata = (token: number, intent: NonContentMutationIntent, baseline: BaselineCapture, result: MutationSuccess, at?: number): boolean => {
    if (!sameAcceptedBaseline(baseline, state)) {
      slot = { state: "metadata-reconciliation", token, intent, capture: baseline };
      state = { ...state, responseEtag: null, reconciliationRequired: true };
      return false;
    }
    state = {
      ...state,
      summary: result.paste,
      version: result.paste.version,
      versionUsable: true,
      contentRevision: result.paste.contentRevision,
      updatedAt: result.paste.updatedAt,
      responseEtag: null,
      reconciliationRequired: false,
    };
    if (intent.kind === "password-set") state = { ...state, credential: { committed: intent.newPassword === "" ? null : intent.newPassword, pending: null } };
    if (intent.kind === "password-clear") state = { ...state, credential: { committed: null, pending: null } };
    settleLastAction("succeeded", at);
    effects.push({ type: "apply-authoritative", kind: "metadata", acceptedSource: state.acceptedSource, version: result.paste.version });
    release(true, at);
    return true;
  };

  const acceptMetadataMutation = (token: number, result: MutationSuccess, at?: number): boolean => {
    if (slot.state !== "in-flight" || slot.token !== token || slot.intent.kind === "content" || slot.intent.kind === "delete") return false;
    return acceptMetadata(token, slot.intent, slot.capture, result, at);
  };

  const settleContentFailure = (current: Extract<MutationSlot, { state: "in-flight" }>, failure: MutationFailure, at?: number): boolean => {
    const intent = current.intent as Extract<MutationIntent, { kind: "content" }>;
    if (failure.status === 404) {
      settleLastAction("failed", at);
      enterTerminal("not-found", at);
      return true;
    }
    if (failure.status === 409) {
      state = {
        ...state,
        versionUsable: false,
        autosave: { state: "conflict", confirmedAt: state.autosave.confirmedAt, failedAt: instant(at) },
      };
      settleLastAction("failed", at);
      effects.push({ type: "apply-authoritative", kind: "pause", state: "conflict", failureStatus: 409 });
      release(false, at);
      return true;
    }
    if (isUncertain(failure)) {
      slot = {
        state: "content-reconciliation",
        token: current.token,
        originActionKey: intent.action,
        capture: { ...current.capture, inFlightContent: intent.content },
        laterDraft: state.draft,
        requestToken: 0,
      };
      state = {
        ...state,
        responseEtag: null,
        reconciliationRequired: true,
        autosave: { state: "error", confirmedAt: state.autosave.confirmedAt, failedAt: instant(at) },
      };
      settleLastAction("failed", at);
      return true;
    }
    const autosaveState = failure.status === 403 ? "password-required" : "error";
    state = { ...state, autosave: { state: autosaveState, confirmedAt: state.autosave.confirmedAt, failedAt: instant(at) } };
    settleLastAction("failed", at);
    if (failure.status === 403) effects.push({ type: "pause", state: "password-required", failureStatus: 403 });
    release(false, at);
    return true;
  };

  const settleMetadataFailure = (current: Extract<MutationSlot, { state: "in-flight" }>, failure: MutationFailure, at?: number): boolean => {
    const intent = current.intent as NonContentMutationIntent | Extract<MutationIntent, { kind: "delete" }>;
    if (intent.kind === "delete") {
      return acceptDeleteMutation(
        current.token,
        { status: failure.status ?? 503, ...(failure.mutationMayHaveApplied === undefined ? {} : { mutationMayHaveApplied: failure.mutationMayHaveApplied }) },
        at,
      );
    }
    if (failure.status === 404) {
      settleLastAction("failed", at);
      enterTerminal("not-found", at);
      return true;
    }
    if (failure.status === 409) {
      state = { ...state, versionUsable: false, autosave: { state: "conflict", confirmedAt: state.autosave.confirmedAt, failedAt: instant(at) } };
      settleLastAction("failed", at);
      effects.push({ type: "pause", state: "conflict", failureStatus: 409 });
      release(false, at);
      return true;
    }
    if (isUncertain(failure)) {
      slot = { state: "metadata-reconciliation", token: current.token, intent, capture: current.capture };
      state = { ...state, responseEtag: null, reconciliationRequired: true };
      settleLastAction("failed", at);
      return true;
    }
    settleLastAction("failed", at);
    if (failure.status === 403) {
      state = { ...state, autosave: { state: "password-required", confirmedAt: state.autosave.confirmedAt, failedAt: instant(at) } };
      effects.push({ type: "pause", state: "password-required", failureStatus: 403 });
      release(false, at);
      return true;
    }
    release(failure.status === 503 && failure.mutationMayHaveApplied === false, at);
    return true;
  };

  const failMutation = (token: number, failure: MutationFailure, at?: number): boolean => {
    if (slot.state !== "in-flight" || slot.token !== token) return false;
    if (!sameAcceptedBaseline(slot.capture, state)) return false;
    return slot.intent.kind === "content" ? settleContentFailure(slot, failure, at) : settleMetadataFailure(slot, failure, at);
  };

  const startContentReconcile = (at?: number): ContentReconcileDispatch | { kind: "blocked"; reason: "not-reconciling" | "terminal" } => {
    if (state.phase !== "ordinary") return { kind: "blocked", reason: "terminal" };
    if (slot.state !== "content-reconciliation") return { kind: "blocked", reason: "not-reconciling" };
    const requestToken = ++nextReconcileToken;
    slot = { ...slot, requestToken };
    const startedAt = instant(at);
    state = { ...state, lastAction: { state: "pending", key: "content-reconcile", attempt: requestToken, startedAt } };
    return {
      kind: "dispatch",
      type: "reconcile-content",
      mutationToken: slot.token,
      requestToken,
      capture: slot.capture,
      authorizationPassword: state.credential.pending ?? state.credential.committed,
      cache: "no-store",
      ifNoneMatch: null,
    };
  };

  const acceptContentReconcile = (requestToken: number, result: ContentReconcileResult, at?: number): boolean => {
    if (slot.state !== "content-reconciliation" || slot.requestToken !== requestToken || !sameAcceptedBaseline(slot.capture, state)) return false;
    if (result.status === 403) {
      state = { ...state, autosave: { state: "password-required", confirmedAt: state.autosave.confirmedAt, failedAt: instant(at) } };
      settleLastAction("failed", at);
      effects.push({ type: "pause", state: "password-required", failureStatus: 403 });
      return true;
    }
    if (result.status === 404) {
      settleLastAction("failed", at);
      effects.push({ type: "pause", state: "not-found", failureStatus: 404 });
      enterTerminal("not-found", at);
      return true;
    }
    if (result.status !== 200 || result.paste === undefined || sourceOf(result) === undefined) {
      settleLastAction("failed", at);
      return true;
    }
    const content = sourceOf(result)!;
    if (result.paste.viewOnce) {
      state = { ...state, terminalResponseSource: content };
      const origin: TerminalOriginSettleContext = state.lastAction.state === "pending"
        ? { actionKey: "content-reconcile", actionAttempt: state.lastAction.attempt, startedAt: state.lastAction.startedAt }
        : { actionKey: "content-reconcile", actionAttempt: requestToken, startedAt: instant(at) };
      enterTerminal("consumed", at, origin);
      return true;
    }
    if (content === slot.capture.inFlightContent) {
      state = {
        ...state,
        acceptedSource: content,
        lastSavedContent: content,
        summary: result.paste,
        version: result.paste.version,
        versionUsable: true,
        contentRevision: result.paste.contentRevision,
        updatedAt: result.paste.updatedAt,
        responseEtag: etagOf(result),
        reconciliationRequired: false,
        autosave: { state: state.draft === content ? "saved" : "waiting", confirmedAt: instant(at), failedAt: null },
      };
      settleLastAction("succeeded", at);
      effects.push({ type: "apply-authoritative", kind: "reconciled-applied", acceptedSource: content, version: result.paste.version });
      release(true, at);
      return true;
    }
    const baselineMatches = content === slot.capture.acceptedSource &&
      result.paste.version === slot.capture.version &&
      result.paste.contentRevision === slot.capture.contentRevision &&
      result.paste.updatedAt === slot.capture.updatedAt;
    if (slot.capture.inFlightContent !== slot.capture.acceptedSource && baselineMatches) {
      state = {
        ...state,
        summary: result.paste,
        version: result.paste.version,
        contentRevision: result.paste.contentRevision,
        updatedAt: result.paste.updatedAt,
        responseEtag: etagOf(result),
        reconciliationRequired: false,
        autosave: { state: "error", confirmedAt: state.autosave.confirmedAt, failedAt: state.autosave.failedAt ?? instant(at) },
      };
      settleLastAction("failed", at);
      effects.push({ type: "apply-authoritative", kind: "reconciled-not-applied", acceptedSource: content, version: result.paste.version });
      release(false, at);
      return true;
    }
    state = {
      ...state,
      conflictCandidate: { source: content, paste: result.paste },
      reconciliationRequired: false,
      autosave: { state: "conflict", confirmedAt: state.autosave.confirmedAt, failedAt: instant(at) },
    };
    settleLastAction("failed", at);
    effects.push({ type: "apply-authoritative", kind: "pause", state: "conflict", failureStatus: null });
    release(false, at);
    return true;
  };

  const startMetadataReconcile = (at?: number): MetadataReconcileDispatch => {
    if (state.phase !== "ordinary") return { kind: "blocked", reason: "terminal" };
    if (slot.state !== "metadata-reconciliation") return { kind: "blocked", reason: "not-reconciling" };
    if (isRelativeExpiration(slot.intent)) {
      const previous = slot;
      if (previous.intent.kind !== "settings-expiration") return { kind: "blocked", reason: "not-reconciling" };
      const retryIntent: Extract<MutationIntent, { kind: "settings-expiration" }> = {
        kind: "settings-expiration",
        action: "settings-reconcile",
        expiration: previous.intent.expiration,
      };
      slot = { state: "idle", nextToken };
      const retry = begin(retryIntent, at);
      state = { ...state, reconciliationRequired: true };
      return { kind: "dispatch", type: "dispatch-relative-expiration-retry", token: retry.token, intent: retryIntent, now: at ?? Date.now() };
    }
    const requestToken = ++nextReconcileToken;
    const probe = slot.intent.kind === "password-set" || slot.intent.kind === "password-clear" ? "intended" : "current";
    metadataRequest = { requestToken, token: slot.token, probe };
    const reconciliationKey = slot.intent.kind === "password-set" || slot.intent.kind === "password-clear" ? "password-reconcile" : "settings-reconcile";
    state = { ...state, lastAction: { state: "pending", key: reconciliationKey, attempt: requestToken, startedAt: instant(at) } };
    const authorizationPassword = probe === "intended"
      ? slot.intent.kind === "password-set" ? slot.intent.newPassword : null
      : state.credential.pending ?? state.credential.committed;
    return { kind: "dispatch", type: "reconcile-settings", mutationToken: slot.token, requestToken, intent: slot.intent, credentialProbe: probe, authorizationPassword };
  };

  const acceptMetadataReconcile = (requestToken: number, result: MetadataReconcileResult, at?: number): boolean => {
    if (slot.state !== "metadata-reconciliation" || metadataRequest?.requestToken !== requestToken || metadataRequest.token !== slot.token) return false;
    const current = slot;
    if (result.status === 403) {
      if ((current.intent.kind === "password-set" || current.intent.kind === "password-clear") && metadataRequest.probe === "intended") {
        const intendedCredential = current.intent.kind === "password-set" ? current.intent.newPassword : null;
        if (intendedCredential !== current.intent.authorizationPassword) {
          const nextRequest = ++nextReconcileToken;
          metadataRequest = { requestToken: nextRequest, token: current.token, probe: "authorization" };
          effects.push({
            type: "dispatch-metadata-reconcile",
            mutationToken: current.token,
            requestToken: nextRequest,
            intent: current.intent,
            credentialProbe: "authorization",
            authorizationPassword: current.intent.authorizationPassword,
          });
          return true;
        }
      }
      settleLastAction("failed", at);
      state = { ...state, autosave: { state: "password-required", confirmedAt: state.autosave.confirmedAt, failedAt: instant(at) } };
      effects.push({ type: "pause", state: "password-required", failureStatus: 403 });
      return true;
    }
    if (result.status === 404) {
      settleLastAction("failed", at);
      enterTerminal("not-found", at);
      return true;
    }
    if (result.status === 503) return false;
    if ((result.status !== 200 && result.status !== 304) || !sameAcceptedBaseline(current.capture, state)) return false;
    const probe = result.credentialProbe ?? metadataRequest.probe;
    if ((current.intent.kind === "password-set" || current.intent.kind === "password-clear") && probe === "intended" && result.status === 304) {
      const committed = current.intent.kind === "password-set" && current.intent.newPassword !== "" ? current.intent.newPassword : null;
      state = { ...state, credential: { committed, pending: null }, reconciliationRequired: false };
      settleLastAction("succeeded", at);
      release(false, at);
      return true;
    }
    if ((current.intent.kind === "password-set" || current.intent.kind === "password-clear") && probe === "authorization") {
      state = { ...state, credential: { committed: current.intent.authorizationPassword, pending: null }, reconciliationRequired: false };
      settleLastAction("failed", at);
      release(false, at);
      return true;
    }
    if (result.status === 304 || result.paste === undefined) return false;
    if (!targetsMetadata(current.intent, result.paste)) {
      state = { ...state, reconciliationRequired: false };
      settleLastAction("failed", at);
      release(false, at);
      return true;
    }
    return acceptMetadata(current.token, current.intent, current.capture, { changed: true, paste: result.paste }, at);
  };

  const acceptDeleteMutation = (token: number, result: DeleteResult, at?: number): boolean => {
    if (slot.state !== "in-flight" || slot.token !== token || slot.intent.kind !== "delete" || !sameAcceptedBaseline(slot.capture, state)) return false;
    if (result.status === 204) {
      state = {
        ...state,
        acceptedSource: "",
        draft: "",
        lastSavedContent: "",
        credential: { committed: null, pending: null },
        serverCapabilities: false,
        coalescedSource: null,
      };
      settleLastAction("succeeded", at);
      effects.push({ type: "root-handoff" });
      release(false, at);
      return true;
    }
    if (result.status === 403) {
      state = { ...state, autosave: { state: "password-required", confirmedAt: state.autosave.confirmedAt, failedAt: instant(at) } };
      settleLastAction("failed", at);
      effects.push({ type: "pause", state: "password-required", failureStatus: 403 });
      release(false, at);
      return true;
    }
    if (result.status === 409) {
      state = { ...state, versionUsable: false, autosave: { state: "conflict", confirmedAt: state.autosave.confirmedAt, failedAt: instant(at) } };
      settleLastAction("failed", at);
      effects.push({ type: "pause", state: "conflict", failureStatus: 409 });
      release(false, at);
      return true;
    }
    if (result.status === 404) {
      settleLastAction("failed", at);
      enterTerminal("not-found", at);
      return true;
    }
    if (result.status === 503 || result.mutationMayHaveApplied === true) {
      settleLastAction("failed", at);
      enterTerminal("delete-uncertain", at);
      return true;
    }
    settleLastAction("failed", at);
    release(false, at);
    return true;
  };

  const setPendingCredential = (value: string | null): void => {
    state = { ...state, credential: { ...state.credential, pending: value } };
  };

  const retireForRemoteApply = (): void => {
    nextToken += 1;
    slot = { state: "idle", nextToken };
    metadataRequest = undefined;
    state = { ...state, coalescedSource: null, reconciliationRequired: false };
    invalidate("remote-apply");
  };

  const enterTerminal = (phase: Extract<PastePhase, "consumed" | "not-found" | "delete-uncertain">, at?: number, origin?: TerminalOriginSettleContext): void => {
    if (state.phase !== "ordinary") return;
    const pending = origin ?? (state.lastAction.state === "pending" && state.lastAction.key === "content-reconcile"
      ? { actionKey: "content-reconcile" as const, actionAttempt: state.lastAction.attempt, startedAt: state.lastAction.startedAt }
      : undefined);
    nextToken += 1;
    slot = { state: "idle", nextToken };
    metadataRequest = undefined;
    state = {
      ...state,
      phase,
      serverCapabilities: false,
      coalescedSource: null,
      responseEtag: null,
      reconciliationRequired: false,
      autosave: {
        state: phase === "not-found" ? "not-found" : state.autosave.state,
        confirmedAt: state.autosave.confirmedAt,
        failedAt: phase === "not-found" ? instant(at) : state.autosave.failedAt,
      },
    };
    invalidate("terminal");
    effects.push({ type: "dispose-server-capabilities", phase });
    if (pending !== undefined) {
      const outcomeKey = pending.actionKey === "content-reconcile"
        ? "content-reconcile-terminal-current-kept"
        : "reload-terminal-current-unchanged";
      state = {
        ...state,
        lastAction: {
          state: phase === "consumed" ? "succeeded" : "failed",
          key: pending.actionKey,
          attempt: pending.actionAttempt,
          startedAt: pending.startedAt,
          settledAt: instant(at),
          outcomeKey,
        },
      };
      effects.push({ type: "terminal-settled", key: outcomeKey });
    }
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
  };
}
