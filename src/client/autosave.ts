import type { PasteSummary } from "../types";
import { createMarkdownModes, type MarkdownModes, type MarkdownModesOptions } from "./markdown";

export type AutosaveState =
  | "clean" | "waiting" | "saving" | "saved" | "error"
  | "password-required" | "not-found" | "conflict";

export interface AutosaveSaveRequest {
  action: "autosave" | "save-retry" | "overwrite";
  content: string;
  version?: string;
  password?: string;
}

export type AutosaveSaveResult =
  | { status: 200; changed: boolean; paste: PasteSummary }
  | { status: number; mutationMayHaveApplied?: boolean };

export interface AutosaveSnapshot {
  state: AutosaveState;
  draft: string;
  acceptedSource: string;
  lastSavedContent: string;
  version: string;
  lastInputAt: number | null;
  dueAt: number | null;
  inFlightContent: string | null;
  dirtyWhileSaving: boolean;
  failureStatus: number | null;
  requiresExplicitRetry: boolean;
  coalescedIntent: boolean;
}

export type AutosaveDispatch =
  | { kind: "started"; completion: Promise<AutosaveSaveResult> }
  | { kind: "blocked" };

export type AutosaveAuthoritativeTransition =
  | { kind: "replace"; acceptedSource: string; version: string }
  | { kind: "metadata"; acceptedSource: string; version: string }
  | { kind: "reconciled-applied"; acceptedSource: string; version: string }
  | { kind: "reconciled-not-applied"; acceptedSource: string; version: string }
  | {
      kind: "pause";
      state: "password-required" | "not-found" | "conflict";
      failureStatus: number | null;
    };

export interface AutosaveOptions {
  content: string;
  version: string;
  now(): number;
  setTimer(callback: () => void, delay: number): unknown;
  clearTimer(timer: unknown): void;
  tryDispatch(request: AutosaveSaveRequest): AutosaveDispatch;
  onCoalescedIntent(): void;
  getPassword?(): string | null;
  onStateChange(snapshot: AutosaveSnapshot): void;
}

export interface AutosaveControllerApi {
  snapshot(): Readonly<AutosaveSnapshot>;
  input(content: string, eventAt: number): void;
  compositionStart(): void;
  compositionEnd(content: string, eventAt: number): void;
  retry(): void;
  overwrite(): void;
  acknowledgeAcceptedContent(acceptedSource: string, version: string): boolean;
  commitRemoteReplace?(acceptedSource: string, version: string): () => void;
  applyAuthoritative(transition: AutosaveAuthoritativeTransition): void;
  slotAvailable(): void;
  dispose(): void;
}

export class AutosaveController implements AutosaveControllerApi {
  private timer: unknown;
  private state: AutosaveState = "clean";
  private draft: string;
  private acceptedSource: string;
  private version: string;
  private lastInputAt: number | null = null;
  private dueAt: number | null = null;
  private inFlightContent: string | null = null;
  private activeAttempt: number | null = null;
  private pendingAttempt: number | null = null;
  private nextAttempt = 0;
  private dirtyWhileSaving = false;
  private failureStatus: number | null = null;
  private requiresExplicitRetry = false;
  private coalescedIntent = false;
  private composing = false;
  private disposed = false;
  private unloadRegistered = false;
  private pausedState: AutosaveState | undefined;

  constructor(private readonly options: AutosaveOptions) {
    this.draft = options.content;
    this.acceptedSource = options.content;
    this.version = options.version;
    this.emit();
  }

  snapshot(): Readonly<AutosaveSnapshot> {
    return {
      state: this.state,
      draft: this.draft,
      acceptedSource: this.acceptedSource,
      lastSavedContent: this.acceptedSource,
      version: this.version,
      lastInputAt: this.lastInputAt,
      dueAt: this.dueAt,
      inFlightContent: this.inFlightContent,
      dirtyWhileSaving: this.dirtyWhileSaving,
      failureStatus: this.failureStatus,
      requiresExplicitRetry: this.requiresExplicitRetry,
      coalescedIntent: this.coalescedIntent,
    };
  }

