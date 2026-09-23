import * as React from "react";
import { dictionaries, labels, type Locale } from "../../i18n";
import type { TrustedMarkdownHtml } from "../bootstrap";
import type { AppBootstrap, OperationRecords, PasteSummary } from "../contracts";
import { DeleteFlow } from "../components/DeleteFlow";
import { HistoryPanel } from "../components/HistoryPanel";
import { OrdinaryPastePage } from "../components/OrdinaryPastePage";
import { PasswordPanel } from "../components/PasswordPanel";
import { SettingsPanel } from "../components/SettingsPanel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { usePastePage, type PastePageCandidate, type TerminalHandoff } from "../hooks/use-paste-page";

export interface OrdinaryPageProps {
  initialPage: {
    ok: true;
    bootstrap: Extract<AppBootstrap, { page: "paste"; consumed: false }>;
    exactSource: string;
    initialMarkdown: TrustedMarkdownHtml | null;
    password: string | null;
  };
  locale: Locale;
  onRecordsChange(records: OperationRecords): void;
  onSummaryChange(summary: PasteSummary | null): void;
  onTerminal(handoff: TerminalHandoff): void;
  onRootHandoff(): void;
}

function SyncCandidate({ candidate, locale, useRemote, keepCurrent, retrySync, activity }: {
  candidate: PastePageCandidate | null;
  locale: Locale;
  useRemote(): void;
  keepCurrent(): void;
  retrySync(credential: string | null): void;
  activity(eventAt: number, kind?: "recovery-credential"): void;
}) {
  const [credential, setCredential] = React.useState("");
  if (candidate === null) return null;
  const copy = labels(locale);
  if (candidate.kind === "forbidden") {
    return (
      <section data-sync-candidate="true" aria-label={copy.autosync} className="flex flex-wrap items-end gap-2">
        <p role="status">{copy.autosync}</p>
        <label>{copy.currentPassword}<Input name="syncRetryCredential" type="password" value={credential} onInput={(event) => {
          setCredential(event.currentTarget.value);
          activity(event.timeStamp, "recovery-credential");
        }} /></label>
        <Button type="button" variant="outline" onClick={() => retrySync(credential === "" ? null : credential)}>{copy.retry}</Button>
      </section>
    );
  }
  if (candidate.kind !== "remote") return null;
  return (
    <section data-sync-candidate="true" aria-label={copy.autosync} className="flex flex-wrap items-center gap-2">
      <p role="status">{copy.autosync}</p>
      <Button type="button" onClick={useRemote}>{copy.useRemote}</Button>
      <Button type="button" variant="outline" onClick={keepCurrent}>{copy.keepCurrent}</Button>
      <Button type="button" variant="outline" onClick={() => retrySync(null)}>{copy.retry}</Button>
    </section>
  );
}

function ContentRecovery({ state, reconciliationRequired, reconciliationRequestPending, retry, reconcile, reload, overwrite, activity, locale }: {
  state: "clean" | "waiting" | "saving" | "saved" | "error" | "password-required" | "not-found" | "conflict";
  reconciliationRequired: boolean;
  reconciliationRequestPending: boolean;
  retry(credential: string | null): void;
  reconcile(credential: string | null): void;
  reload(): void;
  overwrite(): void;
  activity(eventAt: number, kind?: "recovery-credential"): void;
  locale: Locale;
}) {
  const [credential, setCredential] = React.useState("");
  const copy = labels(locale);
  if (!reconciliationRequired && state !== "error" && state !== "password-required" && state !== "conflict") return null;
  return (
    <section aria-label={copy.autosave} className="flex flex-wrap items-end gap-2">
      {state === "password-required" && <label>{copy.currentPassword}<Input name="contentRetryCredential" type="password" value={credential} onInput={(event) => { setCredential(event.currentTarget.value); activity(event.timeStamp, "recovery-credential"); }} /></label>}
      {reconciliationRequired && <Button type="button" disabled={reconciliationRequestPending} onClick={() => { if (reconciliationRequestPending) return; reconcile(credential === "" ? null : credential); }}>{copy.reconcile}</Button>}
      {!reconciliationRequired && state !== "conflict" && <Button type="button" onClick={() => retry(credential === "" ? null : credential)}>{copy.retry}</Button>}
      {state === "conflict" && <>
        <Button type="button" variant="outline" onClick={reload}>{copy.reload}</Button>
        <Button type="button" variant="destructive" onClick={overwrite}>{dictionaries[locale].actions.overwrite.pending}</Button>
      </>}
    </section>
  );
}

