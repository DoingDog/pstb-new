import * as React from "react";
import type { ActionKey, ExpirationInput } from "../contracts";
import { dictionaries, labels, type Locale } from "../../i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export type SettingsField = "title" | "format" | "expiration" | "viewOnce";
export type ManagementResultState = "idle" | "pending" | "succeeded" | "validation-error" | "credential-required" | "conflict" | "retryable" | "reconciliation-required";
export type ReconciliationIntent = "permanent" | "relative" | "absolute";
export type SettingsResult =
  | { field: "expiration"; state: "reconciliation-required"; message: string | null; reconciliationIntent: ReconciliationIntent }
  | { field: Exclude<SettingsField, "expiration"> | null; state: "reconciliation-required"; message: string | null; reconciliationIntent?: never }
  | { field: SettingsField | null; state: Exclude<ManagementResultState, "reconciliation-required">; message: string | null; reconciliationIntent?: never };

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
  discard(): void;
  locale?: Locale;
}

const fieldActions: Record<SettingsField, ActionKey> = {
  title: "settings-title",
  format: "settings-format",
  expiration: "settings-expiration",
  viewOnce: "settings-view-once",
};

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
    discard(nextAccepted: Value) {
      generation.current += 1;
      acceptedGeneration.current = generation.current;
      submitted.current = null;
      acceptedRef.current = nextAccepted;
      apply(nextAccepted);
    },
  };
}

function resultMessage(result: SettingsPanelState["result"], locale: Locale): string {
  if (result.message !== null) return result.message;
  const action = result.field === null ? undefined : dictionaries[locale].actions[fieldActions[result.field]];
  if (result.state === "pending") return action?.pending ?? dictionaries[locale].status.lastAction.pending;
  if (result.state === "succeeded") return action?.succeeded ?? dictionaries[locale].status.lastAction.succeeded;
  return action?.failed ?? dictionaries[locale].status.lastAction.failed;
}

function ResultActions({ result, versionUsable, mutationBlocked, recoveryBlocked, retry, reconcile, reload, onActivity, locale }: Pick<SettingsPanelProps, "retry" | "reconcile" | "reload" | "onActivity"> & { result: SettingsPanelState["result"]; versionUsable: boolean; mutationBlocked: boolean; recoveryBlocked: boolean; locale: Locale }) {
  const [credential, setCredential] = React.useState("");
  const copy = labels(locale);
  if (result.state === "idle") return !versionUsable ? <Button type="button" variant="outline" onClick={reload}>{copy.reload}</Button> : null;
  const recovery = result.state === "credential-required" || result.state === "retryable" || result.state === "conflict";
  const rewriteExpiration = result.state === "reconciliation-required" && result.field === "expiration" && result.reconciliationIntent === "relative";
  const role = result.state === "pending" || result.state === "succeeded" ? "status" : "alert";

  return (
    <div data-settings-result={result.state} className="flex flex-wrap items-center gap-2">
      <p role={role} className="basis-full">{resultMessage(result, locale)}</p>
      {result.state === "credential-required" && <label>{copy.currentPassword}<Input name="retryCredential" type="password" aria-label={copy.currentPassword} value={credential} onInput={(event) => { setCredential(event.currentTarget.value); onActivity(event.timeStamp, "recovery-credential"); }} /></label>}
      {recovery && <Button type="button" disabled={mutationBlocked} onClick={() => { if (mutationBlocked) return; retry(credential === "" ? null : credential); }}>{copy.retry}</Button>}
      {(!versionUsable || result.state === "conflict") && <Button type="button" variant="outline" onClick={reload}>{copy.reload}</Button>}
      {result.state === "reconciliation-required" && <Button type="button" disabled={recoveryBlocked} onClick={() => { if (recoveryBlocked) return; reconcile(); }}>{rewriteExpiration ? copy.saveExpiration : copy.reconcile}</Button>}
    </div>
  );
}

