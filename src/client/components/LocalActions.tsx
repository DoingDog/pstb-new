import * as React from "react";
import { dictionaries, labels, type Locale } from "../../i18n";
import { Button } from "@/components/ui/button";
import { useOverflowFocus } from "./useOverflowFocus";

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

type LocalActionKey = "copy" | "download";

export interface LocalActionState {
  key: LocalActionKey;
  state: "pending" | "succeeded" | "failed";
  attempt: number;
  startedAt: string;
  settledAt?: string;
}

export interface LocalActionCapabilities {
  copy?: boolean;
  download?: boolean;
  html?: "blob" | { href: string; label?: string };
  wrap?: {
    value: boolean;
    onChange(value: boolean): void;
  };
  sourcePreview?: {
    sourceVisible: boolean;
    onSourceVisibleChange(value: boolean): void;
    preview: React.ReactNode;
  };
}

export interface LocalActionsProps {
  actionScope: string;
  source: string;
  locale: Locale;
  filename: string;
  capabilities: LocalActionCapabilities;
  clipboard?: ClipboardPort;
  download?: DownloadPort;
  navigation?: NavigationPort;
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
  const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const textarea = document.createElement("textarea");
  const onCopy = (event: ClipboardEvent) => {
    event.clipboardData?.setData("text/plain", source);
    event.preventDefault();
  };

  textarea.value = source;
  textarea.setAttribute("aria-hidden", "true");
  textarea.tabIndex = -1;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.addEventListener("copy", onCopy);
  try {
    document.body.appendChild(textarea);
    textarea.select();
    if (!document.execCommand("copy")) throw new Error("copy failed");
  } finally {
    document.removeEventListener("copy", onCopy);
    textarea.remove();
    previouslyFocused?.focus();
  }
}

async function copySource(source: string, clipboard: ClipboardPort | undefined, isCurrent: () => boolean): Promise<void> {
  try {
    const port = clipboard ?? navigator.clipboard;
    if (port === undefined || typeof port.writeText !== "function") throw new Error("clipboard unavailable");
    await port.writeText(source);
  } catch {
    if (isCurrent()) fallbackCopy(source);
  }
}

