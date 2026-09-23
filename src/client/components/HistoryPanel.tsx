import * as React from "react";
import { dictionaries, errorMessage, labels, type Locale } from "../../i18n";
import type { HistoryControllerSnapshot } from "../history";
import { formatHistoryDiffLine } from "../history";
import type { DiffLine } from "../diff";
import type { DerivedSurface } from "../surface-apply";
import { useIsMobile } from "@/hooks/use-mobile";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { HelpTrigger } from "./HelpTrigger";
import { useOverflowFocus } from "./useOverflowFocus";

export interface HistoryDiffState {
  state: "idle" | "computing" | "ready" | "manual" | "failed";
  lines: readonly DiffLine[];
  error?: string;
}

export interface HistoryPanelState extends Pick<HistoryControllerSnapshot, "listState" | "snapshotState" | "list" | "selected" | "failure"> {
  diff: HistoryDiffState;
}

export interface HistoryPanelProps {
  active: boolean;
  state: HistoryPanelState;
  openHistory(): void;
  selectRevision(revision: number): void;
  computeDiff(): void;
  setDiffMounted?(mounted: boolean): void;
  derivedFallback?: { surface: DerivedSurface; source: string; generation: number } | null;
  retryDiff?(): void;
  back(): void;
  locale?: Locale;
}

function historyFailure(state: HistoryPanelState, locale: Locale): string | null {
  return state.failure === null ? null : errorMessage(locale, state.failure.value.code);
}

const noDiffMountChange = (_mounted: boolean): void => undefined;

function DiffLifecycle({ mounted, setDiffMounted }: { mounted: boolean; setDiffMounted(mounted: boolean): void }) {
  React.useEffect(() => {
    setDiffMounted(mounted);
    return () => setDiffMounted(false);
  }, [mounted, setDiffMounted]);
  return null;
}

function Detail({ state, computeDiff, setDiffMounted, fallback, retryDiff, back, backButtonRef, mobile, locale }: { state: HistoryPanelState; computeDiff(): void; setDiffMounted(mounted: boolean): void; fallback: HistoryPanelProps["derivedFallback"]; retryDiff: HistoryPanelProps["retryDiff"]; back(): void; backButtonRef: React.Ref<HTMLButtonElement>; mobile: boolean; locale: Locale }) {
  const copy = labels(locale);
  const failure = historyFailure(state, locale);
  const backButton = mobile && <Button ref={backButtonRef} type="button" variant="outline" className="min-h-11 min-w-11" onClick={back}>{copy.back}</Button>;
  if (state.snapshotState === "loading") return <section data-history-detail="true" aria-label={copy.selectedRevision}>{backButton}<p>{dictionaries[locale].actions["history-snapshot"].pending}</p></section>;
  if (state.snapshotState === "failed") return <section data-history-detail="true" aria-label={copy.selectedRevision}>{backButton}<p role="alert">{failure ?? errorMessage(locale, "UNKNOWN_ERROR")}</p></section>;
  if (state.selected === null) return mobile ? null : <section data-history-detail="true" aria-label={copy.selectedRevision}><p>{copy.selectedRevision}</p></section>;

  return <DetailTabs state={state} computeDiff={computeDiff} setDiffMounted={setDiffMounted} fallback={fallback} retryDiff={retryDiff} backButton={backButton} locale={locale} />;
}

function DetailTabs({ state, computeDiff, setDiffMounted, fallback, retryDiff, backButton, locale }: { state: HistoryPanelState; computeDiff(): void; setDiffMounted(mounted: boolean): void; fallback: HistoryPanelProps["derivedFallback"]; retryDiff: HistoryPanelProps["retryDiff"]; backButton: React.ReactNode; locale: Locale }) {
  const copy = labels(locale);
  const [tab, setTab] = React.useState("diff");
  const overflow = useOverflowFocus(true, tab === "diff" ? state.diff.lines : state.selected!.content);
  return (
    <section data-history-detail="true" aria-label={copy.selectedRevision} className="min-w-0">
      <DiffLifecycle mounted={tab === "diff"} setDiffMounted={setDiffMounted} />
      {backButton}
      <h2 className="mt-2 text-base font-medium">{copy.revision} {state.selected!.revision}</h2>
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="diff">{copy.unifiedDiff}</TabsTrigger>
          <TabsTrigger value="snapshot">{copy.fullSnapshot}</TabsTrigger>
        </TabsList>
        <TabsContent value="diff">
          {state.diff.state === "manual" && <div className="flex items-center gap-1"><Button type="button" className="min-h-11 min-w-11" onClick={computeDiff}>{copy.computeDiff}</Button><HelpTrigger label={copy.help} content={dictionaries[locale].help.largeDiff} descriptionId="history-large-diff-help" /></div>}
          {state.diff.state === "computing" && <p role="status">{copy.computeDiff}</p>}
          {state.diff.state === "failed" && <p role="alert">{state.diff.error ?? errorMessage(locale, "UNKNOWN_ERROR")}</p>}
          {fallback?.surface === "diff" && <div data-derived-fallback="diff" data-derived-generation={String(fallback.generation)}><Button type="button" variant="outline" className="min-h-11 min-w-11" onClick={retryDiff}>{copy.retry}</Button></div>}
          {state.diff.state === "ready" && <pre ref={overflow.ref} aria-label={copy.selectedRevision} className="whitespace-pre-wrap" tabIndex={overflow.tabIndex}>{state.diff.lines.map((line, index) => <React.Fragment key={index}>{formatHistoryDiffLine(line)}</React.Fragment>)}</pre>}
        </TabsContent>
        <TabsContent value="snapshot"><pre ref={overflow.ref} className="whitespace-pre-wrap" tabIndex={overflow.tabIndex}>{state.selected!.content}</pre></TabsContent>
      </Tabs>
    </section>
  );
}

