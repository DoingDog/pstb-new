import * as React from "react";
import { errorMessage, labels, type Locale } from "../../i18n";
import type { TrustedMarkdownHtml } from "../bootstrap";
import type { MarkdownPreview } from "../markdown";
import type { DerivedSurface } from "../surface-apply";
import { useStoredWrap } from "../preferences";
import { LocalActions, type ClipboardPort, type DownloadPort, type LocalActionState, type NavigationPort } from "../components/LocalActions";
import { SafeMarkdown } from "../components/SafeMarkdown";
import { useOverflowFocus } from "../components/useOverflowFocus";
import { Button } from "@/components/ui/button";

export interface LocalOnlyPastePageProps {
  locale: Locale;
  phase: "armed-view-once" | "consumed" | "not-found" | "delete-uncertain";
  source: string;
  consumedSource?: string | null;
  initialMarkdown: TrustedMarkdownHtml | null;
  derivedPreview?: MarkdownPreview | null;
  fallback?: { surface: DerivedSurface; source: string; generation: number } | null;
  onUseConsumedResponse?(): void;
  onSurfaceMounted?(host: HTMLDivElement | null): void;
  onRetrySurface?(surface: DerivedSurface): void;
  onKeepCurrent?(): void;
  clipboard?: ClipboardPort;
  download?: DownloadPort;
  navigation?: NavigationPort;
  onActionState?(state: LocalActionState): void;
}

function phaseLabel(locale: Locale, phase: LocalOnlyPastePageProps["phase"]): string {
  const copy = labels(locale);
  switch (phase) {
    case "armed-view-once": return copy.armedViewOnce;
    case "consumed": return copy.consumed;
    case "not-found": return copy.notFound;
    case "delete-uncertain": return copy.deleteUncertain;
  }
}

