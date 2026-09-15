import * as React from "react";
import { dictionaries, labels, type Locale } from "../../i18n";
import { Button } from "@/components/ui/button";

export interface ClipboardPort {
  writeText(value: string): Promise<void>;
}

export interface DownloadPort {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
  dispatchDownload(url: string, filename: string): void;
}

export interface NavigationPort {
  assign(url: string): void;
}

export interface LocalActionState {
  key: "copy" | "download";
  state: "pending" | "succeeded" | "failed";
  startedAt: string;
  settledAt?: string;
}

export interface LocalActionsProps {
  source: string;
  locale: Locale;
  filename: string;
  clipboard?: ClipboardPort;
  download?: DownloadPort;
  navigation?: NavigationPort;
  representationHref?: string;
  representationLabel?: string;
  onActionState?(state: LocalActionState): void;
}

const browserDownload: DownloadPort = {
  createObjectURL: (blob) => URL.createObjectURL(blob),
  revokeObjectURL: (url) => URL.revokeObjectURL(url),
  dispatchDownload: (url, filename) => {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
  },
};

const browserNavigation: NavigationPort = {
  assign: (url) => location.assign(url),
};

function fallbackCopy(source: string): void {
  const textarea = document.createElement("textarea");
  textarea.value = source;
  textarea.setAttribute("aria-hidden", "true");
  textarea.tabIndex = -1;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  (document.body as unknown as { appendChild(child: HTMLTextAreaElement): void }).appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("copy failed");
}

async function copySource(source: string, clipboard: ClipboardPort | undefined): Promise<void> {
  try {
    const port = clipboard ?? navigator.clipboard;
    if (port === undefined || typeof port.writeText !== "function") throw new Error("clipboard unavailable");
    await port.writeText(source);
  } catch {
    fallbackCopy(source);
  }
}

export function LocalActions({
  source,
  locale,
  filename,
  clipboard,
  download = browserDownload,
  navigation = browserNavigation,
  representationHref,
  representationLabel,
  onActionState,
}: LocalActionsProps) {
  const [wrapped, setWrapped] = React.useState(false);
  const [showSource, setShowSource] = React.useState(false);
  const [outcomes, setOutcomes] = React.useState<Partial<Record<"copy" | "download", LocalActionState>>>({});
  const copy = labels(locale);

  const report = React.useCallback((state: LocalActionState) => {
    setOutcomes((current) => ({ ...current, [state.key]: state }));
    onActionState?.(state);
  }, [onActionState]);

  const run = React.useCallback(async (key: "copy" | "download", operation: () => Promise<void>) => {
    const startedAt = new Date().toISOString();
    report({ key, state: "pending", startedAt });
    try {
      await operation();
      report({ key, state: "succeeded", startedAt, settledAt: new Date().toISOString() });
    } catch {
      report({ key, state: "failed", startedAt, settledAt: new Date().toISOString() });
    }
  }, [report]);

  const copyLabel = outcomes.copy === undefined ? copy.copy : dictionaries[locale].actions.copy[outcomes.copy.state];
  const downloadLabel = outcomes.download === undefined ? copy.download : dictionaries[locale].actions.download[outcomes.download.state];

  return (
    <section aria-label={copy.localActions} className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" className="min-h-11" onClick={() => void run("copy", () => copySource(source, clipboard))}>
          {copyLabel}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          onClick={() => void run("download", async () => {
            const blob = new Blob([new TextEncoder().encode(source)], { type: "application/octet-stream" });
            const url = download.createObjectURL(blob);
            download.dispatchDownload(url, filename);
          })}
        >
          {downloadLabel}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          onClick={() => {
            const url = download.createObjectURL(new Blob([source], { type: "text/html" }));
            navigation.assign(url);
          }}
        >
          {copy.openHtmlLocally}
        </Button>
        {representationHref !== undefined && (
          <a className="inline-flex min-h-11 items-center px-3 text-primary underline-offset-4 hover:underline" href={representationHref}>
            {representationLabel ?? copy.raw}
          </a>
        )}
        <Button type="button" variant="ghost" className="min-h-11" onClick={() => setWrapped((value) => !value)}>
          {wrapped ? copy.unwrap : copy.wrap}
        </Button>
        <Button type="button" variant="ghost" className="min-h-11" onClick={() => setShowSource((value) => !value)}>
          {showSource ? copy.preview : copy.source}
        </Button>
      </div>
      {showSource && <pre data-local-source="true" className={wrapped ? "whitespace-pre-wrap break-words" : "overflow-x-auto whitespace-pre"}>{source}</pre>}
    </section>
  );
}
