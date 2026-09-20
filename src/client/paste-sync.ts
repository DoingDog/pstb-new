import type {
  AutosyncStatus,
  BaselineCapture,
  PastePhase,
  PasteSummary,
  RemoteOrder,
  RemoteSnapshot,
} from "./contracts";

const CADENCE_MS = 3_000;
const ACTIVE_WINDOW_MS = 300_000;

type Etag = `"sha256-${string}"`;

declare const remoteApplyAttemptBrand: unique symbol;
export type RemoteApplyAttempt = { readonly [remoteApplyAttemptBrand]: never };

function baselineVersionCounter(baseline: BaselineCapture): number | null {
  if (baseline.generation === "legacy") return null;
  const separator = baseline.version.lastIndexOf(".");
  if (separator < 1 || baseline.version.slice(0, separator) !== baseline.generation) return null;
  const counterText = baseline.version.slice(separator + 1);
  if (!/^[1-9]\d*$/.test(counterText)) return null;
  const counter = Number(counterText);
  return Number.isSafeInteger(counter) ? counter : null;
}

export function classifyRemote(snapshot: RemoteSnapshot, baseline: BaselineCapture): RemoteOrder {
  if (snapshot.identity.kind === "legacy" || baseline.generation === "legacy") {
    return snapshot.identity.kind === "legacy"
      && baseline.generation === "legacy"
      && snapshot.summary.version === baseline.version
      && snapshot.contentRevision === baseline.contentRevision
      && snapshot.updatedAtMs === Date.parse(baseline.updatedAt)
      ? "marker-equal"
      : "incomparable";
  }

  const baselineCounter = baselineVersionCounter(baseline);
  const baselineUpdatedAt = Date.parse(baseline.updatedAt);
  if (
    snapshot.identity.generation !== baseline.generation
    || baselineCounter === null
    || !Number.isFinite(baselineUpdatedAt)
  ) return "incomparable";

  const comparisons = [
    snapshot.identity.versionCounter - baselineCounter,
    snapshot.contentRevision - baseline.contentRevision,
    snapshot.updatedAtMs - baselineUpdatedAt,
  ];
  if (comparisons.every((comparison) => comparison === 0)) return "marker-equal";
  if (comparisons.every((comparison) => comparison <= 0)) return "definitely-older";
  if (comparisons.every((comparison) => comparison >= 0)) return "definitely-newer";
  return "incomparable";
}

export interface PasteSyncCapture {
  phase: PastePhase;
  activeUntil: number;
  locallyClean: boolean;
  offline: boolean;
  localGeneration: number;
  acceptedApplyGeneration: number;
  baseline: BaselineCapture;
  acceptedSummary: PasteSummary;
  responseEtag: Etag | null;
}

export type PasteSyncEvent =
  | { type: "state"; state: AutosyncStatus; at: number | null }
  | { type: "unchanged"; etag: Etag; checkedAt: number }
  | { type: "proven-newer"; snapshot: RemoteSnapshot; capture: PasteSyncCapture; attempt: RemoteApplyAttempt; checkedAt: number }
  | { type: "candidate"; snapshot: RemoteSnapshot; capture: PasteSyncCapture; checkedAt: number }
  | { type: "terminal-view-once"; snapshot: RemoteSnapshot; capture: PasteSyncCapture; ordinaryTokenCurrent: boolean; receivedAt: number }
  | { type: "credential-proved"; password: string; at: number }
  | { type: "not-found" | "forbidden" | "conflict"; at: number }
  | { type: "error"; at: number; transport?: "network" };

export interface PasteSyncController {
  start(loadAt: number): void;
  recordUserActivity(activityAt: number): void;
  localWorkChanged(): void;
  localWorkSettled(settledAt: number): void;
  setOnline(online: boolean, eventAt: number): void;
  keepCurrent(actionAt: number): void;
  retrySync(actionAt: number, pendingCredential: string | null): boolean;
  completeRemoteApply(attempt: RemoteApplyAttempt, committedAt: number): boolean;
  cancelRemoteApply(attempt: RemoteApplyAttempt, cancelledAt: number): boolean;
  dispose(): void;
}

