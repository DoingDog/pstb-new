import * as React from "react";
import { labels, type Locale } from "../../i18n";
import { withPastePassword, type TrustedMarkdownHtml } from "../bootstrap";
import type { AutosaveControllerApi, AutosaveState } from "../autosave";
import type { SourceEvent } from "../contracts";
import type { MarkdownModesOptions } from "../markdown";
import type { PasteLinks } from "../../types";
import { ContentModes, type ContentMode } from "./ContentModes";
import { LocalActions, type LocalActionState } from "./LocalActions";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";

export interface OrdinaryPastePageProps {
  pasteIdentity: string;
  format: "text" | "markdown";
  source: string;
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
  historyPanel: React.ReactNode;
  settingsPanel: React.ReactNode;
  passwordPanel: React.ReactNode;
  deleteFlow: React.ReactNode;
  filename?: string;
  onActionState?(state: LocalActionState): void;
  importBrowserMarkdown?: MarkdownModesOptions["loadPreview"];
  loadCrepeStyle?(): Promise<unknown>;
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
  acceptedSource,
  initialMarkdown,
  links,
  password,
  locale,
  autosave,
  onSourceEvent,
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
  const [active, setActive] = React.useState<ContentMode | "history" | "settings">("view");
  const [wrap, setWrap] = React.useState(false);
  const contentProps = {
    format,
    source,
    acceptedSource,
    initialMarkdown,
    wrap: wrap ? "soft" as const : "off" as const,
    autosave,
    onSourceEvent,
    locale,
    importBrowserMarkdown,
    ...(loadCrepeStyle === undefined ? {} : { loadCrepeStyle }),
  };

  return (
    <section data-ordinary-paste-page="true" className="flex min-w-0 flex-col gap-4">
      <Tabs value={active} onValueChange={(value) => setActive(value as ContentMode | "history" | "settings")} activationMode="automatic">
        <TabsList variant="line" aria-label={copy.pasteViews}>
          <TabsTrigger value="view">{copy.view}</TabsTrigger>
          <TabsTrigger value="edit">{copy.edit}</TabsTrigger>
          <TabsTrigger value="markdown">{copy.markdown}</TabsTrigger>
          <TabsTrigger value="history">{copy.history}</TabsTrigger>
          <TabsTrigger value="settings">{copy.settings}</TabsTrigger>
        </TabsList>
        <TabsContent value="view"><ContentModes mode="view" {...contentProps} /></TabsContent>
        <TabsContent value="edit"><ContentModes mode="edit" {...contentProps} /></TabsContent>
        <TabsContent value="markdown"><ContentModes mode="markdown" {...contentProps} /></TabsContent>
        <TabsContent value="history">{historyPanel}</TabsContent>
        <TabsContent value="settings">{settingsPanel}{passwordPanel}{deleteFlow}</TabsContent>
      </Tabs>
      <LocalActions
        actionScope={pasteIdentity}
        source={source}
        locale={locale}
        filename={filename}
        capabilities={{ copy: true, download: true, wrap: { value: wrap, onChange: setWrap } }}
        {...(onActionState === undefined ? {} : { onActionState })}
      />
      <nav aria-label={copy.representations} className="flex flex-wrap gap-3">
        <a href={representationHref(links.raw, password)}>{copy.raw}</a>
        <a href={representationHref(links.html, password)}>{copy.html}</a>
        <a href={representationHref(links.markdown, password)}>{copy.markdown}</a>
        <a href={representationHref(links.file, password)}>{copy.file}</a>
      </nav>
    </section>
  );
}
