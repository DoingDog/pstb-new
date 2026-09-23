import * as React from "react";
import type { ExpirationInput } from "../contracts";
import { dictionaries, labels, type Locale } from "../../i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "./Checkbox";
import { NativeSelect } from "./NativeSelect";
import { CircleCheck, CircleX, LoaderCircle } from "lucide-react";

export type SettingsField = "title" | "format" | "expiration" | "viewOnce";
export type SettingsActionKey = "settings-title" | "settings-format" | "settings-expiration" | "settings-view-once" | "settings-reconcile" | "reload-server";
export type SettingsActionOutcome = {
  state: "pending" | "succeeded" | "failed";
  origin: "field" | "recovery";
  attempt: number;
};
export type ManagementResultState = "idle" | "pending" | "succeeded" | "validation-error" | "credential-required" | "conflict" | "retryable" | "reconciliation-required";
export type ReconciliationIntent = "permanent" | "relative" | "absolute";
export type SettingsResult =
  | { field: "expiration"; state: "reconciliation-required"; message: string | null; reconciliationIntent: ReconciliationIntent; action?: SettingsActionKey; attempt?: number }
  | { field: Exclude<SettingsField, "expiration"> | null; state: "reconciliation-required"; message: string | null; reconciliationIntent?: never; action?: SettingsActionKey; attempt?: number }
  | { field: SettingsField | null; state: Exclude<ManagementResultState, "reconciliation-required">; message: string | null; reconciliationIntent?: never; action?: SettingsActionKey; attempt?: number };

export interface SettingsPanelState {
  accepted: {
    id: string;
    title: string;
    format: "text" | "markdown";
    expiration: ExpirationInput;
    viewOnce: boolean;
  };
  versionUsable: boolean;
  mutationPending?: boolean;
  mutationOccupied?: boolean;
  reconciliationOwner?: "content" | SettingsField | "password" | null;
  reconciliationRequestPending?: boolean;
  reconciliationCredentialRequired?: boolean;
  resultIdentity?: object;
  result: SettingsResult;
}

export interface SettingsPanelProps {
  state: SettingsPanelState;
  onActivity(eventAt: number, kind?: "recovery-credential"): void;
  onDraftState?(dirty: boolean, eventAt?: number): void;
  saveTitle(value: string): void;
  saveFormat(value: "text" | "markdown"): void;
  saveExpiration(value: ExpirationInput): void;
  saveViewOnce(value: boolean): void;
  retry(credential: string | null): void;
  reconcile(): void;
  reload(): void;
  locale?: Locale;
}

const fieldActions: Record<SettingsField, SettingsActionKey> = {
  title: "settings-title",
  format: "settings-format",
  expiration: "settings-expiration",
  viewOnce: "settings-view-once",
};

const settingsActionKeys: readonly SettingsActionKey[] = [
  "settings-title",
  "settings-format",
  "settings-expiration",
  "settings-view-once",
  "settings-reconcile",
  "reload-server",
];

function inputExpiration(value: ExpirationInput): string {
  return value === null ? "permanent" : String(value);
}

function parseExpiration(value: string): ExpirationInput {
  if (value === "permanent") return null;
  return /^\d+$/.test(value) ? Number(value) : value;
}