  input(content: string, eventAt: number): void {
    if (this.disposed) return;

    this.draft = content;
    if (this.composing) {
      this.emit();
      return;
    }

    this.lastInputAt = eventAt;
    this.dueAt = eventAt + 1_000;
    if (this.inFlightContent !== null) {
      this.dirtyWhileSaving = true;
      this.emit();
      return;
    }
    if (this.isTerminal() || this.requiresExplicitRetry || this.state === "error") {
      this.emit();
      return;
    }
    if (this.draft === this.acceptedSource) {
      this.cancelTimer();
      this.dueAt = null;
      this.dirtyWhileSaving = false;
      this.failureStatus = null;
      this.requiresExplicitRetry = false;
      this.coalescedIntent = false;
      this.state = "clean";
      this.emit();
      return;
    }

    this.failureStatus = null;
    this.state = "waiting";
    this.schedule();
    this.emit();
  }

  compositionStart(): void {
    if (this.disposed) return;
    this.composing = true;
    this.cancelTimer();
    this.emit();
  }

  compositionEnd(content: string, eventAt: number): void {
    if (this.disposed) return;
    this.composing = false;
    this.input(content, eventAt);
  }

  retry(): void {
    if (
      this.disposed ||
      this.composing ||
      (this.state !== "error" && this.state !== "password-required") ||
      !this.requiresExplicitRetry ||
      this.inFlightContent !== null ||
      this.pendingAttempt !== null ||
      this.draft === this.acceptedSource
    ) {
      return;
    }
    this.cancelTimer();
    this.dueAt = null;
    this.dispatch("save-retry", false, this.state);
  }

  overwrite(): void {
    if (this.disposed || this.composing || this.state !== "conflict" || this.inFlightContent !== null || this.pendingAttempt !== null) return;
    this.cancelTimer();
    this.dueAt = null;
    this.dispatch("overwrite", false, this.state);
  }

  acknowledgeAcceptedContent(acceptedSource: string, version: string): boolean {
    if (this.disposed || this.inFlightContent !== acceptedSource || this.activeAttempt === null) return false;
    this.acceptedSource = acceptedSource;
    this.version = version;
    return true;
  }

