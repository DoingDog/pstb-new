import * as React from "react";
import { labels, type Locale } from "../../i18n";
import type { TrustedMarkdownHtml } from "../bootstrap";
import type { AppBootstrap, OperationRecords } from "../contracts";
import { DeleteFlow } from "../components/DeleteFlow";
import { HistoryPanel } from "../components/HistoryPanel";
import { OrdinaryPastePage } from "../components/OrdinaryPastePage";
import { PasswordPanel } from "../components/PasswordPanel";
import { SettingsPanel } from "../components/SettingsPanel";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { usePastePage, type PastePageCandidate, type TerminalPage } from "../hooks/use-paste-page";

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
  onTerminal(page: TerminalPage): void;
  onRootHandoff(): void;
}

function SyncCandidate({ candidate, locale, useRemote, keepCurrent, retrySync }: {
  candidate: PastePageCandidate | null;
  locale: Locale;
  useRemote(): void;
  keepCurrent(): void;
  retrySync(): void;
}) {
  if (candidate?.kind !== "remote") return null;
  const copy = labels(locale);
  return (
    <section data-sync-candidate="true" aria-label={copy.autosync} className="flex flex-wrap items-center gap-2">
      <p role="status">{copy.autosync}</p>
      <Button type="button" onClick={useRemote}>{copy.useRemote}</Button>
      <Button type="button" variant="outline" onClick={keepCurrent}>{copy.keepCurrent}</Button>
      <Button type="button" variant="outline" onClick={retrySync}>{copy.retry}</Button>
    </section>
  );
}

export function OrdinaryPage({ initialPage, locale, onRecordsChange, onTerminal, onRootHandoff }: OrdinaryPageProps) {
  const { snapshot, actions } = usePastePage(initialPage, { onRecordsChange, onTerminal, onRootHandoff });
  const [reloadOpen, setReloadOpen] = React.useState(false);
  const requestReload = React.useCallback(() => setReloadOpen(true), []);
  const confirmReload = React.useCallback(() => {
    setReloadOpen(false);
    actions.reload();
  }, [actions]);
  const autosave = React.useMemo(() => ({
    input: actions.autosaveInput,
    compositionStart: actions.compositionStart,
    compositionEnd: actions.compositionEnd,
  }), [actions]);
  const password = snapshot.paste.resource === "active" ? snapshot.paste.credential.committed : initialPage.password;
  const initialMarkdown = snapshot.source === initialPage.exactSource ? initialPage.initialMarkdown : null;

  return (
    <>
      <OrdinaryPastePage
      pasteIdentity={snapshot.settings.accepted.id}
      format={snapshot.settings.accepted.format}
      source={snapshot.source}
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
      historyPanel={
        <HistoryPanel
          active
          state={snapshot.history}
          openHistory={actions.openHistory}
          selectRevision={actions.selectRevision}
          computeDiff={actions.computeDiff}
          back={actions.back}
          locale={locale}
        />
      }
      settingsPanel={
        <SettingsPanel
          state={snapshot.settings}
          onActivity={actions.activity}
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
          locale={locale}
        />
      }
    />
    <SyncCandidate
      candidate={snapshot.candidate}
      locale={locale}
      useRemote={actions.useRemote}
      keepCurrent={actions.keepCurrent}
      retrySync={actions.retrySync}
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
    </>
  );
}