function useDraft<Value>(accepted: Value) {
  const [value, setValue] = React.useState(accepted);
  const valueRef = React.useRef(value);
  const acceptedRef = React.useRef(accepted);
  const generation = React.useRef(0);
  const acceptedGeneration = React.useRef(0);
  const submitted = React.useRef<{ value: Value; generation: number } | null>(null);

  const apply = React.useCallback((next: Value) => {
    valueRef.current = next;
    setValue(next);
  }, []);
  const settle = React.useCallback((nextAccepted: Value) => {
    const submittedValue = submitted.current;
    if (submittedValue === null || !Object.is(submittedValue.value, nextAccepted)) return false;
    submitted.current = null;
    if (generation.current === submittedValue.generation) {
      acceptedGeneration.current = generation.current;
      apply(nextAccepted);
    }
    return true;
  }, [apply]);

  React.useEffect(() => {
    if (Object.is(acceptedRef.current, accepted)) return;
    acceptedRef.current = accepted;
    if (settle(accepted)) return;
    if (generation.current === acceptedGeneration.current) apply(accepted);
  }, [accepted, apply, settle]);

  return {
    value,
    edit(next: Value) {
      generation.current += 1;
      apply(next);
    },
    dirty() {
      return !Object.is(valueRef.current, acceptedRef.current);
    },
    submit() {
      submitted.current = { value: valueRef.current, generation: generation.current };
      return valueRef.current;
    },
    settle,
  };
}

function resultMessage(result: SettingsPanelState["result"], locale: Locale): string {
  if (result.message !== null) return result.message;
  const action = result.field === null ? undefined : dictionaries[locale].actions[fieldActions[result.field]];
  if (result.state === "pending") return action?.pending ?? dictionaries[locale].status.lastAction.pending;
  if (result.state === "succeeded") return action?.succeeded ?? dictionaries[locale].status.lastAction.succeeded;
  return action?.failed ?? dictionaries[locale].status.lastAction.failed;
}

function resultAction(result: SettingsResult): SettingsActionKey | null {
  if (result.state === "reconciliation-required" && result.action === undefined) return null;
  return result.action ?? (result.field === null ? null : fieldActions[result.field]);
}

function outcomeState(result: SettingsResult): SettingsActionOutcome["state"] {
  return result.state === "pending" ? "pending" : result.state === "succeeded" ? "succeeded" : "failed";
}

function outcomeLabel(action: SettingsActionKey, outcome: SettingsActionOutcome | undefined, locale: Locale, fallback: string) {
  if (outcome === undefined) return fallback;
  const Icon = outcome.state === "pending" ? LoaderCircle : outcome.state === "succeeded" ? CircleCheck : CircleX;
  return <><Icon aria-hidden="true" className={outcome.state === "pending" ? "animate-spin" : undefined} /><span>{dictionaries[locale].actions[action][outcome.state]}</span></>;
}