  commitRemoteReplace(acceptedSource: string, version: string): () => void {
    if (this.disposed) return () => {};

    const timer = this.timer;
    this.timer = undefined;
    this.acceptedSource = acceptedSource;
    this.draft = acceptedSource;
    this.version = version;
    this.lastInputAt = null;
    this.dueAt = null;
    this.retireActiveAttempt();
    this.dirtyWhileSaving = false;
    this.failureStatus = null;
    this.requiresExplicitRetry = false;
    this.coalescedIntent = false;
    this.pausedState = undefined;
    this.state = "clean";

    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (timer !== undefined) this.options.clearTimer(timer);
      this.emit();
    };
  }

  applyAuthoritative(transition: AutosaveAuthoritativeTransition): void {
    if (this.disposed) return;

    switch (transition.kind) {
      case "replace":
        this.commitRemoteReplace(transition.acceptedSource, transition.version)();
        return;
      case "metadata":
        if (transition.acceptedSource !== this.acceptedSource) return;
        this.version = transition.version;
        this.failureStatus = null;
        this.requiresExplicitRetry = false;
        this.restoreAfterMetadata();
        this.emit();
        return;
      case "reconciled-applied":
        this.cancelTimer();
        this.acceptedSource = transition.acceptedSource;
        this.version = transition.version;
        this.retireActiveAttempt();
        this.dirtyWhileSaving = false;
        this.failureStatus = null;
        this.requiresExplicitRetry = false;
        this.coalescedIntent = false;
        this.pausedState = undefined;
        this.dueAt = null;
        this.state = this.draft === this.acceptedSource ? "saved" : "waiting";
        this.emit();
        return;
      case "reconciled-not-applied":
        this.cancelTimer();
        this.acceptedSource = transition.acceptedSource;
        this.version = transition.version;
        this.retireActiveAttempt();
        this.dirtyWhileSaving = false;
        this.dueAt = null;
        this.requiresExplicitRetry = true;
        this.coalescedIntent = false;
        this.pausedState = undefined;
        this.state = "error";
        this.emit();
        return;
      case "pause":
        this.cancelTimer();
        if (!this.isTerminal()) this.pausedState = this.state;
        this.state = transition.state;
        this.failureStatus = transition.failureStatus;
        this.emit();
    }
  }

  slotAvailable(): void {
    if (
      this.disposed ||
      this.composing ||
      this.inFlightContent !== null ||
      this.pendingAttempt !== null ||
      this.timer !== undefined ||
      this.draft === this.acceptedSource ||
      this.isTerminal() ||
      this.state === "error" ||
      this.requiresExplicitRetry
    ) {
      return;
    }
    if (this.dueAt !== null) {
      this.schedule();
      this.emit();
      return;
    }
    if (this.state !== "waiting") return;
    this.dispatch("autosave", true, "waiting");
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelTimer();
    this.removeBeforeUnloadWarning();
  }

  private restoreAfterMetadata(): void {
    const previous = this.pausedState;
    this.pausedState = undefined;
    if (this.draft === this.acceptedSource) {
      this.cancelTimer();
      this.dueAt = null;
      this.coalescedIntent = false;
      this.state = previous === "saved" ? "saved" : "clean";
      return;
    }
    this.state = "waiting";
    if (this.dueAt !== null) this.schedule();
  }

  private schedule(): void {
    if (
      this.disposed ||
      this.composing ||
      this.isTerminal() ||
      this.state === "error" ||
      this.requiresExplicitRetry ||
      this.inFlightContent !== null
    ) {
      return;
    }

    this.cancelTimer();
    if (this.dueAt === null) return;

    let timer: unknown;
    timer = this.options.setTimer(() => {
      if (this.disposed || this.timer !== timer) return;
      this.timer = undefined;
      this.dueAt = null;
      this.dispatch("autosave", true, "waiting");
    }, Math.max(0, this.dueAt - this.options.now()));
    this.timer = timer;
  }

  private dispatch(action: AutosaveSaveRequest["action"], timerDriven: boolean, priorState: AutosaveState = this.state): void {
    if (this.disposed || this.composing || this.inFlightContent !== null || (this.isTerminal() && action !== "overwrite" && action !== "save-retry")) return;
    if (this.pendingAttempt !== null) {
      if (timerDriven) this.emit();
      return;
    }
    if (action !== "overwrite" && this.draft === this.acceptedSource) {
      this.dueAt = null;
      this.dirtyWhileSaving = false;
      this.state = "clean";
      this.emit();
      return;
    }

    const content = this.draft;
    const password = this.options.getPassword?.() ?? null;
    const request: AutosaveSaveRequest = {
      action,
      content,
      ...(action === "overwrite" ? {} : { version: this.version }),
      ...(password === null ? {} : { password }),
    };
    const dispatched = this.options.tryDispatch(request);
    if (dispatched.kind === "blocked") {
      this.state = timerDriven ? "waiting" : priorState;
      if (timerDriven && !this.coalescedIntent) {
        this.coalescedIntent = true;
        this.options.onCoalescedIntent();
      }
      this.emit();
      return;
    }

    const attempt = ++this.nextAttempt;
    this.activeAttempt = attempt;
    this.pendingAttempt = attempt;
    this.inFlightContent = content;
    this.dirtyWhileSaving = false;
    this.dueAt = null;
    this.failureStatus = null;
    this.requiresExplicitRetry = false;
    this.coalescedIntent = false;
    this.state = "saving";
    this.emit();
    void dispatched.completion.then(
      (result) => this.completeSave(attempt, content, result),
      () => this.failSave(attempt, null, true),
    );
  }

  private completeSave(attempt: number, content: string, result: AutosaveSaveResult): void {
    this.releasePendingAttempt(attempt);
    if (this.disposed || this.activeAttempt !== attempt) return;
    if (result.status !== 200 || !("paste" in result)) {
      this.failSave(attempt, result.status, "paste" in result ? false : result.mutationMayHaveApplied ?? false);
      return;
    }

    this.acceptedSource = content;
    this.version = result.paste.version;
    this.activeAttempt = null;
    this.inFlightContent = null;
    this.dirtyWhileSaving = false;
    this.failureStatus = null;
    this.requiresExplicitRetry = false;
    if (this.draft === this.acceptedSource) {
      this.cancelTimer();
      this.dueAt = null;
      this.coalescedIntent = false;
      this.state = "saved";
    } else {
      this.state = "waiting";
      this.schedule();
    }
    this.emit();
  }

  private failSave(attempt: number, status: number | null, mutationMayHaveApplied = false): void {
    this.releasePendingAttempt(attempt);
    if (this.disposed || this.activeAttempt !== attempt) return;

    this.activeAttempt = null;
    this.inFlightContent = null;
    this.dirtyWhileSaving = false;
    this.cancelTimer();
    this.dueAt = null;
    this.failureStatus = status;
    this.coalescedIntent = false;
    this.pausedState = undefined;
    if (status === 403) {
      this.requiresExplicitRetry = !mutationMayHaveApplied;
      this.state = "password-required";
    } else if (status === 404) {
      this.requiresExplicitRetry = false;
      this.state = "not-found";
    } else if (status === 409) {
      this.requiresExplicitRetry = false;
      this.state = "conflict";
    } else {
      this.requiresExplicitRetry = !mutationMayHaveApplied;
      this.state = "error";
    }
    this.emit();
  }

  private retireActiveAttempt(): void {
    this.activeAttempt = null;
    this.inFlightContent = null;
  }

  private releasePendingAttempt(attempt: number): void {
    if (this.pendingAttempt === attempt) this.pendingAttempt = null;
  }

  private isTerminal(): boolean {
    return this.state === "password-required" || this.state === "not-found" || this.state === "conflict";
  }

  private cancelTimer(): void {
    if (this.timer === undefined) return;
    this.options.clearTimer(this.timer);
    this.timer = undefined;
  }

  private emit(): void {
    this.updateBeforeUnloadWarning();
    this.options.onStateChange(this.snapshot());
  }

  private updateBeforeUnloadWarning(): void {
    if (typeof document === "undefined") return;

    const needed = this.draft !== this.acceptedSource || this.inFlightContent !== null;
    if (needed && !this.unloadRegistered) {
      globalThis.addEventListener("beforeunload", this.beforeUnload);
      this.unloadRegistered = true;
    } else if (!needed && this.unloadRegistered) {
      this.removeBeforeUnloadWarning();
    }
  }

  private removeBeforeUnloadWarning(): void {
    if (!this.unloadRegistered) return;
    globalThis.removeEventListener("beforeunload", this.beforeUnload);
    this.unloadRegistered = false;
  }

  private readonly beforeUnload = (event: Event): void => {
    event.preventDefault();
    (event as BeforeUnloadEvent).returnValue = "";
  };
}

export interface AutosaveMarkdownModesOptions extends Omit<MarkdownModesOptions, "onDocumentChange"> {
  autosave: Pick<AutosaveControllerApi, "input">;
  onCrepeChange(content: string, eventAt: number): void;
  now(): number;
}

export function createAutosaveMarkdownModes(options: AutosaveMarkdownModesOptions): MarkdownModes {
  const { autosave, onCrepeChange, now, ...markdownOptions } = options;
  return createMarkdownModes({
    ...markdownOptions,
    onDocumentChange: (markdown) => {
      const eventAt = now();
      onCrepeChange(markdown, eventAt);
      autosave.input(markdown, eventAt);
    },
  });
}
