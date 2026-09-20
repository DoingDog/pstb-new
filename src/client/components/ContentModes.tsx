import * as React from "react";
import { labels, type Locale } from "../../i18n";
import type { TrustedMarkdownHtml } from "../bootstrap";
import type { AutosaveControllerApi } from "../autosave";
import type { SourceEvent } from "../contracts";
import type { MarkdownModesOptions, MarkdownPreview, PreparedMarkdownVisual } from "../markdown";
import type { DerivedSurface } from "../surface-apply";
import { MarkdownWorkbench } from "./MarkdownWorkbench";
import { PlaintextEditor, type EditorWrap } from "./PlaintextEditor";
import { SafeMarkdown } from "./SafeMarkdown";
import { Button } from "./ui/button";

export type ContentMode = "view" | "edit" | "markdown";

function SurfaceLifecycle({ surface, onSurfaceMounted }: { surface: DerivedSurface; onSurfaceMounted?: ((surface: DerivedSurface, mounted: boolean) => void) | undefined }) {
  React.useEffect(() => {
    onSurfaceMounted?.(surface, true);
    return () => onSurfaceMounted?.(surface, false);
  }, [onSurfaceMounted, surface]);
  return null;
}

export interface ContentModesProps {
  mode: ContentMode;
  format: "text" | "markdown";
  source: string;
  displaySource?: string;
  derivedGeneration?: number | undefined;
  derivedPreview?: MarkdownPreview | null;
  derivedVisual?: PreparedMarkdownVisual | null;
  derivedFallback?: { surface: DerivedSurface; source: string; generation: number } | null;
  onRetrySurface?(surface: DerivedSurface): void;
  initialSource?: string;
  initialMarkdown: TrustedMarkdownHtml | null;
  wrap: EditorWrap;
  autosave: Pick<AutosaveControllerApi, "input" | "compositionStart" | "compositionEnd">;
  onSourceEvent(event: SourceEvent): void;
  onSurfaceMounted?(surface: DerivedSurface, mounted: boolean): void;
  locale?: Locale;
  importBrowserMarkdown?: MarkdownModesOptions["loadPreview"];
  loadCrepeStyle?(): Promise<unknown>;
}

export function ContentModes({
  mode,
  format,
  source,
  displaySource = source,
  derivedGeneration,
  derivedPreview = null,
  derivedVisual = null,
  derivedFallback = null,
  onRetrySurface,
  initialSource = source,
  initialMarkdown,
  wrap,
  autosave,
  onSourceEvent,
  onSurfaceMounted,
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
        preparedVisual={derivedVisual}
        preparedPreview={derivedPreview}
        derivedFallback={derivedFallback}
        {...(onRetrySurface === undefined ? {} : { onRetrySurface })}
        {...(onSurfaceMounted === undefined ? {} : { onSurfaceMounted })}
        importBrowserMarkdown={importBrowserMarkdown}
        {...(loadCrepeStyle === undefined ? {} : { loadCrepeStyle })}
      />
    );
  }
  if (format === "markdown") {
    const content = derivedPreview?.source === displaySource
      ? <SafeMarkdown html={derivedPreview.html as TrustedMarkdownHtml} />
      : initialMarkdown !== null && displaySource === initialSource
        ? <SafeMarkdown html={initialMarkdown} />
        : <pre data-plain-view="true" {...(derivedGeneration === undefined ? {} : { "data-derived-generation": String(derivedGeneration) })} className={wrap === "soft" ? "whitespace-pre-wrap break-words" : "overflow-x-auto whitespace-pre"}>{displaySource}</pre>;
    const fallback = derivedFallback?.surface === "preview"
      ? <div data-derived-fallback="preview" data-derived-generation={String(derivedFallback.generation)} className="flex flex-wrap items-center gap-2"><pre className="max-w-full overflow-x-auto whitespace-pre">{displaySource}</pre><Button type="button" variant="outline" onClick={() => onRetrySurface?.("preview")}>{copy.retry}</Button></div>
      : content;
    return <><SurfaceLifecycle surface="preview" onSurfaceMounted={onSurfaceMounted} />{fallback}</>;
  }
  return <pre data-plain-view="true" {...(derivedGeneration === undefined ? {} : { "data-derived-generation": String(derivedGeneration) })} className={wrap === "soft" ? "whitespace-pre-wrap break-words" : "overflow-x-auto whitespace-pre"}>{displaySource}</pre>;
}