function ResultActions({ result, outcomes, versionUsable, mutationBlocked, ownsReconciliation, recoveryBlocked, reconciliationCredentialRequired, retry, reconcile, reload, onActivity, onRecoveryDispatch, locale }: Pick<SettingsPanelProps, "retry" | "reconcile" | "reload" | "onActivity"> & { result: SettingsPanelState["result"]; outcomes: Partial<Record<SettingsActionKey, SettingsActionOutcome>>; versionUsable: boolean; mutationBlocked: boolean; ownsReconciliation: boolean; recoveryBlocked: boolean; reconciliationCredentialRequired: boolean; onRecoveryDispatch(key: SettingsActionKey): void; locale: Locale }) {
  const [credential, setCredential] = React.useState("");
  const copy = labels(locale);
  const recovery = result.field !== null && (result.state === "credential-required" || result.state === "retryable" || result.state === "conflict")
    ? { key: fieldActions[result.field], fallback: copy.retry, disabled: mutationBlocked, dispatch: () => { onRecoveryDispatch(fieldActions[result.field!]); retry(credential === "" ? null : credential); } }
    : result.state === "reconciliation-required" && ownsReconciliation
      ? { key: "settings-reconcile" as const, fallback: result.field === "expiration" && result.reconciliationIntent === "relative" ? copy.saveExpiration : copy.reconcile, disabled: recoveryBlocked, dispatch: () => { onRecoveryDispatch("settings-reconcile"); if (reconciliationCredentialRequired) retry(credential === "" ? null : credential); else reconcile(); } }
      : null;
  const recoveryOutcomes = settingsActionKeys.filter((key) => key !== "reload-server" && outcomes[key]?.origin === "recovery");
  if (recovery !== null && !recoveryOutcomes.includes(recovery.key)) recoveryOutcomes.push(recovery.key);
  const reloadOutcome = outcomes["reload-server"]?.origin === "recovery" ? outcomes["reload-server"] : undefined;
  const showMessage = result.state !== "idle" && result.state !== "pending" && result.state !== "succeeded";
  const showReload = !versionUsable || result.state === "conflict";
  if (!showMessage && recoveryOutcomes.length === 0 && !showReload && reloadOutcome === undefined) return null;

  return (
    <div data-settings-result={result.state === "idle" ? undefined : result.state} className="flex flex-wrap items-center gap-2">
      <p hidden={!showMessage} role={showMessage ? "alert" : undefined} className="basis-full">{showMessage ? resultMessage(result, locale) : null}</p>
      {(result.state === "credential-required" || (result.state === "reconciliation-required" && reconciliationCredentialRequired)) && <label>{copy.currentPassword}<Input name="retryCredential" type="password" aria-label={copy.currentPassword} value={credential} onInput={(event) => { setCredential(event.currentTarget.value); onActivity(event.timeStamp, "recovery-credential"); }} /></label>}
      {recoveryOutcomes.map((key) => {
        const outcome = outcomes[key]?.origin === "recovery" ? outcomes[key] : undefined;
        const current = recovery?.key === key ? recovery : null;
        return <Button key={key} data-settings-recovery-action={key} type="button" disabled={current === null || current.disabled || outcome?.state === "pending"} onClick={() => { if (current === null || current.disabled || outcome?.state === "pending") return; current.dispatch(); }}>{outcomeLabel(key, outcome, locale, current?.fallback ?? copy.reconcile)}</Button>;
      })}
      {(showReload || reloadOutcome !== undefined) && <Button data-settings-recovery-action="reload-server" data-settings-action-result={reloadOutcome?.state} type="button" variant="outline" aria-busy={reloadOutcome?.state === "pending" || undefined} disabled={!showReload || reloadOutcome?.state === "pending"} onClick={() => { if (!showReload || reloadOutcome?.state === "pending") return; onRecoveryDispatch("reload-server"); reload(); }}>{outcomeLabel("reload-server", reloadOutcome, locale, copy.reload)}</Button>}
    </div>
  );
}