export function LocalOnlyPastePage({ locale, phase, source, consumedSource = null, initialMarkdown, derivedPreview = null, fallback = null, onUseConsumedResponse, onKeepCurrent, onSurfaceMounted, onRetrySurface, clipboard, download, navigation, onActionState }: LocalOnlyPastePageProps) {
  const copy = labels(locale);
  const canChooseConsumedSource = phase === "consumed" && consumedSource !== null && consumedSource !== source;
  const [wrap, setWrap] = useStoredWrap();
  const previewOverflow = useOverflowFocus(!wrap, source);
  const fallbackOverflow = useOverflowFocus(!wrap, source);
  const [sourceVisible, setSourceVisible] = React.useState(false);
  const [preview, setPreview] = React.useState<TrustedMarkdownHtml | null>(initialMarkdown);
  const [previewFailure, setPreviewFailure] = React.useState<string | null>(null);
  const previewHost = React.useRef<HTMLDivElement>(null);
  const mounted = React.useRef(true);
  const generation = React.useRef(0);
  const currentSource = React.useRef(source);
  const currentInitialPreview = React.useRef(initialMarkdown);

  React.useEffect(() => {
    const host = previewHost.current;
    if (host === null) return;
    onSurfaceMounted?.(host);
    return () => onSurfaceMounted?.(null);
  }, [onSurfaceMounted]);

  React.useEffect(() => () => {
    mounted.current = false;
    generation.current += 1;
  }, []);

  React.useLayoutEffect(() => {
    currentSource.current = source;
    currentInitialPreview.current = initialMarkdown;
    generation.current += 1;
    setPreview(initialMarkdown);
    setPreviewFailure(null);
    setSourceVisible(false);
  }, [initialMarkdown, source]);

  const recomputePreview = async () => {
    const attempt = ++generation.current;
    const sourceIdentity = source;
    const initialPreviewIdentity = initialMarkdown;
    const isCurrent = () =>
      mounted.current
      && attempt === generation.current
      && currentSource.current === sourceIdentity
      && currentInitialPreview.current === initialPreviewIdentity;
    let destroy: (() => Promise<void>) | undefined;

    try {
      const { createMarkdownModes } = await import("../markdown");
      if (!isCurrent()) return;
      const sourceAdapter = { value: sourceIdentity } as Pick<HTMLTextAreaElement, "value">;
      const detachedHost = document.createElement("div");
      const modes = createMarkdownModes({
        source: sourceAdapter,
        visualRoot: detachedHost,
        onDocumentChange: () => undefined,
        onPreview: ({ html }) => {
          if (isCurrent()) {
            setPreview(html as TrustedMarkdownHtml);
            setPreviewFailure(null);
          }
        },
      });
      destroy = modes.destroy;
      await modes.enterPreview();
    } catch {
      if (isCurrent()) setPreviewFailure(errorMessage(locale, "RENDER_FAILED"));
    } finally {
      if (destroy !== undefined) await destroy();
    }
  };

  const displayedPreview = (derivedPreview?.source === source ? derivedPreview.html as TrustedMarkdownHtml : undefined) ?? preview;
  const previewNode = displayedPreview === null
    ? <pre ref={previewOverflow.ref} data-local-view="true" className={wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre"} tabIndex={previewOverflow.tabIndex}>{source}</pre>
    : <SafeMarkdown html={displayedPreview} wrap={wrap} />;

  return (
    <section className="flex min-w-0 flex-col gap-4" aria-label={phaseLabel(locale, phase)}>
      {phase === "delete-uncertain"
        ? <p role="alert">{phaseLabel(locale, phase)}</p>
        : <p>{phaseLabel(locale, phase)}</p>}
      {canChooseConsumedSource && <div className="flex flex-wrap gap-2"><Button type="button" className="min-h-11 min-w-11" onClick={onUseConsumedResponse}>{copy.useRemote}</Button><Button type="button" variant="outline" className="min-h-11 min-w-11" onClick={onKeepCurrent}>{copy.keepCurrent}</Button></div>}
      {previewFailure !== null && <p role="alert">{previewFailure}</p>}
      <div ref={previewHost} data-terminal-preview-host="true">
        {fallback?.surface === "preview" && fallback.source === source && <div data-derived-fallback="preview" data-derived-generation={String(fallback.generation)} className="flex flex-wrap items-center gap-2"><pre ref={fallbackOverflow.ref} className={wrap ? "max-w-full whitespace-pre-wrap break-words" : "max-w-full whitespace-pre"} tabIndex={fallbackOverflow.tabIndex}>{source}</pre><Button type="button" variant="outline" className="min-h-11 min-w-11" onClick={() => onRetrySurface?.("preview")}>{copy.retry}</Button></div>}
        <LocalActions
          actionScope={`local:${phase}:${source}`}
          source={source}
          locale={locale}
          filename={preview === null ? "paste.txt" : "paste.md"}
          capabilities={{
            copy: true,
            download: true,
            html: "blob",
            wrap: { value: wrap, onChange: setWrap },
            sourcePreview: { sourceVisible, onSourceVisibleChange: setSourceVisible, preview: previewNode },
          }}
          {...(clipboard === undefined ? {} : { clipboard })}
          {...(download === undefined ? {} : { download })}
          {...(navigation === undefined ? {} : { navigation })}
          {...(onActionState === undefined ? {} : { onActionState })}
        />
      </div>
      {initialMarkdown !== null && <Button type="button" variant="outline" data-action="recompute-preview" className="min-h-11 self-start" onClick={() => void recomputePreview()}>{copy.preview}</Button>}
      <div className="flex flex-wrap gap-3">
        {(phase === "not-found" || phase === "delete-uncertain") && <a data-action="full-refresh" href={location.href} className="inline-flex min-h-11 min-w-11 items-center text-primary underline-offset-4 hover:underline">{copy.fullRefresh}</a>}
        <a data-action="create-new" href="/" className="inline-flex min-h-11 min-w-11 items-center text-primary underline-offset-4 hover:underline">{copy.createNew}</a>
      </div>
    </section>
  );
}
