import * as React from "react";
import { dictionaries, labels, type Locale } from "../../i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export type PasswordResultState = "idle" | "pending" | "succeeded" | "validation-error" | "credential-required" | "conflict" | "retryable" | "reconciliation-required";
type PasswordField = "newPassword" | "currentPassword" | "retryCredential";

export interface PasswordPanelState {
  protected: boolean;
  versionUsable: boolean;
  result: { action: "set" | "clear" | null; state: PasswordResultState; message: string | null };
  currentUrl: string;
  representations: readonly { label: string; href: string }[];
}

export interface PasswordPanelProps {
  state: PasswordPanelState;
  onActivity(eventAt: number): void;
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

export function PasswordPanel({ state, onActivity, setPassword, clearPassword, retry, reconcile, reload, discard, locale = "en" }: PasswordPanelProps) {
  const [newPassword, setNewPassword] = React.useState("");
  const [currentPassword, setCurrentPassword] = React.useState("");
  const [retryCredential, setRetryCredential] = React.useState("");
  const generations = React.useRef<Record<PasswordField, number>>({ newPassword: 0, currentPassword: 0, retryCredential: 0 });
  const submitted = React.useRef<Partial<Record<PasswordField, number>>>({});
  const discardedResult = React.useRef<PasswordPanelState["result"] | null>(null);
  const [, render] = React.useState(0);
  const result = discardedResult.current === state.result ? { action: null, state: "idle" as const, message: null } : state.result;
  const copy = labels(locale);
  const locked = result.state === "conflict" && !state.versionUsable;
  const pending = result.state === "pending";
  const disabled = pending || locked;

  const edit = (field: PasswordField, value: string) => {
    generations.current[field] += 1;
    if (field === "newPassword") setNewPassword(value);
    if (field === "currentPassword") setCurrentPassword(value);
    if (field === "retryCredential") setRetryCredential(value);
  };
  const capture = (...fields: PasswordField[]) => {
    for (const field of fields) submitted.current[field] = generations.current[field];
  };

  React.useLayoutEffect(() => {
    if (result.state !== "succeeded") return;
    const clear = (field: PasswordField) => {
      if (submitted.current[field] !== generations.current[field]) return;
      if (field === "newPassword") setNewPassword("");
      if (field === "currentPassword") setCurrentPassword("");
      if (field === "retryCredential") setRetryCredential("");
    };
    clear("newPassword");
    clear("currentPassword");
    clear("retryCredential");
    submitted.current = {};
  }, [result.action, result.state]);

  const activity = (event: React.SyntheticEvent<HTMLInputElement>) => onActivity(event.timeStamp);
  const authorization = state.protected ? (currentPassword === "" ? null : currentPassword) : null;
  const retryAuthorization = retryCredential === "" ? null : retryCredential;
  const reset = () => {
    submitted.current = {};
    setNewPassword("");
    setCurrentPassword("");
    setRetryCredential("");
    discardedResult.current = state.result;
    render((value) => value + 1);
    discard();
  };
  const role = result.state === "pending" || result.state === "succeeded" ? "status" : "alert";

  return (
    <section aria-label={copy.password} className="grid gap-3">
      {state.protected && <label>{copy.currentPassword}<Input name="currentPassword" type="password" value={currentPassword} onInput={(event) => { edit("currentPassword", event.currentTarget.value); activity(event); }} /></label>}
      <label>{copy.newPassword}<Input name="newPassword" type="password" value={newPassword} onInput={(event) => { edit("newPassword", event.currentTarget.value); activity(event); }} /></label>
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={disabled} onClick={() => { capture("newPassword", "currentPassword"); setPassword(newPassword, authorization); }}>{state.protected ? copy.changePassword : copy.setPassword}</Button>
        {state.protected && <Button type="button" variant="outline" disabled={disabled} onClick={() => { capture("currentPassword"); clearPassword(authorization); }}>{copy.clearPassword}</Button>}
      </div>
      {result.state !== "idle" && <p role={role} data-password-result={result.state}>{resultMessage(result, locale)}</p>}
      {result.state === "credential-required" && !locked && <div className="flex flex-wrap items-end gap-2"><label>{copy.currentPassword}<Input name="retryCredential" type="password" value={retryCredential} onInput={(event) => { edit("retryCredential", event.currentTarget.value); activity(event); }} /></label><Button type="button" onClick={() => { capture("retryCredential"); retry(retryAuthorization); }}>{copy.retry}</Button></div>}
      {result.state === "retryable" && !locked && <Button type="button" onClick={() => { capture("retryCredential"); retry(retryAuthorization); }}>{copy.retry}</Button>}
      {result.state === "conflict" && (locked ? <Button type="button" variant="outline" onClick={reload}>{copy.reload}</Button> : <><Button type="button" onClick={() => retry(retryAuthorization)}>{copy.retry}</Button><Button type="button" variant="outline" onClick={reload}>{copy.reload}</Button></>)}
      {result.state === "reconciliation-required" && !locked && <Button type="button" onClick={() => reconcile()}>{copy.reconcile}</Button>}
      <Button type="button" variant="outline" onClick={reset}>{copy.discard}</Button>
      <nav aria-label={copy.representations} className="flex flex-wrap gap-2"><a aria-label={copy.paste} href={state.currentUrl}>{copy.paste}</a>{state.representations.map((representation) => <a key={representation.href} href={representation.href}>{representation.label}</a>)}</nav>
    </section>
  );
}