export function SettingsPanel({ state, onActivity, onDraftState, saveTitle, saveFormat, saveExpiration, saveViewOnce, retry, reconcile, reload, locale = "en" }: SettingsPanelProps) {
  const title = useDraft(state.accepted.title);
  const format = useDraft(state.accepted.format);
  const expiration = useDraft(inputExpiration(state.accepted.expiration));
  const viewOnce = useDraft(state.accepted.viewOnce);
  const [outcomes, setOutcomes] = React.useState<Partial<Record<SettingsActionKey, SettingsActionOutcome>>>(() => {
    const action = resultAction(state.result);
    return action === null || state.result.state === "idle"
      ? {}
      : { [action]: { state: outcomeState(state.result), origin: action === "settings-reconcile" || action === "reload-server" ? "recovery" : "field", attempt: state.result.attempt ?? 0 } };
  });
  const pageIdentity = React.useRef(state.accepted.id);
  const settledResult = React.useRef<object | null>(null);
  const recoveryAction = React.useRef<SettingsActionKey | null>(null);
  const result = state.result;
  const copy = labels(locale);
  const mutationBlocked = state.mutationOccupied === true || state.mutationPending === true || result.state === "pending" || !state.versionUsable;
  const ownsReconciliation = state.reconciliationOwner === "title" || state.reconciliationOwner === "format" || state.reconciliationOwner === "expiration" || state.reconciliationOwner === "viewOnce";
  const resultOwnsReconciliation = ownsReconciliation && (result.field === null || state.reconciliationOwner === result.field);
  const recoveryBlocked = ownsReconciliation && state.reconciliationRequestPending === true;
  const standardExpirations = ["permanent", "60", "3600", "86400", "604800", "2592000", "31104000"];
  const reportDraftState = (eventAt?: number) => onDraftState?.(title.dirty() || format.dirty() || expiration.dirty() || viewOnce.dirty(), eventAt);
  const resultIdentity = state.resultIdentity ?? state.result;
  const invalid = (field: SettingsField) => result.field === field && result.state === "validation-error";
  const retainedOutcomes = pageIdentity.current === state.accepted.id ? outcomes : {};
  const action = resultAction(result);
  const currentOutcome = action === null || result.state === "idle"
    ? undefined
    : { state: outcomeState(result), origin: action === "settings-reconcile" || action === "reload-server" || recoveryAction.current === action ? "recovery" : "field", attempt: result.attempt ?? retainedOutcomes[action]?.attempt ?? 0 } as SettingsActionOutcome;
  const displayedOutcomes = currentOutcome === undefined || action === null ? retainedOutcomes : { ...retainedOutcomes, [action]: currentOutcome };
  const outcome = (field: SettingsField) => displayedOutcomes[fieldActions[field]]?.origin === "field" ? displayedOutcomes[fieldActions[field]] : undefined;

  React.useEffect(() => {
    if (pageIdentity.current === state.accepted.id) return;
    pageIdentity.current = state.accepted.id;
    settledResult.current = null;
    recoveryAction.current = null;
    setOutcomes({});
  }, [state.accepted.id]);

  React.useEffect(() => {
    if (action === null || currentOutcome === undefined) return;
    setOutcomes((current) => {
      const previous = current[action];
      return previous?.state === currentOutcome.state && previous.origin === currentOutcome.origin && previous.attempt === currentOutcome.attempt
        ? current
        : { ...current, [action]: currentOutcome };
    });
  }, [action, currentOutcome]);

  React.useEffect(() => {
    if (result.state !== "succeeded" || result.field === null || settledResult.current === resultIdentity) return;
    settledResult.current = resultIdentity;
    if (result.field === "title") title.settle(state.accepted.title);
    if (result.field === "format") format.settle(state.accepted.format);
    if (result.field === "expiration") expiration.settle(inputExpiration(state.accepted.expiration));
    if (result.field === "viewOnce") viewOnce.settle(state.accepted.viewOnce);
    reportDraftState();
  }, [result, resultIdentity, state.accepted.expiration, state.accepted.format, state.accepted.title, state.accepted.viewOnce, title, format, expiration, viewOnce, reportDraftState]);

  const titleOutcome = outcome("title");
  const formatOutcome = outcome("format");
  const expirationOutcome = outcome("expiration");
  const viewOnceOutcome = outcome("viewOnce");
  const rowClass = "grid min-w-0 grid-cols-[minmax(5.5rem,1fr)_minmax(0,2fr)_minmax(0,1.25fr)] items-center gap-2 [&>label]:flex [&>label]:min-h-11 [&>label]:min-w-0 [&>label]:items-center [&>label]:break-words";
  const buttonClass = "h-auto min-h-11 w-full min-w-0 whitespace-normal break-words px-2 py-1 leading-tight";

  return (
    <section aria-label={copy.settings} className="grid min-w-0 gap-2 [&_input:not([type=checkbox])]:min-h-11">
      <div data-settings-row="id" className={rowClass}>
        <label htmlFor="settings-id">{copy.customId}</label>
        <Input id="settings-id" name="id" value={state.accepted.id} readOnly />
      </div>
      <div data-settings-row="title" className={rowClass}>
        <label htmlFor="settings-title">{copy.title}</label>
        <Input id="settings-title" name="title" value={title.value} aria-invalid={invalid("title")} onInput={(event) => { title.edit(event.currentTarget.value); reportDraftState(event.timeStamp); }} />
        <Button type="button" className={buttonClass} data-settings-field="title" data-settings-action-result={titleOutcome?.state} aria-busy={titleOutcome?.state === "pending" || undefined} disabled={mutationBlocked} onClick={() => { if (mutationBlocked) return; recoveryAction.current = null; saveTitle(title.submit()); }}>{outcomeLabel("settings-title", titleOutcome, locale, copy.saveTitle)}</Button>
      </div>
      <div data-settings-row="format" className={rowClass}>
        <label htmlFor="settings-format">{copy.format}</label>
        <NativeSelect id="settings-format" name="format" value={format.value} aria-invalid={invalid("format")} onChange={(event) => { format.edit(event.currentTarget.value as "text" | "markdown"); reportDraftState(event.timeStamp); }}><option value="text">{copy.text}</option><option value="markdown">{copy.markdown}</option></NativeSelect>
        <Button type="button" className={buttonClass} data-settings-field="format" data-settings-action-result={formatOutcome?.state} aria-busy={formatOutcome?.state === "pending" || undefined} disabled={mutationBlocked} onClick={() => { if (mutationBlocked) return; recoveryAction.current = null; saveFormat(format.submit()); }}>{outcomeLabel("settings-format", formatOutcome, locale, copy.saveFormat)}</Button>
      </div>
      <div data-settings-row="expiration" className={rowClass}>
        <label htmlFor="settings-expiration">{copy.expiration}</label>
        <NativeSelect id="settings-expiration" name="expiration" value={expiration.value} aria-invalid={invalid("expiration")} onChange={(event) => { expiration.edit(event.currentTarget.value); reportDraftState(event.timeStamp); }}>
          {!standardExpirations.includes(expiration.value) && <option value={expiration.value}>{expiration.value}</option>}
          <option value="permanent">{copy.permanent}</option><option value="60">{copy.oneMinute}</option><option value="3600">{copy.oneHour}</option><option value="86400">{copy.oneDay}</option><option value="604800">{copy.oneWeek}</option><option value="2592000">{copy.thirtyDays}</option><option value="31104000">{copy.oneYear}</option>
        </NativeSelect>
        <Button type="button" className={buttonClass} data-settings-field="expiration" data-settings-action-result={expirationOutcome?.state} aria-busy={expirationOutcome?.state === "pending" || undefined} disabled={mutationBlocked} onClick={() => { if (mutationBlocked) return; recoveryAction.current = null; saveExpiration(parseExpiration(expiration.submit())); }}>{outcomeLabel("settings-expiration", expirationOutcome, locale, copy.saveExpiration)}</Button>
      </div>
      <div data-settings-row="viewOnce" className={rowClass}>
        <label htmlFor="settings-view-once">{copy.viewOnce}</label>
        <label htmlFor="settings-view-once" className="flex min-h-11 items-center"><Checkbox id="settings-view-once" name="viewOnce" checked={viewOnce.value} aria-invalid={invalid("viewOnce")} onChange={(event) => { viewOnce.edit(event.currentTarget.checked); reportDraftState(event.timeStamp); }} /></label>
        <Button type="button" className={buttonClass} data-settings-field="viewOnce" data-settings-action-result={viewOnceOutcome?.state} aria-busy={viewOnceOutcome?.state === "pending" || undefined} disabled={mutationBlocked} onClick={() => { if (mutationBlocked) return; recoveryAction.current = null; saveViewOnce(viewOnce.submit()); }}>{outcomeLabel("settings-view-once", viewOnceOutcome, locale, copy.saveViewOnce)}</Button>
      </div>
      <ResultActions result={result} outcomes={displayedOutcomes} versionUsable={state.versionUsable} mutationBlocked={mutationBlocked} ownsReconciliation={resultOwnsReconciliation} recoveryBlocked={recoveryBlocked} reconciliationCredentialRequired={state.reconciliationCredentialRequired === true} onActivity={onActivity} onRecoveryDispatch={(key) => { recoveryAction.current = key; }} retry={retry} reconcile={reconcile} reload={reload} locale={locale} />
    </section>
  );
}
