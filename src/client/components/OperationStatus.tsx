import * as React from "react";
import { dictionaries, formatDate, labels, type Locale } from "../../i18n";
import type { LastAction, OperationRecords, TerminalOutcomeKey } from "../contracts";

export interface OperationStatusProps {
  locale: Locale;
  records: OperationRecords;
  ordinary: boolean;
}

type StatusRecordId = "autosave" | "autosync" | "network" | "last-action";

interface StatusRecord {
  id: StatusRecordId;
  label: string;
  state: string;
  instant: string | null;
  signature: string;
}

const terminalStates: Readonly<Record<TerminalOutcomeKey, "succeeded" | "failed">> = {
  "content-reconcile-terminal-current-kept": "succeeded",
  "reload-terminal-response-displayed": "succeeded",
  "reload-terminal-response-display-failed": "failed",
  "reload-terminal-current-unchanged": "succeeded",
  "reload-terminal-current-kept-choice": "succeeded",
  "use-consumed-response-displayed": "succeeded",
  "use-consumed-response-display-failed": "failed",
};

function autosaveInstant(records: OperationRecords): string | null {
  switch (records.autosave.state) {
    case "saved": return records.autosave.confirmedAt;
    case "error":
    case "password-required":
    case "not-found":
    case "conflict": return records.autosave.failedAt;
    case "waiting":
    case "saving": return records.autosave.confirmedAt;
    case "clean": return null;
  }
}

function autosyncInstant(records: OperationRecords): string | null {
  switch (records.autosync.state) {
    case "unchanged": return records.autosync.checkedAt;
    case "remote-applied": return records.autosync.appliedAt;
    default: return records.autosync.stateChangedAt;
  }
}

function lastActionState(locale: Locale, action: LastAction): string {
  const dictionary = dictionaries[locale];
  if (action.state === "idle") return dictionary.status.lastAction.idle;
  if (action.state === "pending") return dictionary.actions[action.key].pending;
  if (action.outcomeKey !== null) {
    if (terminalStates[action.outcomeKey] !== action.state) {
      throw new Error("terminal outcome state does not match last action state");
    }
    return dictionary.terminal[action.outcomeKey];
  }
  return dictionary.actions[action.key][action.state];
}

function lastActionInstant(action: LastAction): string | null {
  if (action.state === "idle") return null;
  return action.state === "pending" ? action.startedAt : action.settledAt;
}

function signature(id: StatusRecordId, record: unknown): string {
  return JSON.stringify([id, record]);
}

function statusRecords(locale: Locale, records: OperationRecords, ordinary: boolean): StatusRecord[] {
  const copy = labels(locale);
  const dictionary = dictionaries[locale];
  const current: StatusRecord[] = [
    { id: "network", label: copy.network, state: dictionary.status.network[records.network.state], instant: records.network.changedAt, signature: signature("network", records.network) },
    { id: "last-action", label: copy.lastAction, state: lastActionState(locale, records.lastAction), instant: lastActionInstant(records.lastAction), signature: signature("last-action", records.lastAction) },
  ];
  if (!ordinary) return current;
  return [
    { id: "autosave", label: copy.autosave, state: dictionary.status.autosave[records.autosave.state], instant: autosaveInstant(records), signature: signature("autosave", records.autosave) },
    { id: "autosync", label: copy.autosync, state: dictionary.status.autosync[records.autosync.state], instant: autosyncInstant(records), signature: signature("autosync", records.autosync) },
    ...current,
  ];
}

function announcement(locale: Locale, record: StatusRecord): string {
  return record.instant === null
    ? `${record.label}: ${record.state}`
    : `${record.label}: ${record.state}, ${formatDate(locale, record.instant)}`;
}

export function OperationStatus({ locale, records, ordinary }: OperationStatusProps) {
  const current = statusRecords(locale, records, ordinary);
  const previous = React.useRef<{ locale: Locale; ordinary: boolean; signatures: ReadonlyMap<StatusRecordId, string> } | null>(null);
  const [message, setMessage] = React.useState("");

  React.useEffect(() => {
    const signatures = new Map(current.map((record) => [record.id, record.signature] as const));
    const baseline = previous.current;
    previous.current = { locale, ordinary, signatures };
    if (baseline === null || baseline.ordinary !== ordinary) {
      setMessage("");
      return;
    }
    const changed = current.filter((record) => baseline.signatures.get(record.id) !== record.signature);
    if (changed.length > 0) setMessage(changed.map((record) => announcement(locale, record)).join(" "));
    else if (baseline.locale !== locale) setMessage("");
  }, [current, locale, ordinary]);

  return (
    <section aria-label={labels(locale).operationStatus} className="border-t border-border py-3">
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only" data-operation-announcement="true">
        {message}
      </div>
      <dl className="grid gap-3 text-[13px] leading-[1.45] sm:grid-cols-2 lg:grid-cols-4">
        {current.map((record) => (
          <div key={record.id} data-operation-record={record.id} className="min-w-0">
            <dt className="text-muted-foreground">{record.label}</dt>
            <dd className="break-words font-medium">
              <span>{record.state}</span>
              {record.instant !== null && (
                <time className="ml-2 text-muted-foreground" dateTime={record.instant}>
                  {formatDate(locale, record.instant)}
                </time>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
