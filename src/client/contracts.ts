import type { PasteSummary } from "../types";
import type { AutosaveState } from "./autosave";

export type {
  AppBootstrap,
  ErrorCode,
  ExpirationInput,
  HistoryList,
  MutationResult,
  PasteSummary,
  RevisionResource,
} from "../types";

export type ActionKey =
  | "create"
  | "autosave"
  | "manual-save"
  | "save-retry"
  | "overwrite"
  | "content-reconcile"
  | "reload-server"
  | "use-remote"
  | "use-consumed-response"
  | "retry-sync"
  | "copy"
  | "download"
  | "history-list"
  | "history-snapshot"
  | "settings-title"
  | "settings-format"
  | "settings-expiration"
  | "settings-view-once"
  | "settings-reconcile"
  | "password-set"
  | "password-clear"
  | "password-reconcile"
  | "delete";

export type TerminalOutcomeKey =
  | "content-reconcile-terminal-current-kept"
  | "reload-terminal-response-displayed"
  | "reload-terminal-response-display-failed"
  | "reload-terminal-current-unchanged"
  | "reload-terminal-current-kept-choice"
  | "use-consumed-response-displayed"
  | "use-consumed-response-display-failed";

export type LastAction =
  | { state: "idle" }
  | { state: "pending"; key: ActionKey; attempt: number; startedAt: string }
  | {
      state: "succeeded" | "failed";
      key: ActionKey;
      attempt: number;
      startedAt: string;
      settledAt: string;
      outcomeKey: TerminalOutcomeKey | null;
    };

export type AutosaveStatus = AutosaveState;
export type AutosyncStatus =
  | "waiting" | "checking" | "unchanged" | "remote-applied"
  | "paused-local" | "paused-offline" | "error" | "forbidden"
  | "not-found" | "conflict" | "inactive";
export type NetworkStatus = "online" | "offline" | "degraded";

export interface OperationRecords {
  autosave: {
    state: AutosaveStatus;
    confirmedAt: string | null;
    failedAt: string | null;
  };
  autosync: {
    state: AutosyncStatus;
    stateChangedAt: string | null;
    checkedAt: string | null;
    appliedAt: string | null;
  };
  network: { state: NetworkStatus; changedAt: string };
  lastAction: LastAction;
}

export type VersionIdentity =
  | { kind: "legacy" }
  | { kind: "v2"; generation: string; versionCounter: number };

export interface RemoteSnapshot {
  etag: `"sha256-${string}"`;
  source: string;
  summary: PasteSummary;
  identity: VersionIdentity;
  contentRevision: number;
  updatedAtMs: number;
}

export type RemoteOrder =
  | "definitely-older"
  | "definitely-newer"
  | "marker-equal"
  | "incomparable";

export interface CredentialState {
  committed: string | null;
  pending: string | null;
}

export interface AcceptedPasteState {
  acceptedSource: string;
  draft: string;
  summary: PasteSummary;
  version: string;
  versionUsable: boolean;
  contentRevision: number;
  updatedAt: string;
  responseEtag: `"sha256-${string}"` | null;
  acceptedApplyGeneration: number;
  localGeneration: number;
  displayGeneration: number;
}

export type PastePhase =
  | "ordinary"
  | "armed-view-once"
  | "consumed"
  | "not-found"
  | "delete-uncertain";

export type SourceEvent =
  | { type: "input"; content: string; eventAt: number }
  | { type: "composition-start"; content: string; eventAt: number }
  | { type: "composition-input"; content: string; eventAt: number }
  | { type: "composition-end"; content: string; eventAt: number }
  | { type: "crepe-change"; content: string; eventAt: number };

export interface BaselineCapture {
  acceptedApplyGeneration: number;
  localGeneration: number;
  generation: string | "legacy";
  version: string;
  contentRevision: number;
  updatedAt: string;
  acceptedSource: string;
}

export interface TerminalOriginSettleContext {
  actionKey: "content-reconcile" | "reload-server";
  actionAttempt: number;
  startedAt: string;
}
