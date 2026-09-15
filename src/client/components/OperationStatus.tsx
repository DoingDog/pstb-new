import * as React from "react";
import { dictionaries, formatDate, labels, type Locale } from "../../i18n";
import type { LastAction, OperationRecords, TerminalOutcomeKey } from "../contracts";

export interface OperationStatusProps {
  locale: Locale;
  records: OperationRecords;
  ordinary: boolean;
}

interface StatusRecord {
  id: "autosave" | "autosync" | "network" | "last-action";
  label: string;
  state: string;
  instant: string | null;
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
    case "saved":
      return records.autosave.confirmedAt;
    case "error":
    case "password-required":
    case "not-found":
    case "conflict":
      return records.autosave.failedAt;
    case "waiting":
    case "saving":
      return records.autosave.confirmedAt;
    case "clean":
      return null;
  }
}

function autosyncInstant(records: OperationRecords): string | null {
  switch (records.autosync.state) {
    case "unchanged":
      return records.autosync.checkedAt;
    case "remote-applied":
      return records.autosync.appliedAt;
    default:
      return records.autosync.stateChangedAt;
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

function statusRecords(locale: Locale, records: OperationRecords, ordinary: boolean): StatusRecord[] {
  const copy = labels(locale);
  const dictionary = dictionaries[locale];
  const current: StatusRecord[] = [
    {
      id: "network",
      label: copy.network,
      state: dictionary.status.network[records.network.state],
      instant: records.network.changedAt,
    },
    {
      id: "last-action",
      label: copy.lastAction,
      state: lastActionState(locale, records.lastAction),
      instant: lastActionInstant(records.lastAction),
    },
  ];
  if (!ordinary) return current;
  return [
    {
      id: "autosave",
      label: copy.autosave,
      state: dictionary.status.autosave[records.autosave.state],
      instant: autosaveInstant(records),
    },
    {
      id: "autosync",
      label: copy.autosync,
      state: dictionary.status.autosync[records.autosync.state],
      instant: autosyncInstant(records),
    },
    ...current,
  ];
}

function recordSignature(record: StatusRecord): string {
  return JSON.stringify([record.id, record.state, record.instant]);
}

function announcement(locale: Locale, record: StatusRecord): string {
  return record.instant === null
    ? `${record.label}: ${record.state}`
    : `${record.label}: ${record.state}, ${formatDate(locale, record.instant)}`;
}

export function OperationStatus({ locale, records, ordinary }: OperationStatusProps) {
  const current = statusRecords(locale, records, ordinary);
  const signatures = current.map(recordSignature);
  const previous = React.useRef<string[] | null>(null);
  const [message, setMessage] = React.useState("");

  React.useEffect(() => {
    if (previous.current === null) {
      previous.current = signatures;
      return;
    }
    const changedIndex = signatures.findIndex((value, index) => value !== previous.current?.[index]);
    previous.current = signatures;
    if (changedIndex !== -1) setMessage(announcement(locale, current[changedIndex]!));
  }, [current, locale, signatures]);

  return (
    <section aria-label={labels(locale).operationStatus} className="border-t border-border py-3">
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only" data-operation-announcement="true">
        {message}
      </div>
      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
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