export function OrdinaryPage({ initialPage, locale, onRecordsChange, onSummaryChange, onTerminal, onRootHandoff }: OrdinaryPageProps) {
  const { snapshot, actions } = usePastePage(initialPage, { onRecordsChange, onSummaryChange, onTerminal, onRootHandoff });
  const [reloadOpen, setReloadOpen] = React.useState(false);
  const [overwriteOpen, setOverwriteOpen] = React.useState(false);
  const requestReload = React.useCallback(() => setReloadOpen(true), []);
  const confirmReload = React.useCallback(() => {
    setReloadOpen(false);
    actions.reload();
  }, [actions]);
  const confirmOverwrite = React.useCallback(() => {
    setOverwriteOpen(false);
    actions.overwrite();
  }, [actions]);
  const autosave = React.useMemo(() => ({
    input: actions.autosaveInput,
    compositionStart: actions.compositionStart,
    compositionEnd: actions.compositionEnd,
  }), [actions]);
  const setDiffMounted = React.useCallback((mounted: boolean) => actions.setSurfaceMounted("diff", mounted), [actions]);
  const password = snapshot.paste.resource === "active" ? snapshot.paste.credential.committed : initialPage.password;
  const initialMarkdown = snapshot.source === initialPage.exactSource ? initialPage.initialMarkdown : null;

  return (
    <>
      <OrdinaryPastePage
      pasteIdentity={snapshot.settings.accepted.id}
      format={snapshot.settings.accepted.format}
      source={snapshot.source}
      derivedSource={snapshot.derivedSource}
      derivedGeneration={snapshot.derivedGeneration}
      derivedPreview={snapshot.derivedPreview}
      derivedVisual={snapshot.derivedVisual}
      derivedFallback={snapshot.derivedFallback}
      onRetrySurface={(surface) => {
        if (surface === "preview") actions.retryPreview();
        else if (surface === "visual") actions.retryVisual();
        else actions.retryDiff();
      }}
      acceptedSource={snapshot.acceptedSource}
      version={snapshot.version ?? initialPage.bootstrap.paste.version}
      autosaveAcceptedSource={snapshot.autosaveAcceptedSource}
      lastSavedContent={snapshot.lastSavedContent}
      autosaveState={snapshot.autosave.state}
      initialMarkdown={initialMarkdown}
      links={initialPage.bootstrap.paste.links}
      password={password}
      locale={locale}
      autosave={autosave}
      onSourceEvent={actions.sourceEvent}
      onSurfaceMounted={actions.setSurfaceMounted}
      onActionState={actions.localAction}
      historyPanel={
        <HistoryPanel
          active
          state={snapshot.history}
          openHistory={actions.openHistory}
          selectRevision={actions.selectRevision}
          computeDiff={actions.computeDiff}
          setDiffMounted={setDiffMounted}
          derivedFallback={snapshot.derivedFallback}
          retryDiff={actions.retryDiff}
          back={actions.back}
          locale={locale}
        />
      }
      settingsPanel={
        <SettingsPanel
          state={snapshot.settings}
          onActivity={actions.activity}
          onDraftState={(dirty, eventAt) => actions.draftState("settings", dirty, eventAt)}
          saveTitle={actions.saveTitle}
          saveFormat={actions.saveFormat}
          saveExpiration={actions.saveExpiration}
          saveViewOnce={actions.saveViewOnce}
          retry={actions.retry}
          reconcile={actions.reconcile}
          reload={requestReload}
          discard={actions.discard}
          locale={locale}
        />
      }
      passwordPanel={
        <PasswordPanel
          state={snapshot.password}
          onActivity={actions.activity}
          onDraftState={(dirty, eventAt) => actions.draftState("password", dirty, eventAt)}
          setPassword={actions.setPassword}
          clearPassword={actions.clearPassword}
          retry={actions.retry}
          reconcile={actions.reconcile}
          reload={requestReload}
          discard={actions.discard}
          locale={locale}
        />
      }
      deleteFlow={
        <DeleteFlow
          state={snapshot.deleteFlow}
          deletePaste={actions.deletePaste}
          retry={actions.retry}
          reload={requestReload}
          onActivity={actions.activity}
          locale={locale}
        />
      }
    />
    {snapshot.contentRecoveryAllowed && <ContentRecovery
      state={snapshot.autosave.state}
      reconciliationRequired={snapshot.paste.resource === "active" && snapshot.paste.reconciliation.owner === "content"}
      reconciliationRequestPending={snapshot.paste.resource === "active" && snapshot.paste.reconciliation.owner === "content" && snapshot.paste.reconciliation.requestPending}
      retry={(credential) => actions.retry(credential, "content")}
      reconcile={(credential) => actions.retry(credential, "content")}
      reload={requestReload}
      overwrite={() => setOverwriteOpen(true)}
      activity={actions.activity}
      locale={locale}
    />}
    <SyncCandidate
      candidate={snapshot.candidate}
      locale={locale}
      useRemote={actions.useRemote}
      keepCurrent={actions.keepCurrent}
      retrySync={actions.retrySync}
      activity={actions.activity}
    />
    <Dialog open={reloadOpen} onOpenChange={setReloadOpen}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{labels(locale).reload}</DialogTitle>
          <DialogDescription>{labels(locale).reloadServer}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setReloadOpen(false)}>{labels(locale).cancel}</Button>
          <Button type="button" onClick={confirmReload}>{labels(locale).reload}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={overwriteOpen} onOpenChange={setOverwriteOpen}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{dictionaries[locale].actions.overwrite.pending}</DialogTitle>
          <DialogDescription>{labels(locale).save}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOverwriteOpen(false)}>{labels(locale).cancel}</Button>
          <Button type="button" variant="destructive" onClick={confirmOverwrite}>{dictionaries[locale].actions.overwrite.pending}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}
