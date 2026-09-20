import * as React from "react";
import { dictionaries, labels, type Locale } from "../../i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export type PasswordResultState = "idle" | "pending" | "succeeded" | "validation-error" | "credential-required" | "conflict" | "retryable" | "reconciliation-required";
type PasswordField = "newPassword" | "currentPassword" | "retryCredential";

export interface PasswordPanelState {
  protected: boolean;
  versionUsable: boolean;
  mutationPending?: boolean;
  mutationOccupied?: boolean;
  reconciliationOwner?: "content" | "title" | "format" | "expiration" | "viewOnce" | "password" | null;
  reconciliationRequestPending?: boolean;
  resultIdentity?: object;
  result: { action: "set" | "clear" | null; state: PasswordResultState; message: string | null };
  currentUrl: string;
  representations: readonly { label: string; href: string }[];
}

export interface PasswordPanelProps {
  state: PasswordPanelState;
  onActivity(eventAt: number, kind?: "recovery-credential"): void;
  onDraftState?(dirty: boolean, eventAt?: number): void;
  setPassword(newPassword: string, authorizationPassword: string | null): void;
  clearPassword(authorizationPassword: string | null): void;
  retry(authorizationPassword: string | null): void;
  reconcile(): void;
  reload(): void;
  discard(): void;
  locale?: Locale;
}

function resultMessage(result: PasswordPanelState["result"], locale: Locale): string {
  if (result.message !== null) return result.message;
  const action = result.action === "set" ? dictionaries[locale].actions["password-set"] : result.action === "clear" ? dictionaries[locale].actions["password-clear"] : undefined;
  if (result.state === "pending") return action?.pending ?? dictionaries[locale].status.lastAction.pending;
  if (result.state === "succeeded") return action?.succeeded ?? dictionaries[locale].status.lastAction.succeeded;
  return action?.failed ?? dictionaries[locale].status.lastAction.failed;
}

