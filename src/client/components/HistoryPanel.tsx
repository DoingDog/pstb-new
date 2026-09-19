import * as React from "react";
import { dictionaries, errorMessage, labels, type Locale } from "../../i18n";
import type { HistoryControllerSnapshot } from "../history";
import { formatHistoryDiffLine } from "../history";
import type { DiffLine } from "../diff";
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
  back(): void;
  locale?: Locale;
}

function historyFailure(state: HistoryPanelState, locale: Locale): string | null {
  return state.failure === null ? null : errorMessage(locale, state.failure.value.code);
}

function Detail({ state, computeDiff, back, mobile, locale }: { state: HistoryPanelState; computeDiff(): void; back(): void; mobile: boolean; locale: Locale }) {
  const copy = labels(locale);
  const failure = historyFailure(state, locale);
  const backButton = mobile && <Button type="button" variant="outline" onClick={back}>{copy.back}</Button>;
  if (state.snapshotState === "loading") return <section data-history-detail="true" aria-label={copy.selectedRevision}>{backButton}<p role="status">{dictionaries[locale].actions["history-snapshot"].pending}</p></section>;
  if (state.snapshotState === "failed") return <section data-history-detail="true" aria-label={copy.selectedRevision}>{backButton}<p role="alert">{failure ?? errorMessage(locale, "UNKNOWN_ERROR")}</p></section>;
  if (state.selected === null) return mobile ? null : <section data-history-detail="true" aria-label={copy.selectedRevision}><p>{copy.selectedRevision}</p></section>;

  return (
    <section data-history-detail="true" aria-label={copy.selectedRevision} className="min-w-0">
      {backButton}
      <h2 className="mt-2 text-base font-medium">{copy.revision} {state.selected.revision}</h2>
      <Tabs defaultValue="diff">
        <TabsList>
          <TabsTrigger value="diff">{copy.unifiedDiff}</TabsTrigger>
          <TabsTrigger value="snapshot">{copy.fullSnapshot}</TabsTrigger>
        </TabsList>
        <TabsContent value="diff">
          {state.diff.state === "manual" && <div className="flex items-center gap-1"><Button type="button" onClick={computeDiff}>{copy.computeDiff}</Button><HelpTrigger label={copy.help} content={dictionaries[locale].help.largeDiff} descriptionId="history-large-diff-help" /></div>}
          {state.diff.state === "computing" && <p role="status">{copy.computeDiff}</p>}
          {state.diff.state === "failed" && <p role="alert">{state.diff.error ?? errorMessage(locale, "UNKNOWN_ERROR")}</p>}
          {state.diff.state === "ready" && <pre aria-label={copy.selectedRevision} className="overflow-auto whitespace-pre-wrap">{state.diff.lines.map((line, index) => <React.Fragment key={index}>{formatHistoryDiffLine(line)}</React.Fragment>)}</pre>}
        </TabsContent>
        <TabsContent value="snapshot"><pre className="overflow-auto whitespace-pre-wrap">{state.selected.content}</pre></TabsContent>
      </Tabs>
    </section>
  );
}

export function HistoryPanel({ active, state, openHistory, selectRevision, computeDiff, back, locale = "en" }: HistoryPanelProps) {
  const wasActive = React.useRef(false);
  const mobile = useIsMobile();
  const [mobileDetail, setMobileDetail] = React.useState(() => state.selected !== null || state.snapshotState !== "idle");
  const wasDetail = React.useRef(state.selected !== null || state.snapshotState !== "idle");
  React.useEffect(() => {
    if (active && !wasActive.current) openHistory();
    wasActive.current = active;
  }, [active, openHistory]);
  React.useLayoutEffect(() => {
    const detail = state.selected !== null || state.snapshotState !== "idle";
    if (detail && !wasDetail.current) setMobileDetail(true);
    wasDetail.current = detail;
  }, [state.selected, state.snapshotState]);
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
        {showDetail && <div className={mobile ? undefined : "hidden md:block"}><Detail state={state} computeDiff={computeDiff} back={returnToList} mobile={mobile} locale={locale} /></div>}
      </div>
    </section>
  );
}
