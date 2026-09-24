import * as React from "react";
import { labels, type Locale } from "../../i18n";
import { withPastePassword, type TrustedMarkdownHtml } from "../bootstrap";
import type { AutosaveControllerApi, AutosaveState } from "../autosave";
import type { SourceEvent } from "../contracts";
import type { MarkdownMode, MarkdownModesOptions, MarkdownPreview, PreparedMarkdownVisual } from "../markdown";
import type { DerivedSurface } from "../surface-apply";
import type { PasteLinks } from "../../types";
import { ContentModes, type ContentMode } from "./ContentModes";
import { LocalActions, type LocalActionState } from "./LocalActions";
import { Button } from "./ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";

export interface OrdinaryPastePageProps {
  pasteIdentity: string;
  format: "text" | "markdown";
  source: string;
  derivedSource?: string;
  derivedGeneration?: number | undefined;
  derivedPreview?: MarkdownPreview | null;
  derivedVisual?: PreparedMarkdownVisual | null;
  derivedFallback?: { surface: DerivedSurface; source: string; generation: number } | null;
  onRetrySurface?(surface: DerivedSurface): void;
  acceptedSource: string;
  version: string;
  autosaveAcceptedSource: string;
  lastSavedContent: string;
  autosaveState: AutosaveState;
  initialMarkdown: TrustedMarkdownHtml | null;
  links: PasteLinks;
  password: string | null;
  locale: Locale;
  autosave: Pick<AutosaveControllerApi, "input" | "compositionStart" | "compositionEnd">;
  onSourceEvent(event: SourceEvent): void;
  onSurfaceMounted?(surface: DerivedSurface, mounted: boolean): void;
  historyPanel: React.ReactNode;
  settingsPanel: React.ReactNode;
  passwordPanel: React.ReactNode;
  deleteFlow: React.ReactNode;
  filename?: string;
  onActionState?(state: LocalActionState): void;
  importBrowserMarkdown?: MarkdownModesOptions["loadPreview"];
  loadCrepeStyle?(): Promise<unknown>;
}

type PasteTab = ContentMode | "history" | "settings";

function storedTab<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return allowed.find((tab) => tab === value) ?? fallback;
  } catch {
    return fallback;
  }
}

function saveTab(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 无痕模式或禁用存储时，仍允许切换 tab。
  }
}

function representationHref(href: string, password: string | null): string {
  const base = typeof location === "undefined" ? "http://localhost/" : location.href;
  return withPastePassword(new URL(href, base), password).toString();
}

export function OrdinaryPastePage(props: OrdinaryPastePageProps) {
  return <OrdinaryPastePageBody key={props.pasteIdentity} {...props} />;
}

