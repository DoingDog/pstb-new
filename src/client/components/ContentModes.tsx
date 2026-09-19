import * as React from "react";
import { labels, type Locale } from "../../i18n";
import type { TrustedMarkdownHtml } from "../bootstrap";
import type { AutosaveControllerApi } from "../autosave";
import type { SourceEvent } from "../contracts";
import type { MarkdownModesOptions } from "../markdown";
import { MarkdownWorkbench } from "./MarkdownWorkbench";
import { PlaintextEditor, type EditorWrap } from "./PlaintextEditor";
import { SafeMarkdown } from "./SafeMarkdown";

export type ContentMode = "view" | "edit" | "markdown";

export interface ContentModesProps {
  mode: ContentMode;
  format: "text" | "markdown";
  source: string;
  initialSource?: string;
  initialMarkdown: TrustedMarkdownHtml | null;
  wrap: EditorWrap;
  autosave: Pick<AutosaveControllerApi, "input" | "compositionStart" | "compositionEnd">;
  onSourceEvent(event: SourceEvent): void;
  locale?: Locale;
  importBrowserMarkdown?: MarkdownModesOptions["loadPreview"];
  loadCrepeStyle?(): Promise<unknown>;
}

export function ContentModes({
  mode,
  format,
  source,
  initialSource = source,
  initialMarkdown,
  wrap,
  autosave,
  onSourceEvent,
  locale = "en",
  importBrowserMarkdown,
  loadCrepeStyle,
}: ContentModesProps) {
  const copy = labels(locale);
  if (mode === "edit") {
    return <PlaintextEditor value={source} wrap={wrap} autosave={autosave} onSourceEvent={onSourceEvent} label={copy.content} />;
  }
  if (mode === "markdown") {
    return (
      <MarkdownWorkbench
        source={source}
        initialSource={initialSource}
        initialMarkdown={initialMarkdown}
        wrap={wrap}
        autosave={autosave}
        onSourceEvent={onSourceEvent}
        locale={locale}
        importBrowserMarkdown={importBrowserMarkdown}
        {...(loadCrepeStyle === undefined ? {} : { loadCrepeStyle })}
      />
    );
  }
  if (format === "markdown" && initialMarkdown !== null && source === initialSource) {
    return <SafeMarkdown html={initialMarkdown} />;
  }
  return <pre data-plain-view="true" className={wrap === "soft" ? "whitespace-pre-wrap break-words" : "overflow-x-auto whitespace-pre"}>{source}</pre>;
}