export function LocalActions({
  actionScope,
  source,
  locale,
  filename,
  capabilities,
  clipboard,
  download = browserDownload,
  navigation = browserNavigation,
  onActionState,
}: LocalActionsProps) {
  const [outcomes, setOutcomes] = React.useState<Partial<Record<LocalActionKey, LocalActionState>>>({});
  const mounted = React.useRef(true);
  const nextAttempt = React.useRef(0);
  const latestByKey = React.useRef<Partial<Record<LocalActionKey, number>>>({});
  const latestAttempt = React.useRef(0);
  const pendingKeys = React.useRef<Partial<Record<LocalActionKey, boolean>>>({});
  const scope = React.useRef(actionScope);
  const generation = React.useRef(0);
  const callback = React.useRef(onActionState);
  callback.current = onActionState;
  const copy = labels(locale);
  const html = capabilities.html;
  const sourceOverflow = useOverflowFocus(!capabilities.wrap?.value, source);

  React.useLayoutEffect(() => {
    if (scope.current === actionScope) return;
    scope.current = actionScope;
    generation.current += 1;
    latestAttempt.current = ++nextAttempt.current;
    latestByKey.current = {};
    pendingKeys.current = {};
    setOutcomes({});
  }, [actionScope]);

  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      latestAttempt.current = ++nextAttempt.current;
    };
  }, []);

  const report = React.useCallback((state: LocalActionState, reportLastAction: boolean) => {
    if (!mounted.current) return;
    setOutcomes((current) => ({ ...current, [state.key]: state }));
    if (reportLastAction && latestAttempt.current === state.attempt) callback.current?.(state);
  }, []);

  const run = React.useCallback(async (key: LocalActionKey, operation: (isCurrent: () => boolean) => Promise<void>) => {
    if (pendingKeys.current[key]) return;
    const attempt = ++nextAttempt.current;
    const actionGeneration = generation.current;
    const startedAt = new Date().toISOString();
    const isCurrent = () => mounted.current && generation.current === actionGeneration && latestByKey.current[key] === attempt;
    pendingKeys.current[key] = true;
    latestByKey.current[key] = attempt;
    latestAttempt.current = attempt;
    report({ key, state: "pending", attempt, startedAt }, true);
    try {
      await operation(isCurrent);
      if (!isCurrent()) return;
      pendingKeys.current[key] = false;
      report({ key, state: "succeeded", attempt, startedAt, settledAt: new Date().toISOString() }, true);
    } catch {
      if (!isCurrent()) return;
      pendingKeys.current[key] = false;
      report({ key, state: "failed", attempt, startedAt, settledAt: new Date().toISOString() }, true);
    }
  }, [report]);

  const copyLabel = outcomes.copy === undefined ? copy.copy : dictionaries[locale].actions.copy[outcomes.copy.state];
  const downloadLabel = outcomes.download === undefined ? copy.download : dictionaries[locale].actions.download[outcomes.download.state];
  const copyPending = outcomes.copy?.state === "pending";
  const downloadPending = outcomes.download?.state === "pending";

  const downloadSource = async () => {
    const url = download.createObjectURL(new Blob([new TextEncoder().encode(source)], { type: "application/octet-stream" }));
    let dispatched = false;
    try {
      download.dispatchDownload(url, filename);
      dispatched = true;
    } finally {
      if (dispatched) setTimeout(() => {
        try {
          download.revokeObjectURL(url);
        } catch {
          // The successful download has already been dispatched.
        }
      }, 0);
      else download.revokeObjectURL(url);
    }
  };

  return (
    <section aria-label={copy.localActions} className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        {capabilities.copy && (
          <Button type="button" variant="outline" className="min-h-11" aria-disabled={copyPending || undefined} onClick={() => void run("copy", (isCurrent) => copySource(source, clipboard, isCurrent))}>
            {copyLabel}
          </Button>
        )}
        {capabilities.download && (
          <Button type="button" variant="outline" className="min-h-11" aria-disabled={downloadPending || undefined} onClick={() => void run("download", downloadSource)}>
            {downloadLabel}
          </Button>
        )}
        {html === "blob" && (
          <Button type="button" variant="outline" className="min-h-11" onClick={() => navigation.assign(download.createObjectURL(new Blob([source], { type: "text/html" })))}>
            {copy.openHtmlLocally}
          </Button>
        )}
        {typeof html === "object" && (
          <a className="inline-flex min-h-11 items-center px-3 text-primary underline-offset-4 hover:underline" href={html.href}>
            {html.label ?? copy.html}
          </a>
        )}
        {capabilities.wrap !== undefined && (
          <Button type="button" variant="outline" className="min-h-11" onClick={() => capabilities.wrap!.onChange(!capabilities.wrap!.value)}>
            {capabilities.wrap.value ? copy.unwrap : copy.wrap}
          </Button>
        )}
        {capabilities.sourcePreview !== undefined && (
          <Button type="button" variant="ghost" className="min-h-11" onClick={() => capabilities.sourcePreview!.onSourceVisibleChange(!capabilities.sourcePreview!.sourceVisible)}>
            {capabilities.sourcePreview.sourceVisible ? copy.preview : copy.source}
          </Button>
        )}
      </div>
      {capabilities.sourcePreview !== undefined && (
        capabilities.sourcePreview.sourceVisible
          ? <pre ref={sourceOverflow.ref} data-local-source="true" className={capabilities.wrap?.value ? "whitespace-pre-wrap break-words" : "whitespace-pre"} tabIndex={sourceOverflow.tabIndex}>{source}</pre>
          : capabilities.sourcePreview.preview
      )}
    </section>
  );
}