export function HistoryPanel({ active, state, openHistory, selectRevision, computeDiff, setDiffMounted = noDiffMountChange, derivedFallback = null, retryDiff, back, locale = "en" }: HistoryPanelProps) {
  const wasActive = React.useRef(false);
  const wasMobileActive = React.useRef(false);
  const mobile = useIsMobile();
  const [mobileDetail, setMobileDetail] = React.useState(false);
  const openedRevision = React.useRef<number | null>(null);
  const restoreRevision = React.useRef<number | null>(null);
  const focusBackOnMount = React.useRef(false);
  const backNode = React.useRef<HTMLButtonElement | null>(null);
  const listNode = React.useRef<HTMLElement | null>(null);
  const backButtonRef = React.useCallback((node: HTMLButtonElement | null) => {
    if (node === null && document.activeElement === backNode.current) {
      focusBackOnMount.current = true;
      restoreRevision.current = openedRevision.current;
    }
    backNode.current = node;
    if (node !== null && focusBackOnMount.current) {
      focusBackOnMount.current = false;
      restoreRevision.current = null;
      node.focus();
    }
  }, []);
  const listRef = React.useCallback((node: HTMLElement | null) => {
    if (node === null && listNode.current?.contains(document.activeElement)) focusBackOnMount.current = true;
    listNode.current = node;
  }, []);
  React.useEffect(() => {
    if (active && (!wasActive.current || state.listState === "stale")) openHistory();
    wasActive.current = active;
  }, [active, openHistory, state.listState]);
  React.useLayoutEffect(() => {
    if (!active || !wasMobileActive.current) setMobileDetail(false);
    wasMobileActive.current = active;
  }, [active]);
  if (!active) return null;

  const copy = labels(locale);
  const failure = historyFailure(state, locale);
  const listContent = state.listState === "loading"
    ? <p>{copy.historyLoading}</p>
    : state.listState === "failed"
      ? <p role="alert">{failure ?? errorMessage(locale, "UNKNOWN_ERROR")}</p>
      : state.list === null || state.list.revisions.length === 0
        ? <p>{copy.historyEmpty}</p>
        : state.list.revisions.map((revision) => (
          <Button
            key={revision.revision}
            ref={(node) => {
              if (node !== null && restoreRevision.current === revision.revision) {
                restoreRevision.current = null;
                focusBackOnMount.current = false;
                node.focus();
              }
            }}
            type="button"
            variant="outline"
            className="min-h-11 min-w-11 justify-start"
            onClick={() => {
              openedRevision.current = revision.revision;
              if (mobile) focusBackOnMount.current = true;
              setMobileDetail(true);
              selectRevision(revision.revision);
            }}
          >
            {copy.revision} {revision.revision}
          </Button>
        ));
  const showList = !mobile || !mobileDetail;
  const showDetail = !mobile || mobileDetail;
  const returnToList = () => {
    restoreRevision.current = openedRevision.current;
    setMobileDetail(false);
    back();
  };

  return (
    <section aria-label={copy.history} className="min-w-0">
      <div className="grid min-w-0 gap-4 md:grid-cols-[15rem_minmax(0,1fr)]">
        {showList && <nav ref={listRef} data-history-list="true" aria-label={copy.history} className="flex min-w-0 flex-col gap-2">{listContent}</nav>}
        {showDetail && <div className={mobile ? "min-w-0" : "hidden md:block"}><Detail state={state} computeDiff={computeDiff} setDiffMounted={setDiffMounted} fallback={derivedFallback} retryDiff={retryDiff} back={returnToList} backButtonRef={backButtonRef} mobile={mobile} locale={locale} /></div>}
      </div>
    </section>
  );
}
