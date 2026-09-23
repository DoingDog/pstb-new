import * as React from "react";
import { labels, type Locale } from "../../i18n";
import type { TrustedMarkdownHtml } from "../bootstrap";
import type { AutosaveControllerApi } from "../autosave";
import type { SourceEvent } from "../contracts";
import type { MarkdownMode, MarkdownModesOptions, MarkdownPreview, PreparedMarkdownVisual } from "../markdown";
import type { DerivedSurface } from "../surface-apply";
import { MarkdownWorkbench } from "./MarkdownWorkbench";
import { PlaintextEditor, type EditorWrap } from "./PlaintextEditor";
import { SafeMarkdown } from "./SafeMarkdown";
import { useOverflowFocus } from "./useOverflowFocus";
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
  initialMarkdownMode?: MarkdownMode;
  onMarkdownModeChange?(mode: MarkdownMode): void;
  wrap: EditorWrap;
  autosave: Pick<AutosaveControllerApi, "input" | "compositionStart" | "compositionEnd">;
  onSourceEvent(event: SourceEvent): void;
  readSourceState?(): { source: string; revision: number; compositionId: number };
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
  initialMarkdownMode,
  onMarkdownModeChange,
  wrap,
  autosave,
  onSourceEvent,
  readSourceState,
  onSurfaceMounted,
  locale = "en",
  importBrowserMarkdown,
  loadCrepeStyle,
}: ContentModesProps) {
  const copy = labels(locale);
  const overflow = useOverflowFocus(wrap !== "soft", displaySource);
  if (mode === "edit") {
    return <PlaintextEditor value={source} wrap={wrap} autosave={autosave} onSourceEvent={onSourceEvent} label={copy.content} />;
  }
  if (mode === "markdown") {
    return (
      <MarkdownWorkbench
        source={source}
        initialSource={initialSource}
        initialMarkdown={initialMarkdown}
        {...(initialMarkdownMode === undefined ? {} : { initialMode: initialMarkdownMode })}
        {...(onMarkdownModeChange === undefined ? {} : { onModeSelected: onMarkdownModeChange })}
        wrap={wrap}
        autosave={autosave}
        onSourceEvent={onSourceEvent}
        {...(readSourceState === undefined ? {} : { readSourceState })}
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
      ? <SafeMarkdown html={derivedPreview.html as TrustedMarkdownHtml} wrap={wrap === "soft"} />
      : initialMarkdown !== null && displaySource === initialSource
        ? <SafeMarkdown html={initialMarkdown} wrap={wrap === "soft"} />
        : <pre ref={overflow.ref} data-plain-view="true" {...(derivedGeneration === undefined ? {} : { "data-derived-generation": String(derivedGeneration) })} className={wrap === "soft" ? "whitespace-pre-wrap break-words" : "whitespace-pre"} tabIndex={overflow.tabIndex}>{displaySource}</pre>;
    const fallback = derivedFallback?.surface === "preview"
      ? <div data-derived-fallback="preview" data-derived-generation={String(derivedFallback.generation)} className="flex flex-wrap items-center gap-2"><pre ref={overflow.ref} className={wrap === "soft" ? "max-w-full whitespace-pre-wrap break-words" : "max-w-full whitespace-pre"} tabIndex={overflow.tabIndex}>{displaySource}</pre><Button type="button" variant="outline" className="min-h-11 min-w-11" onClick={() => onRetrySurface?.("preview")}>{copy.retry}</Button></div>
      : content;
    return <><SurfaceLifecycle surface="preview" onSurfaceMounted={onSurfaceMounted} />{fallback}</>;
  }
  return <pre ref={overflow.ref} data-plain-view="true" {...(derivedGeneration === undefined ? {} : { "data-derived-generation": String(derivedGeneration) })} className={wrap === "soft" ? "whitespace-pre-wrap break-words" : "whitespace-pre"} tabIndex={overflow.tabIndex}>{displaySource}</pre>;
}
