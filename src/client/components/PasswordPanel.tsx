import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export type PasswordResultState = "idle" | "pending" | "succeeded" | "validation-error" | "credential-required" | "retryable" | "reconciliation-required";

export interface PasswordPanelState {
  protected: boolean;
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
}

export function PasswordPanel({ state, onActivity, setPassword, clearPassword, retry, reconcile }: PasswordPanelProps) {
  const [newPassword, setNewPassword] = React.useState("");
  const [currentPassword, setCurrentPassword] = React.useState("");
  const [retryCredential, setRetryCredential] = React.useState("");
  const result = state.result;

  React.useLayoutEffect(() => {
    if (result.state === "succeeded") {
      setNewPassword("");
      setCurrentPassword("");
      setRetryCredential("");
    }
  }, [result.action, result.state]);

  const activity = (event: React.SyntheticEvent<HTMLInputElement>) => onActivity(event.timeStamp);
  const authorization = state.protected ? (currentPassword === "" ? null : currentPassword) : null;
  const retryAuthorization = retryCredential === "" ? null : retryCredential;
  const pending = result.state === "pending";

  return (
    <section aria-label="Password" className="grid gap-3">
      {state.protected && <label>Current password<Input name="currentPassword" type="password" value={currentPassword} onInput={(event) => { setCurrentPassword(event.currentTarget.value); activity(event); }} /></label>}
      <label>New password<Input name="newPassword" type="password" value={newPassword} onInput={(event) => { setNewPassword(event.currentTarget.value); activity(event); }} /></label>
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={pending} onClick={() => setPassword(newPassword, authorization)}>{state.protected ? "Change password" : "Set password"}</Button>
        {state.protected && <Button type="button" variant="outline" disabled={pending} onClick={() => clearPassword(authorization)}>Clear password</Button>}
      </div>
      {result.message !== null && result.state !== "idle" && <p role="alert" data-password-result={result.state}>{result.message}</p>}
      {result.state === "credential-required" && <div className="flex flex-wrap items-end gap-2"><label>Current password<Input name="retryCredential" type="password" value={retryCredential} onInput={(event) => { setRetryCredential(event.currentTarget.value); activity(event); }} /></label><Button type="button" onClick={() => retry(retryAuthorization)}>Retry</Button></div>}
      {result.state === "retryable" && <Button type="button" onClick={() => retry(retryAuthorization)}>Retry</Button>}
      {result.state === "reconciliation-required" && <Button type="button" onClick={() => reconcile()}>Reconcile</Button>}
      <nav aria-label="Representations" className="flex flex-wrap gap-2"><a aria-label="Current URL" href={state.currentUrl}>Current URL</a>{state.representations.map((representation) => <a key={representation.href} href={representation.href}>{representation.label}</a>)}</nav>
    </section>
  );
}
