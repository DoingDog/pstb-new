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

function Detail({ state, computeDiff, setDiffMounted, fallback, retryDiff, back, mobile, locale }: { state: HistoryPanelState; computeDiff(): void; setDiffMounted(mounted: boolean): void; fallback: HistoryPanelProps["derivedFallback"]; retryDiff: HistoryPanelProps["retryDiff"]; back(): void; mobile: boolean; locale: Locale }) {
  const copy = labels(locale);
  const failure = historyFailure(state, locale);
  const backButton = mobile && <Button type="button" variant="outline" onClick={back}>{copy.back}</Button>;
  if (state.snapshotState === "loading") return <section data-history-detail="true" aria-label={copy.selectedRevision}>{backButton}<p role="status">{dictionaries[locale].actions["history-snapshot"].pending}</p></section>;
  if (state.snapshotState === "failed") return <section data-history-detail="true" aria-label={copy.selectedRevision}>{backButton}<p role="alert">{failure ?? errorMessage(locale, "UNKNOWN_ERROR")}</p></section>;
  if (state.selected === null) return mobile ? null : <section data-history-detail="true" aria-label={copy.selectedRevision}><p>{copy.selectedRevision}</p></section>;

  return <DetailTabs state={state} computeDiff={computeDiff} setDiffMounted={setDiffMounted} fallback={fallback} retryDiff={retryDiff} backButton={backButton} locale={locale} />;
}

function DetailTabs({ state, computeDiff, setDiffMounted, fallback, retryDiff, backButton, locale }: { state: HistoryPanelState; computeDiff(): void; setDiffMounted(mounted: boolean): void; fallback: HistoryPanelProps["derivedFallback"]; retryDiff: HistoryPanelProps["retryDiff"]; backButton: React.ReactNode; locale: Locale }) {
  const copy = labels(locale);
  const [tab, setTab] = React.useState("diff");
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
          {state.diff.state === "manual" && <div className="flex items-center gap-1"><Button type="button" onClick={computeDiff}>{copy.computeDiff}</Button><HelpTrigger label={copy.help} content={dictionaries[locale].help.largeDiff} descriptionId="history-large-diff-help" /></div>}
          {state.diff.state === "computing" && <p role="status">{copy.computeDiff}</p>}
          {state.diff.state === "failed" && <p role="alert">{state.diff.error ?? errorMessage(locale, "UNKNOWN_ERROR")}</p>}
          {fallback?.surface === "diff" && <div data-derived-fallback="diff" data-derived-generation={String(fallback.generation)}><Button type="button" variant="outline" onClick={retryDiff}>{copy.retry}</Button></div>}
          {state.diff.state === "ready" && <pre aria-label={copy.selectedRevision} className="overflow-auto whitespace-pre-wrap">{state.diff.lines.map((line, index) => <React.Fragment key={index}>{formatHistoryDiffLine(line)}</React.Fragment>)}</pre>}
        </TabsContent>
        <TabsContent value="snapshot"><pre className="overflow-auto whitespace-pre-wrap">{state.selected!.content}</pre></TabsContent>
      </Tabs>
    </section>
  );
}

export function HistoryPanel({ active, state, openHistory, selectRevision, computeDiff, setDiffMounted = noDiffMountChange, derivedFallback = null, retryDiff, back, locale = "en" }: HistoryPanelProps) {
  const wasActive = React.useRef(false);
  const wasMobileActive = React.useRef(false);
  const mobile = useIsMobile();
  const [mobileDetail, setMobileDetail] = React.useState(false);
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
    ? <p role="status">{copy.historyLoading}</p>
    : state.listState === "failed"
      ? <p role="alert">{failure ?? errorMessage(locale, "UNKNOWN_ERROR")}</p>
      : state.list === null || state.list.revisions.length === 0
        ? <p>{copy.historyEmpty}</p>
        : state.list.revisions.map((revision) => (
          <Button key={revision.revision} type="button" variant="outline" className="justify-start" onClick={() => { setMobileDetail(true); selectRevision(revision.revision); }}>
            {copy.revision} {revision.revision}
          </Button>
        ));
  const showList = !mobile || !mobileDetail;
  const showDetail = !mobile || mobileDetail;
  const returnToList = () => {
    setMobileDetail(false);
    back();
  };

  return (
    <section aria-label={copy.history} className="min-w-0">
      <div className="grid min-w-0 gap-4 md:grid-cols-[15rem_minmax(0,1fr)]">
        {showList && <nav data-history-list="true" aria-label={copy.history} className="flex min-w-0 flex-col gap-2">{listContent}</nav>}
        {showDetail && <div className={mobile ? undefined : "hidden md:block"}><Detail state={state} computeDiff={computeDiff} setDiffMounted={setDiffMounted} fallback={derivedFallback} retryDiff={retryDiff} back={returnToList} mobile={mobile} locale={locale} /></div>}
      </div>
    </section>
  );
}
