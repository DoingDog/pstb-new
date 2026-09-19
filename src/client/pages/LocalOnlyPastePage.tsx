import * as React from "react";
import { labels, type Locale } from "../../i18n";
import type { TrustedMarkdownHtml } from "../bootstrap";
import { LocalActions, type ClipboardPort, type DownloadPort, type NavigationPort } from "../components/LocalActions";
import { SafeMarkdown } from "../components/SafeMarkdown";
import { Button } from "@/components/ui/button";

export interface LocalOnlyPastePageProps {
  locale: Locale;
  phase: "armed-view-once" | "consumed" | "not-found" | "delete-uncertain";
  source: string;
  initialMarkdown: TrustedMarkdownHtml | null;
  clipboard?: ClipboardPort;
  download?: DownloadPort;
  navigation?: NavigationPort;
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

export function LocalOnlyPastePage({ locale, phase, source, initialMarkdown, clipboard, download, navigation }: LocalOnlyPastePageProps) {
  const copy = labels(locale);
  const [wrap, setWrap] = React.useState(false);
  const [sourceVisible, setSourceVisible] = React.useState(false);
  const [preview, setPreview] = React.useState<TrustedMarkdownHtml | null>(initialMarkdown);

  React.useEffect(() => {
    setPreview(initialMarkdown);
    setSourceVisible(false);
  }, [initialMarkdown, source]);

  const recomputePreview = async () => {
    const { createMarkdownModes } = await import("../markdown");
    const sourceAdapter = { value: source } as Pick<HTMLTextAreaElement, "value">;
    const detachedHost = document.createElement("div");
    const modes = createMarkdownModes({
      source: sourceAdapter,
      visualRoot: detachedHost,
      onDocumentChange: () => undefined,
      onPreview: ({ html }) => setPreview(html as TrustedMarkdownHtml),
    });
    try {
      await modes.enterPreview();
    } finally {
      await modes.destroy();
    }
  };

  const previewNode = preview === null
    ? <pre data-local-view="true" className={wrap ? "whitespace-pre-wrap break-words" : "overflow-x-auto whitespace-pre"}>{source}</pre>
    : <div className={wrap ? "break-words" : "overflow-x-auto"}><SafeMarkdown html={preview} /></div>;

  return (
    <section className="flex min-w-0 flex-col gap-4" aria-label={phaseLabel(locale, phase)}>
      {phase === "delete-uncertain"
        ? <p role="alert">{phaseLabel(locale, phase)}</p>
        : <p>{phaseLabel(locale, phase)}</p>}
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
      />
      {initialMarkdown !== null && <Button type="button" variant="outline" data-action="recompute-preview" className="min-h-11 self-start" onClick={() => void recomputePreview()}>{copy.preview}</Button>}
      <div className="flex flex-wrap gap-3">
        <a data-action="full-refresh" href={location.href} className="text-primary underline-offset-4 hover:underline">{copy.fullRefresh}</a>
        <a data-action="create-new" href="/" className="text-primary underline-offset-4 hover:underline">{copy.createNew}</a>
      </div>
    </section>
  );
}
