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
  locale?: Locale;
}

function resultMessage(result: PasswordPanelState["result"], locale: Locale): string {
  if (result.message !== null) return result.message;
  const action = result.action === "set" ? dictionaries[locale].actions["password-set"] : result.action === "clear" ? dictionaries[locale].actions["password-clear"] : undefined;
  if (result.state === "pending") return action?.pending ?? dictionaries[locale].status.lastAction.pending;
  if (result.state === "succeeded") return action?.succeeded ?? dictionaries[locale].status.lastAction.succeeded;
  return action?.failed ?? dictionaries[locale].status.lastAction.failed;
}

export function PasswordPanel({ state, onActivity, onDraftState, setPassword, clearPassword, retry, reconcile, reload, locale = "en" }: PasswordPanelProps) {
  const [newPassword, setNewPassword] = React.useState("");
  const [currentPassword, setCurrentPassword] = React.useState("");
  const [retryCredential, setRetryCredential] = React.useState("");
  const passwords = React.useRef({ newPassword: "", currentPassword: "" });
  const generations = React.useRef<Record<PasswordField, number>>({ newPassword: 0, currentPassword: 0, retryCredential: 0 });
  const submitted = React.useRef<Partial<Record<PasswordField, number>>>({});
  const settledResult = React.useRef<object | null>(null);
  const result = state.result;
  const copy = labels(locale);
  const mutationBlocked = state.mutationOccupied === true || state.mutationPending === true || result.state === "pending" || !state.versionUsable;
  const ownsReconciliation = state.reconciliationOwner === "password";
  const recoveryBlocked = ownsReconciliation && state.reconciliationRequestPending === true;

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
  const role = result.state === "pending" || result.state === "succeeded" ? "status" : "alert";
  const rowClass = "grid min-w-0 grid-cols-[minmax(5.5rem,1fr)_minmax(0,2fr)_minmax(0,1.25fr)] items-center gap-2 [&>label]:flex [&>label]:min-h-11 [&>label]:min-w-0 [&>label]:items-center [&>label]:break-words";
  const buttonClass = "h-auto min-h-11 w-full min-w-0 whitespace-normal break-words px-2 py-1 leading-tight";

  return (
    <section aria-label={copy.password} className="grid min-w-0 gap-2 [&_button]:min-h-11 [&_input]:min-h-11">
      {state.protected && <div data-settings-row="currentPassword" className={rowClass}>
        <label htmlFor="settings-current-password">{copy.currentPassword}</label>
        <Input id="settings-current-password" name="currentPassword" type="password" value={currentPassword} onInput={(event) => { edit("currentPassword", event.currentTarget.value); reportDraftState(event.timeStamp); }} />
        <Button type="button" className={buttonClass} variant="outline" disabled={mutationBlocked} onClick={clear}>{copy.clearPassword}</Button>
      </div>}
      <div data-settings-row="newPassword" className={rowClass}>
        <label htmlFor="settings-new-password">{copy.newPassword}</label>
        <Input id="settings-new-password" name="newPassword" type="password" value={newPassword} onInput={(event) => { edit("newPassword", event.currentTarget.value); reportDraftState(event.timeStamp); }} />
        <Button type="button" className={buttonClass} disabled={mutationBlocked} onClick={submitPassword}>{state.protected ? copy.changePassword : copy.setPassword}</Button>
      </div>
      {result.state !== "idle" && <p role={role} data-password-result={result.state}>{resultMessage(result, locale)}</p>}
      {result.state === "credential-required" && <div className={rowClass}><label htmlFor="settings-retry-password">{copy.currentPassword}</label><Input id="settings-retry-password" name="retryCredential" type="password" value={retryCredential} onInput={(event) => { edit("retryCredential", event.currentTarget.value); onActivity(event.timeStamp, "recovery-credential"); }} /><Button type="button" className={buttonClass} disabled={mutationBlocked} onClick={retryPassword}>{copy.retry}</Button></div>}
      {result.state === "retryable" && <Button type="button" className="justify-self-start" disabled={mutationBlocked} onClick={retryPassword}>{copy.retry}</Button>}
      {result.state === "conflict" && state.versionUsable && <Button type="button" className="justify-self-start" disabled={mutationBlocked} onClick={retryPassword}>{copy.retry}</Button>}
      {result.state === "reconciliation-required" && ownsReconciliation && <Button type="button" className="justify-self-start" disabled={recoveryBlocked} onClick={reconcilePassword}>{copy.reconcile}</Button>}
      {(!state.versionUsable || result.state === "conflict") && <Button type="button" className="justify-self-start" variant="outline" onClick={reload}>{copy.reload}</Button>}
    </section>
  );
}
