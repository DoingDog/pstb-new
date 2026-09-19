import * as React from "react";
import type { ExpirationInput } from "../contracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export type SettingsField = "title" | "format" | "expiration" | "viewOnce";
export type ManagementResultState = "idle" | "pending" | "succeeded" | "validation-error" | "credential-required" | "conflict" | "retryable" | "reconciliation-required";

export interface SettingsPanelState {
  accepted: {
    id: string;
    title: string;
    format: "text" | "markdown";
    expiration: ExpirationInput;
    viewOnce: boolean;
  };
  versionUsable: boolean;
  result: { field: SettingsField | null; state: ManagementResultState; message: string | null };
}

export interface SettingsPanelProps {
  state: SettingsPanelState;
  onActivity(eventAt: number): void;
  saveTitle(value: string): void;
  saveFormat(value: "text" | "markdown"): void;
  saveExpiration(value: ExpirationInput): void;
  saveViewOnce(value: boolean): void;
  retry(credential: string | null): void;
  reconcile(): void;
  reload(): void;
}

function inputExpiration(value: ExpirationInput): string {
  return value === null ? "permanent" : String(value);
}

function parseExpiration(value: string): ExpirationInput {
  if (value === "permanent") return null;
  return /^\d+$/.test(value) ? Number(value) : value;
}

function ResultActions({ state, retry, reconcile, reload, onActivity }: Pick<SettingsPanelProps, "state" | "retry" | "reconcile" | "reload" | "onActivity">) {
  const [credential, setCredential] = React.useState("");
  const result = state.result;
  if (result.state === "idle" || result.state === "pending" || result.state === "succeeded") return null;
  const retryDisabled = result.state === "conflict" && !state.versionUsable;
  const fullRewrite = result.state === "reconciliation-required" && result.field === "expiration";
  return (
    <div data-settings-result={result.state} className="flex flex-wrap items-center gap-2">
      {result.message !== null && <p role="alert" className="basis-full">{result.message}</p>}
      {result.state === "credential-required" && <Input name="retryCredential" type="password" aria-label="Current password" value={credential} onInput={(event) => { setCredential(event.currentTarget.value); onActivity(event.timeStamp); }} />}
      {(result.state === "credential-required" || result.state === "retryable" || result.state === "conflict") && <Button type="button" disabled={retryDisabled} onClick={() => retry(credential === "" ? null : credential)}>Retry</Button>}
      {result.state === "conflict" && <Button type="button" variant="outline" onClick={reload}>Reload</Button>}
      {result.state === "reconciliation-required" && <Button type="button" onClick={reconcile}>{fullRewrite ? "Reconcile expiration as a new full rewrite" : "Reconcile"}</Button>}
    </div>
  );
}

export function SettingsPanel({ state, onActivity, saveTitle, saveFormat, saveExpiration, saveViewOnce, retry, reconcile, reload }: SettingsPanelProps) {
  const [title, setTitle] = React.useState(state.accepted.title);
  const [format, setFormat] = React.useState(state.accepted.format);
  const [expiration, setExpiration] = React.useState(inputExpiration(state.accepted.expiration));
  const [viewOnce, setViewOnce] = React.useState(state.accepted.viewOnce);
  const result = state.result;
  const pending = result.state === "pending";

  React.useEffect(() => { setTitle(state.accepted.title); }, [state.accepted.title]);
  React.useEffect(() => { setFormat(state.accepted.format); }, [state.accepted.format]);
  React.useEffect(() => { setExpiration(inputExpiration(state.accepted.expiration)); }, [state.accepted.expiration]);
  React.useEffect(() => { setViewOnce(state.accepted.viewOnce); }, [state.accepted.viewOnce]);

  const activity = (event: React.SyntheticEvent<HTMLInputElement | HTMLSelectElement>) => onActivity(event.timeStamp);
  const invalid = (field: SettingsField) => result.field === field && result.state === "validation-error";
  const discard = () => {
    setTitle(state.accepted.title);
    setFormat(state.accepted.format);
    setExpiration(inputExpiration(state.accepted.expiration));
    setViewOnce(state.accepted.viewOnce);
  };

  return (
    <section aria-label="Settings" className="grid gap-4">
      <label>ID<Input name="id" value={state.accepted.id} readOnly /></label>
      <div className="flex flex-wrap items-end gap-2">
        <label>Title<Input name="title" value={title} aria-invalid={invalid("title")} onInput={(event) => { setTitle(event.currentTarget.value); activity(event); }} /></label>
        <Button type="button" disabled={pending} onClick={() => saveTitle(title)}>Save title</Button>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label>Format<select name="format" value={format} aria-invalid={invalid("format")} onChange={(event) => { setFormat(event.currentTarget.value as "text" | "markdown"); activity(event); }}><option value="text">Text</option><option value="markdown">Markdown</option></select></label>
        <Button type="button" disabled={pending} onClick={() => saveFormat(format)}>Save format</Button>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label>Expiration<select name="expiration" value={expiration} aria-invalid={invalid("expiration")} onChange={(event) => { setExpiration(event.currentTarget.value); activity(event); }}><option value="permanent">Permanent</option><option value="60">1 minute</option><option value="3600">1 hour</option><option value="86400">1 day</option><option value="604800">1 week</option><option value="2592000">30 days</option><option value="31536000">1 year</option></select></label>
        <Button type="button" disabled={pending} onClick={() => saveExpiration(parseExpiration(expiration))}>Save expiration</Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label><Input name="viewOnce" type="checkbox" checked={viewOnce} aria-invalid={invalid("viewOnce")} onChange={(event) => { setViewOnce(event.currentTarget.checked); activity(event); }} />View once</label>
        <Button type="button" disabled={pending} onClick={() => saveViewOnce(viewOnce)}>Save view once</Button>
      </div>
      <Button type="button" variant="outline" onClick={discard}>Discard</Button>
      <ResultActions state={state} onActivity={onActivity} retry={retry} reconcile={reconcile} reload={reload} />
    </section>
  );
}