function OrdinaryPastePageBody({
  pasteIdentity,
  format,
  source,
  derivedSource = source,
  derivedGeneration,
  derivedPreview = null,
  derivedVisual = null,
  derivedFallback = null,
  onRetrySurface,
  initialMarkdown,
  links,
  password,
  locale,
  autosave,
  onSourceEvent,
  onSurfaceMounted,
  historyPanel,
  settingsPanel,
  passwordPanel,
  deleteFlow,
  filename = `${pasteIdentity}.txt`,
  onActionState,
  importBrowserMarkdown,
  loadCrepeStyle,
}: OrdinaryPastePageProps) {
  const copy = labels(locale);
  const [initialSource] = React.useState(source);
  const tabKey = `cf-pastebin:tab:${pasteIdentity}`;
  const markdownTabKey = `cf-pastebin:markdown-tab:${pasteIdentity}`;
  const [active, setActive] = React.useState<PasteTab>(() => storedTab(tabKey, ["view", "edit", "markdown", "history", "settings"], "view"));
  const [initialMarkdownMode] = React.useState<MarkdownMode>(() => storedTab(markdownTabKey, ["source", "visual", "preview"], "source"));
  const [wrap, setWrap] = React.useState(false);
  const selectTab = (value: string) => {
    const next = value as PasteTab;
    setActive(next);
    saveTab(tabKey, next);
  };
  const sourceState = React.useRef({ source, revision: 0, compositionId: 0 });
  const lastPropSource = React.useRef(source);
  if (lastPropSource.current !== source) {
    lastPropSource.current = source;
    sourceState.current = { ...sourceState.current, source, revision: sourceState.current.revision + 1 };
  }
  const reportSourceEvent = React.useCallback((event: SourceEvent) => {
    sourceState.current = {
      source: event.content,
      revision: sourceState.current.revision + 1,
      compositionId: sourceState.current.compositionId + (event.type === "composition-start" ? 1 : 0),
    };
    onSourceEvent(event);
  }, [onSourceEvent]);
  const readSourceState = React.useCallback(() => sourceState.current, []);
  const contentProps = {
    format,
    source,
    displaySource: derivedSource,
    derivedGeneration,
    derivedPreview,
    derivedVisual,
    derivedFallback,
    ...(onRetrySurface === undefined ? {} : { onRetrySurface }),
    initialSource,
    initialMarkdown,
    initialMarkdownMode,
    onMarkdownModeChange: (mode: MarkdownMode) => saveTab(markdownTabKey, mode),
    wrap: wrap ? "soft" as const : "off" as const,
    autosave,
    onSourceEvent: reportSourceEvent,
    readSourceState,
    locale,
    ...(onSurfaceMounted === undefined ? {} : { onSurfaceMounted }),
    importBrowserMarkdown,
    ...(loadCrepeStyle === undefined ? {} : { loadCrepeStyle }),
  };

  return (
    <section data-ordinary-paste-page="true" className="flex min-w-0 flex-col gap-4">
      <Tabs value={active} onValueChange={selectTab} activationMode="automatic">
        <TabsList variant="line" aria-label={copy.pasteViews} className="justify-start [&_[data-slot=tabs-trigger]]:flex-none">
          <TabsTrigger value="view">{copy.view}</TabsTrigger>
          <TabsTrigger value="edit">{copy.edit}</TabsTrigger>
          <TabsTrigger value="markdown">{copy.markdown}</TabsTrigger>
          <TabsTrigger value="history">{copy.history}</TabsTrigger>
          <TabsTrigger value="settings">{copy.settings}</TabsTrigger>
        </TabsList>
        <TabsContent value="view" className="min-h-[6lh]"><ContentModes mode="view" {...contentProps} /></TabsContent>
        <TabsContent value="edit"><ContentModes mode="edit" {...contentProps} /></TabsContent>
        <TabsContent value="markdown"><ContentModes mode="markdown" {...contentProps} /></TabsContent>
        <TabsContent value="history">{historyPanel}</TabsContent>
        <TabsContent value="settings" forceMount hidden={active !== "settings"}>{settingsPanel}{active === "settings" && <>{passwordPanel}{deleteFlow}</>}</TabsContent>
      </Tabs>
      <div data-ordinary-actions className="flex min-w-0 flex-nowrap items-start gap-2 overflow-x-auto md:ml-7 [&>*]:shrink-0">
        <LocalActions
          actionScope={pasteIdentity}
          source={source}
          locale={locale}
          filename={filename}
          capabilities={{ copy: true, download: true, wrap: { value: wrap, onChange: setWrap } }}
          {...(onActionState === undefined ? {} : { onActionState })}
        />
        <nav aria-label={copy.representations} className="flex gap-2">
          <Button asChild variant="outline" className="min-h-11"><a href={representationHref(links.raw, password)}>{copy.raw}</a></Button>
          <Button asChild variant="outline" className="min-h-11"><a href={representationHref(links.html, password)}>{copy.html}</a></Button>
          <Button asChild variant="outline" className="min-h-11"><a href={representationHref(links.markdown, password)}>{copy.markdown}</a></Button>
          <Button asChild variant="outline" className="min-h-11"><a href={representationHref(links.file, password)}>{copy.file}</a></Button>
        </nav>
      </div>
    </section>
  );
}