export interface PasteSyncTimer {
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface PasteSyncReadRequest {
  ifNoneMatch?: Etag;
  password: string | null;
  signal: AbortSignal;
}

export type PasteSyncReadResult =
  | { status: 200; snapshot: RemoteSnapshot }
  | { status: 304; etag: Etag }
  | { status: 403 }
  | { status: 404 }
  | { status: 409 }
  | { status: number; transport?: "network" };

function hasSnapshot(result: PasteSyncReadResult): result is Extract<PasteSyncReadResult, { snapshot: RemoteSnapshot }> {
  return result.status === 200 && "snapshot" in result;
}

function hasEtag(result: PasteSyncReadResult): result is Extract<PasteSyncReadResult, { etag: Etag }> {
  return result.status === 304 && "etag" in result;
}

function samePublicSummary(left: PasteSummary, right: PasteSummary): boolean {
  return left.id === right.id
    && left.title === right.title
    && left.format === right.format
    && left.viewOnce === right.viewOnce
    && left.protected === right.protected
    && left.createdAt === right.createdAt
    && left.updatedAt === right.updatedAt
    && left.expiresAt === right.expiresAt
    && left.expiration.kind === right.expiration.kind
    && (left.expiration.kind !== "relative" || (right.expiration.kind === "relative" && left.expiration.seconds === right.expiration.seconds))
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

export interface PasteSyncOptions {
  now: () => number;
  timer: PasteSyncTimer;
  AbortController: typeof AbortController;
  capture: () => PasteSyncCapture;
  read: (request: PasteSyncReadRequest) => Promise<PasteSyncReadResult>;
  emit: (event: PasteSyncEvent) => void;
}

interface InFlightRead {
  token: number;
  capture: PasteSyncCapture;
  controller: AbortController;
  password: string | null;
}

interface Candidate {
  snapshot: RemoteSnapshot;
  capture: PasteSyncCapture;
}

export class PasteSync implements PasteSyncController {
  private activeUntil = 0;
  private syncDueAt: number | null = null;
  private timerHandle: unknown | null = null;
  private inFlight: InFlightRead | null = null;
  private requestToken = 0;
  private started = false;
  private disposed = false;
  private localDirty = false;
  private online = true;
  private retryWithoutValidator = false;
  private retryCredential: string | null = null;
  private retryRequired = false;
  private candidate: Candidate | null = null;
  private locallyCleanOverride = false;
  private remoteApplyAttempt: RemoteApplyAttempt | null = null;
  private permanentlyStopped = false;
  private terminal = false;
  private state: AutosyncStatus = "inactive";

  constructor(private readonly options: PasteSyncOptions) {}

  start(loadAt: number): void {
    if (this.started || this.disposed) return;

    this.started = true;
    this.activeUntil = loadAt + ACTIVE_WINDOW_MS;
    const current = this.options.capture();
    this.online = !current.offline;

    if (current.phase !== "ordinary") {
      this.setState("inactive", loadAt);
      return;
    }
    if (!this.online) {
      this.setState("paused-offline", loadAt);
      this.armTimer();
      return;
    }
    if (!current.locallyClean) {
      this.setState("paused-local", loadAt);
      this.armTimer();
      return;
    }

    this.syncDueAt = loadAt + CADENCE_MS;
    this.setState("waiting", null);
    this.armTimer();
  }

  recordUserActivity(activityAt: number): void {
    if (!this.started || this.disposed || this.terminal || this.permanentlyStopped) return;

    this.activeUntil = activityAt + ACTIVE_WINDOW_MS;
    this.armTimer();
  }

  localWorkChanged(): void {
    if (!this.started || this.disposed || this.terminal || this.permanentlyStopped) return;

    this.localDirty = true;
    this.syncDueAt = null;
    this.candidate = null;
    this.locallyCleanOverride = false;
    this.remoteApplyAttempt = null;
    this.clearRetryIntent();
    this.invalidateRead();
    if (this.isActive() && !this.retryRequired) this.setState("paused-local", this.options.now());
    this.armTimer();
  }

  localWorkSettled(settledAt: number): void {
    if (!this.started || this.disposed || this.terminal || this.permanentlyStopped) return;

    this.localDirty = false;
    if (this.retryRequired) {
      this.armTimer();
      return;
    }
    if (this.isEligible()) {
      this.syncDueAt = this.inFlight === null ? settledAt + CADENCE_MS : null;
      this.setState("waiting", settledAt);
    } else {
      this.syncDueAt = null;
      this.setPausedState(settledAt);
    }
    this.armTimer();
  }

  setOnline(online: boolean, eventAt: number): void {
    if (!this.started || this.disposed || this.terminal || this.permanentlyStopped) return;

    this.online = online;
    if (!online) {
      this.syncDueAt = null;
      this.candidate = null;
      this.locallyCleanOverride = false;
      this.remoteApplyAttempt = null;
      this.clearRetryIntent();
      this.invalidateRead();
      if (this.isActive() && !this.retryRequired) this.setState("paused-offline", eventAt);
      this.armTimer();
      return;
    }

    if (this.retryRequired) {
      this.armTimer();
      return;
    }
    if (this.isEligible()) {
      this.syncDueAt = this.inFlight === null ? eventAt + CADENCE_MS : null;
      this.setState("waiting", eventAt);
    } else {
      this.syncDueAt = null;
      this.setPausedState(eventAt);
    }
    this.armTimer();
  }

  keepCurrent(actionAt: number): void {
    if (!this.canDismissCandidate()) return;

    this.candidate = null;
    this.locallyCleanOverride = true;
    this.syncDueAt = actionAt + CADENCE_MS;
    this.setState("waiting", actionAt);
    this.armTimer();
  }

  retrySync(actionAt: number, pendingCredential: string | null): boolean {
    if (
      !this.started
      || this.disposed
      || this.terminal
      || this.permanentlyStopped
      || this.inFlight !== null
      || !this.isActive()
      || (!this.isEligible() && !this.canDismissCandidate() && !this.canRetryForbidden())
    ) return false;

    const dismissingCandidate = this.candidate !== null;
    this.retryRequired = false;
    this.candidate = null;
    this.locallyCleanOverride = dismissingCandidate;
    this.retryWithoutValidator = dismissingCandidate;
    this.retryCredential = pendingCredential;
    this.syncDueAt = actionAt + CADENCE_MS;
    this.setState("waiting", actionAt);
    this.armTimer();
    return true;
  }

  completeRemoteApply(attempt: RemoteApplyAttempt, committedAt: number): boolean {
    if (!this.canSettleRemoteApply(attempt)) return false;

    this.remoteApplyAttempt = null;
    this.locallyCleanOverride = true;
    this.setState("remote-applied", committedAt);
    this.scheduleAfterSettle(committedAt);
    return true;
  }

  cancelRemoteApply(attempt: RemoteApplyAttempt, cancelledAt: number): boolean {
    if (!this.canSettleRemoteApply(attempt)) return false;

    this.remoteApplyAttempt = null;
    this.locallyCleanOverride = true;
    this.options.emit({ type: "error", at: cancelledAt });
    this.setState("error", cancelledAt);
    this.scheduleAfterSettle(cancelledAt);
    return true;
  }

  dispose(): void {
    if (this.disposed) return;

    this.disposed = true;
    this.syncDueAt = null;
    this.remoteApplyAttempt = null;
    this.clearRetryIntent();
    this.clearTimer();
    this.invalidateRead();
  }

  private isActive(): boolean {
    return this.options.now() < this.activeUntil;
  }

  private isEligible(): boolean {
    const current = this.options.capture();
    return !this.terminal
      && !this.permanentlyStopped
      && !this.retryRequired
      && this.remoteApplyAttempt === null
      && this.isActive()
      && current.phase === "ordinary"
      && (current.locallyClean || this.locallyCleanOverride)
      && !current.offline
      && this.online
      && !this.localDirty;
  }

  private canDismissCandidate(): boolean {
    const current = this.options.capture();
    return this.started
      && !this.disposed
      && !this.terminal
      && !this.permanentlyStopped
      && this.candidate !== null
      && this.isActive()
      && current.phase === "ordinary"
      && !current.offline
      && this.online
      && !this.localDirty;
  }

  private canSettleRemoteApply(attempt: RemoteApplyAttempt): boolean {
    const current = this.options.capture();
    return this.remoteApplyAttempt === attempt
      && !this.disposed
      && !this.terminal
      && !this.permanentlyStopped
      && this.isActive()
      && current.phase === "ordinary"
      && !current.offline
      && this.online
      && !this.localDirty;
  }

  private canRetryForbidden(): boolean {
    const current = this.options.capture();
    return this.retryRequired
      && current.phase === "ordinary"
      && current.locallyClean
      && !current.offline
      && this.online
      && !this.localDirty;
  }

  private clearRetryIntent(): void {
    this.retryWithoutValidator = false;
    this.retryCredential = null;
  }

  private armTimer(): void {
    this.clearTimer();
    if (!this.started || this.disposed || this.terminal) return;
    if (!this.isActive()) {
      this.expire();
      return;
    }

    const dueAt = this.inFlight === null && this.remoteApplyAttempt === null
      ? Math.min(this.syncDueAt ?? this.activeUntil, this.activeUntil)
      : this.activeUntil;
    this.timerHandle = this.options.timer.setTimeout(() => {
      this.timerHandle = null;
      this.onTimer();
    }, dueAt - this.options.now());
  }

  private clearTimer(): void {
    if (this.timerHandle === null) return;
    this.options.timer.clearTimeout(this.timerHandle);
    this.timerHandle = null;
  }

  private onTimer(): void {
    if (this.disposed || !this.started) return;
    if (!this.isActive()) {
      this.expire();
      return;
    }
    if (this.inFlight || this.remoteApplyAttempt !== null) {
      this.armTimer();
      return;
    }
    if (!this.isEligible()) {
      this.syncDueAt = null;
      this.clearRetryIntent();
      this.setPausedState(this.options.now());
      this.armTimer();
      return;
    }
    if (this.syncDueAt === null || this.options.now() < this.syncDueAt) {
      this.armTimer();
      return;
    }

    this.dispatch();
  }

  private dispatch(): void {
    const capture = this.options.capture();
    const token = ++this.requestToken;
    const controller = new this.options.AbortController();
    const password = this.retryCredential;
    const ifNoneMatch = this.retryWithoutValidator ? undefined : capture.responseEtag ?? undefined;

    this.retryCredential = null;
    this.retryWithoutValidator = false;
    this.syncDueAt = null;
    const read: InFlightRead = { token, capture, controller, password };
    this.inFlight = read;
    this.setState("checking", this.options.now());
    this.armTimer();

    const request: PasteSyncReadRequest = ifNoneMatch === undefined
      ? { password, signal: controller.signal }
      : { ifNoneMatch, password, signal: controller.signal };
    void this.options.read(request).then(
      (result) => this.handleReadResult(read, result),
      (reason) => this.handleReadFailure(read, reason),
    );
  }

  private handleReadResult(read: InFlightRead, result: PasteSyncReadResult): void {
    const receivedAt = this.options.now();
    if (hasSnapshot(result) && result.snapshot.summary.viewOnce) {
      this.handleTerminalViewOnce(read, result.snapshot, receivedAt);
      return;
    }

    const canOrder = this.canOrder(read);
    if (this.inFlight !== read) return;
    if (!this.isActive()) {
      this.expire();
      this.inFlight = null;
      return;
    }
    this.inFlight = null;
    if (!canOrder) {
      this.scheduleAfterSettle(receivedAt);
      return;
    }

    if (hasEtag(result)) {
      this.proveCredential(read, receivedAt);
      this.options.emit({ type: "unchanged", etag: result.etag, checkedAt: receivedAt });
      this.setState("unchanged", receivedAt);
      this.scheduleAfterSettle(receivedAt);
      return;
    }

    if (hasSnapshot(result)) {
      this.proveCredential(read, receivedAt);
      const order = classifyRemote(result.snapshot, read.capture.baseline);
      if (
        order === "marker-equal"
        && result.snapshot.source === read.capture.baseline.acceptedSource
        && samePublicSummary(result.snapshot.summary, read.capture.acceptedSummary)
      ) {
        this.options.emit({ type: "unchanged", etag: result.snapshot.etag, checkedAt: receivedAt });
        this.setState("unchanged", receivedAt);
        this.scheduleAfterSettle(receivedAt);
        return;
      }
      if (order === "definitely-newer") {
        this.candidate = null;
        this.locallyCleanOverride = false;
        const attempt = {} as RemoteApplyAttempt;
        this.remoteApplyAttempt = attempt;
        this.options.emit({ type: "proven-newer", snapshot: result.snapshot, capture: read.capture, attempt, checkedAt: receivedAt });
        this.armTimer();
        return;
      }

      this.candidate = { snapshot: result.snapshot, capture: read.capture };
      this.locallyCleanOverride = false;
      this.syncDueAt = null;
      this.options.emit({ type: "candidate", snapshot: result.snapshot, capture: read.capture, checkedAt: receivedAt });
      this.setState("conflict", receivedAt);
      this.armTimer();
      return;
    }

    if (result.status === 403) {
      this.candidate = null;
      this.locallyCleanOverride = false;
      this.retryRequired = true;
      this.syncDueAt = null;
      this.clearRetryIntent();
      this.options.emit({ type: "forbidden", at: receivedAt });
      this.setState("forbidden", receivedAt);
      this.armTimer();
      return;
    }
    if (result.status === 404) {
      this.candidate = null;
      this.locallyCleanOverride = false;
      this.retryRequired = false;
      this.syncDueAt = null;
      this.clearRetryIntent();
      this.permanentlyStopped = true;
      this.options.emit({ type: "not-found", at: receivedAt });
      this.setState("not-found", receivedAt);
      this.clearTimer();
      return;
    }
    if (result.status === 409) {
      this.candidate = null;
      this.syncDueAt = null;
      this.options.emit({ type: "conflict", at: receivedAt });
      this.setState("conflict", receivedAt);
      this.armTimer();
      return;
    }

    this.options.emit({ type: "error", at: receivedAt, ...("transport" in result && result.transport === "network" ? { transport: "network" as const } : {}) });
    this.setState("error", receivedAt);
    this.scheduleAfterSettle(receivedAt);
  }

  private handleReadFailure(read: InFlightRead, _reason: unknown): void {
    const settledAt = this.options.now();
    const canOrder = this.canOrder(read);
    if (this.inFlight !== read) return;
    if (!this.isActive()) {
      this.expire();
      this.inFlight = null;
      return;
    }

    this.inFlight = null;
    if (!canOrder) {
      this.scheduleAfterSettle(settledAt);
      return;
    }
    this.options.emit({ type: "error", at: settledAt, transport: "network" });
    this.setState("error", settledAt);
    this.scheduleAfterSettle(settledAt);
  }

  private scheduleAfterSettle(settledAt: number): void {
    if (this.isEligible()) this.syncDueAt = settledAt + CADENCE_MS;
    this.armTimer();
  }

  private proveCredential(read: InFlightRead, at: number): void {
    if (read.password !== null) this.options.emit({ type: "credential-proved", password: read.password, at });
  }

  private handleTerminalViewOnce(read: InFlightRead, snapshot: RemoteSnapshot, receivedAt: number): void {
    if (this.disposed || this.terminal) return;

    const ordinaryTokenCurrent = this.canOrder(read);
    this.terminal = true;
    this.candidate = null;
    this.locallyCleanOverride = false;
    this.remoteApplyAttempt = null;
    this.clearRetryIntent();
    this.syncDueAt = null;
    this.inFlight?.controller.abort();
    this.inFlight = null;
    this.requestToken += 1;
    this.clearTimer();
    this.options.emit({
      type: "terminal-view-once",
      snapshot,
      capture: read.capture,
      ordinaryTokenCurrent,
      receivedAt,
    });
    this.setState("inactive", receivedAt);
  }

  private canOrder(read: InFlightRead): boolean {
    if (!this.isCurrent(read) || !this.isEligible() || this.activeUntil !== read.capture.activeUntil) return false;

    const current = this.options.capture();
    return current.activeUntil === read.capture.activeUntil
      && current.localGeneration === read.capture.localGeneration
      && current.acceptedApplyGeneration === read.capture.acceptedApplyGeneration
      && current.baseline.acceptedApplyGeneration === read.capture.baseline.acceptedApplyGeneration
      && current.baseline.localGeneration === read.capture.baseline.localGeneration
      && current.baseline.generation === read.capture.baseline.generation
      && current.baseline.version === read.capture.baseline.version
      && current.baseline.contentRevision === read.capture.baseline.contentRevision
      && current.baseline.updatedAt === read.capture.baseline.updatedAt
      && current.baseline.acceptedSource === read.capture.baseline.acceptedSource;
  }

  private invalidateRead(): void {
    this.requestToken += 1;
    if (!this.inFlight) return;
    this.inFlight.controller.abort();
  }

  private isCurrent(read: InFlightRead): boolean {
    return !this.disposed && this.inFlight === read && this.requestToken === read.token;
  }

  private expire(): void {
    this.syncDueAt = null;
    this.candidate = null;
    this.locallyCleanOverride = false;
    this.remoteApplyAttempt = null;
    this.clearRetryIntent();
    this.invalidateRead();
    this.clearTimer();
    this.setState("inactive", this.options.now());
  }

  private setPausedState(at: number): void {
    if (!this.isActive()) {
      this.expire();
    } else if (!this.online || this.options.capture().offline) {
      this.setState("paused-offline", at);
    } else {
      this.setState("paused-local", at);
    }
  }

  private setState(state: AutosyncStatus, at: number | null): void {
    if (this.state === state) return;
    this.state = state;
    this.options.emit({ type: "state", state, at });
  }
}