export function SettingsPanel({ state, onActivity, onDraftState, saveTitle, saveFormat, saveExpiration, saveViewOnce, retry, reconcile, reload, discard, locale = "en" }: SettingsPanelProps) {
  const title = useDraft(state.accepted.title);
  const format = useDraft(state.accepted.format);
  const expiration = useDraft(inputExpiration(state.accepted.expiration));
  const viewOnce = useDraft(state.accepted.viewOnce);
  const discardedResult = React.useRef<SettingsPanelState["result"] | null>(null);
  const [, render] = React.useState(0);
  const result = discardedResult.current === state.result ? { field: null, state: "idle" as const, message: null } : state.result;
  const copy = labels(locale);
  const pending = state.result.state === "pending";
  const mutationBlocked = state.mutationOccupied === true || state.mutationPending === true || pending || !state.versionUsable;
  const ownsReconciliation = state.reconciliationOwner === "title" || state.reconciliationOwner === "format" || state.reconciliationOwner === "expiration" || state.reconciliationOwner === "viewOnce"
    || ((state.reconciliationOwner === null || state.reconciliationOwner === undefined) && state.result.state === "reconciliation-required");
  const recoveryBlocked = ownsReconciliation && state.reconciliationRequestPending === true;
  const discardBlocked = pending || (!ownsReconciliation && state.mutationOccupied === true) || (state.reconciliationOwner !== null && state.reconciliationOwner !== undefined && !ownsReconciliation) || recoveryBlocked;
  const standardExpirations = ["permanent", "60", "3600", "86400", "604800", "2592000", "31536000"];
  const reportDraftState = (eventAt?: number) => onDraftState?.(title.dirty() || format.dirty() || expiration.dirty() || viewOnce.dirty(), eventAt);
  const invalid = (field: SettingsField) => result.field === field && result.state === "validation-error";

  React.useEffect(() => {
    if (result.state !== "succeeded" || result.field === null) return;
    if (result.field === "title") title.settle(state.accepted.title);
    if (result.field === "format") format.settle(state.accepted.format);
    if (result.field === "expiration") expiration.settle(inputExpiration(state.accepted.expiration));
    if (result.field === "viewOnce") viewOnce.settle(state.accepted.viewOnce);
    reportDraftState();
  }, [result, state.accepted.expiration, state.accepted.format, state.accepted.title, state.accepted.viewOnce, title, format, expiration, viewOnce, reportDraftState]);

  const reset = () => {
    if (discardBlocked) return;
    if (state.reconciliationOwner === "title") title.discard(state.accepted.title);
    else if (state.reconciliationOwner === "format") format.discard(state.accepted.format);
    else if (state.reconciliationOwner === "expiration") expiration.discard(inputExpiration(state.accepted.expiration));
    else if (state.reconciliationOwner === "viewOnce") viewOnce.discard(state.accepted.viewOnce);
    else {
      title.discard(state.accepted.title);
      format.discard(state.accepted.format);
      expiration.discard(inputExpiration(state.accepted.expiration));
      viewOnce.discard(state.accepted.viewOnce);
    }
    discardedResult.current = state.result;
    reportDraftState();
    render((value) => value + 1);
    discard();
  };

  return (
    <section aria-label={copy.settings} className="grid gap-4">
      <label>{copy.customId}<Input name="id" value={state.accepted.id} readOnly /></label>
      <div className="flex flex-wrap items-end gap-2">
        <label>{copy.title}<Input name="title" value={title.value} aria-invalid={invalid("title")} onInput={(event) => { title.edit(event.currentTarget.value); reportDraftState(event.timeStamp); }} /></label>
        <Button type="button" disabled={mutationBlocked} onClick={() => { if (mutationBlocked) return; saveTitle(title.submit()); }}>{copy.saveTitle}</Button>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label>{copy.format}<select name="format" value={format.value} aria-invalid={invalid("format")} onChange={(event) => { format.edit(event.currentTarget.value as "text" | "markdown"); reportDraftState(event.timeStamp); }}><option value="text">{copy.text}</option><option value="markdown">{copy.markdown}</option></select></label>
        <Button type="button" disabled={mutationBlocked} onClick={() => { if (mutationBlocked) return; saveFormat(format.submit()); }}>{copy.saveFormat}</Button>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label>{copy.expiration}<select name="expiration" value={expiration.value} aria-invalid={invalid("expiration")} onChange={(event) => { expiration.edit(event.currentTarget.value); reportDraftState(event.timeStamp); }}>
          {!standardExpirations.includes(expiration.value) && <option value={expiration.value}>{expiration.value}</option>}
          <option value="permanent">{copy.permanent}</option><option value="60">{copy.oneMinute}</option><option value="3600">{copy.oneHour}</option><option value="86400">{copy.oneDay}</option><option value="604800">{copy.oneWeek}</option><option value="2592000">{copy.thirtyDays}</option><option value="31536000">{copy.oneYear}</option>
        </select></label>
        <Button type="button" disabled={mutationBlocked} onClick={() => { if (mutationBlocked) return; saveExpiration(parseExpiration(expiration.submit())); }}>{copy.saveExpiration}</Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label><Input name="viewOnce" type="checkbox" checked={viewOnce.value} aria-invalid={invalid("viewOnce")} onChange={(event) => { viewOnce.edit(event.currentTarget.checked); reportDraftState(event.timeStamp); }} />{copy.viewOnce}</label>
        <Button type="button" disabled={mutationBlocked} onClick={() => { if (mutationBlocked) return; saveViewOnce(viewOnce.submit()); }}>{copy.saveViewOnce}</Button>
      </div>
      <Button type="button" variant="outline" disabled={discardBlocked} onClick={reset}>{copy.discard}</Button>
      <ResultActions result={result} versionUsable={state.versionUsable} mutationBlocked={mutationBlocked} recoveryBlocked={recoveryBlocked} onActivity={onActivity} retry={retry} reconcile={reconcile} reload={reload} locale={locale} />
    </section>
  );
}