export function PasswordPanel({ state, onActivity, onDraftState, setPassword, clearPassword, retry, reconcile, reload, discard, locale = "en" }: PasswordPanelProps) {
  const [newPassword, setNewPassword] = React.useState("");
  const [currentPassword, setCurrentPassword] = React.useState("");
  const [retryCredential, setRetryCredential] = React.useState("");
  const passwords = React.useRef({ newPassword: "", currentPassword: "" });
  const generations = React.useRef<Record<PasswordField, number>>({ newPassword: 0, currentPassword: 0, retryCredential: 0 });
  const submitted = React.useRef<Partial<Record<PasswordField, number>>>({});
  const discardedResult = React.useRef<PasswordPanelState["result"] | null>(null);
  const settledResult = React.useRef<object | null>(null);
  const [, render] = React.useState(0);
  const result = discardedResult.current === state.result ? { action: null, state: "idle" as const, message: null } : state.result;
  const copy = labels(locale);
  const pending = state.result.state === "pending";
  const mutationBlocked = state.mutationOccupied === true || state.mutationPending === true || pending || !state.versionUsable;
  const ownsReconciliation = state.reconciliationOwner === "password";
  const foreignReconciliation = state.reconciliationOwner !== null && state.reconciliationOwner !== undefined && !ownsReconciliation;
  const recoveryBlocked = ownsReconciliation && state.reconciliationRequestPending === true;
  const discardBlocked = pending || foreignReconciliation || (!ownsReconciliation && state.mutationOccupied === true) || recoveryBlocked;

  const edit = (field: PasswordField, value: string) => {
    generations.current[field] += 1;
    if (field === "newPassword") {
      passwords.current.newPassword = value;
      setNewPassword(value);
    }
    if (field === "currentPassword") {
      passwords.current.currentPassword = value;
      setCurrentPassword(value);
    }
    if (field === "retryCredential") setRetryCredential(value);
  };
  const reportDraftState = (eventAt?: number) => onDraftState?.(passwords.current.newPassword !== "" || passwords.current.currentPassword !== "", eventAt);
  const resultIdentity = state.resultIdentity ?? state.result;
  const capture = (...fields: PasswordField[]) => {
    for (const field of fields) submitted.current[field] = generations.current[field];
  };

  React.useLayoutEffect(() => {
    if (result.state !== "succeeded" || settledResult.current === resultIdentity) return;
    settledResult.current = resultIdentity;
    const clear = (field: PasswordField) => {
      if (submitted.current[field] !== generations.current[field]) return;
      if (field === "newPassword") {
        passwords.current.newPassword = "";
        setNewPassword("");
      }
      if (field === "currentPassword") {
        passwords.current.currentPassword = "";
        setCurrentPassword("");
      }
      if (field === "retryCredential") setRetryCredential("");
    };
    clear("newPassword");
    clear("currentPassword");
    clear("retryCredential");
    submitted.current = {};
    reportDraftState();
  }, [result.action, result.state, resultIdentity, reportDraftState]);

  const authorization = state.protected ? (currentPassword === "" ? null : currentPassword) : null;
  const retryAuthorization = retryCredential === "" ? null : retryCredential;
  const submitPassword = () => {
    if (mutationBlocked) return;
    capture("newPassword", "currentPassword");
    setPassword(newPassword, authorization);
  };
  const clear = () => {
    if (mutationBlocked) return;
    capture("currentPassword");
    clearPassword(authorization);
  };
  const retryPassword = () => {
    if (mutationBlocked) return;
    capture("retryCredential");
    retry(retryAuthorization);
  };
  const reconcilePassword = () => {
    if (!ownsReconciliation || recoveryBlocked) return;
    reconcile();
  };
  const reset = () => {
    if (foreignReconciliation || discardBlocked) return;
    submitted.current = {};
    passwords.current = { newPassword: "", currentPassword: "" };
    setNewPassword("");
    setCurrentPassword("");
    setRetryCredential("");
    discardedResult.current = state.result;
    reportDraftState();
    render((value) => value + 1);
    discard();
  };
  const role = result.state === "pending" || result.state === "succeeded" ? "status" : "alert";

  return (
    <section aria-label={copy.password} className="grid gap-3">
      {state.protected && <label>{copy.currentPassword}<Input name="currentPassword" type="password" value={currentPassword} onInput={(event) => { edit("currentPassword", event.currentTarget.value); reportDraftState(event.timeStamp); }} /></label>}
      <label>{copy.newPassword}<Input name="newPassword" type="password" value={newPassword} onInput={(event) => { edit("newPassword", event.currentTarget.value); reportDraftState(event.timeStamp); }} /></label>
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={mutationBlocked} onClick={submitPassword}>{state.protected ? copy.changePassword : copy.setPassword}</Button>
        {state.protected && <Button type="button" variant="outline" disabled={mutationBlocked} onClick={clear}>{copy.clearPassword}</Button>}
      </div>
      {result.state !== "idle" && <p role={role} data-password-result={result.state}>{resultMessage(result, locale)}</p>}
      {result.state === "credential-required" && <div className="flex flex-wrap items-end gap-2"><label>{copy.currentPassword}<Input name="retryCredential" type="password" value={retryCredential} onInput={(event) => { edit("retryCredential", event.currentTarget.value); onActivity(event.timeStamp, "recovery-credential"); }} /></label><Button type="button" disabled={mutationBlocked} onClick={retryPassword}>{copy.retry}</Button></div>}
      {result.state === "retryable" && <Button type="button" disabled={mutationBlocked} onClick={retryPassword}>{copy.retry}</Button>}
      {result.state === "conflict" && state.versionUsable && <Button type="button" disabled={mutationBlocked} onClick={retryPassword}>{copy.retry}</Button>}
      {result.state === "reconciliation-required" && ownsReconciliation && <Button type="button" disabled={recoveryBlocked} onClick={reconcilePassword}>{copy.reconcile}</Button>}
      {(!state.versionUsable || result.state === "conflict") && <Button type="button" variant="outline" onClick={reload}>{copy.reload}</Button>}
      {!foreignReconciliation && <Button type="button" variant="outline" disabled={discardBlocked} onClick={reset}>{copy.discard}</Button>}
      <nav aria-label={copy.representations} className="flex flex-wrap gap-2"><a aria-label={copy.paste} href={state.currentUrl}>{copy.paste}</a>{state.representations.map((representation) => <a key={representation.href} href={representation.href}>{representation.label}</a>)}</nav>
    </section>
  );
}
