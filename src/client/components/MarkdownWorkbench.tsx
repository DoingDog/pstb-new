import * as React from "react";
import { errorMessage, labels, type Locale } from "../../i18n";
import type { TrustedMarkdownHtml } from "../bootstrap";
import { createAutosaveMarkdownModes, type AutosaveControllerApi } from "../autosave";
import type { SourceEvent } from "../contracts";
import type { MarkdownMode, MarkdownModes, MarkdownModesOptions, MarkdownPreview } from "../markdown";
import { Button } from "./ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { PlaintextEditor, type EditorWrap } from "./PlaintextEditor";
import { SafeMarkdown } from "./SafeMarkdown";

export interface MarkdownWorkbenchProps {
  source: string;
  initialSource?: string;
  initialMarkdown: TrustedMarkdownHtml | null;
  wrap: EditorWrap;
  autosave: Pick<AutosaveControllerApi, "input" | "compositionStart" | "compositionEnd">;
  onSourceEvent(event: SourceEvent): void;
  locale?: Locale;
  now?(): number;
  importBrowserMarkdown?: MarkdownModesOptions["loadPreview"];
  loadCrepeStyle?(): Promise<unknown>;
}

type WorkbenchFailure = { retry(): void };

const browserNow = (): number => performance.now();
const loadCrepeStyle = (): Promise<unknown> =>
  // @ts-expect-error The package exports CSS without a TypeScript declaration.
  import("@milkdown/crepe/theme/common/style.css");
let visualTeardown = Promise.resolve();

export function MarkdownWorkbench({
  source,
  initialSource = source,
  initialMarkdown,
  wrap,
  autosave,
  onSourceEvent,
  locale = "en",
  now = browserNow,
  importBrowserMarkdown,
  loadCrepeStyle: loadStyle = loadCrepeStyle,
}: MarkdownWorkbenchProps) {
  const copy = labels(locale);
  const visualRoot = React.useRef<HTMLDivElement | null>(null);
  const modes = React.useRef<MarkdownModes | null>(null);
  const sourceAdapter = React.useRef<Pick<HTMLTextAreaElement, "value">>({ value: source });
  const renderedSource = React.useRef(source);
  const latest = React.useRef({ autosave, initialMarkdown, initialSource, loadStyle, now, onSourceEvent });
  latest.current = { autosave, initialMarkdown, initialSource, loadStyle, now, onSourceEvent };
  const [mode, setMode] = React.useState<MarkdownMode>("source");
  const [preview, setPreview] = React.useState<MarkdownPreview | null>(null);
  const [failure, setFailure] = React.useState<WorkbenchFailure | null>(null);
  const chooseModeRef = React.useRef<(mode: MarkdownMode) => void>(() => undefined);

  if (renderedSource.current !== source) {
    renderedSource.current = source;
    sourceAdapter.current.value = source;
  }

  React.useEffect(() => {
    const root = visualRoot.current;
    if (root === null) return;
    const controller = createAutosaveMarkdownModes({
      autosave: {
        input: (content, eventAt) => latest.current.autosave.input(content, eventAt),
      },
      now: () => latest.current.now(),
      source: sourceAdapter.current,
      visualRoot: root,
      ...(importBrowserMarkdown === undefined ? {} : { loadPreview: importBrowserMarkdown }),
      onCrepeChange: (content, eventAt) => latest.current.onSourceEvent({ type: "crepe-change", content, eventAt }),
      onModeChange: setMode,
      onPreview: setPreview,
      onVisualError: ({ retry }) => setFailure({ retry: () => void retry() }),
    });
    modes.current = controller;
    return () => {
      if (modes.current === controller) modes.current = null;
      const destroy = controller.destroy();
      visualTeardown = visualTeardown.then(() => destroy, () => destroy);
    };
  }, []);

  const chooseMode = React.useCallback(async (next: MarkdownMode) => {
    const controller = modes.current;
    if (controller === null) return;
    setFailure(null);
    if (next === "source") {
      await controller.enterSource();
      return;
    }
    if (next === "visual") {
      try {
        await latest.current.loadStyle();
        await visualTeardown;
        await controller.enterVisual();
      } catch {
        setMode("source");
        setFailure({ retry: () => chooseModeRef.current("visual") });
      }
      return;
    }
    if (sourceAdapter.current.value === latest.current.initialSource && latest.current.initialMarkdown !== null) {
      await controller.enterSource();
      setPreview({ source: latest.current.initialSource, html: latest.current.initialMarkdown });
      setMode("preview");
      return;
    }
    try {
      await controller.enterPreview();
    } catch {
      setMode("source");
      setFailure({ retry: () => chooseModeRef.current("preview") });
    }
  }, []);
  chooseModeRef.current = (next) => void chooseMode(next);

  const retry = React.useCallback(() => {
    const current = failure;
    setFailure(null);
    current?.retry();
  }, [failure]);

  return (
    <section data-markdown-workbench="true" className="flex min-w-0 flex-col gap-3">
      <Tabs value={mode} onValueChange={(value) => void chooseMode(value as MarkdownMode)} activationMode="automatic">
        <TabsList variant="line" aria-label={copy.markdown}>
          <TabsTrigger value="source">{copy.source}</TabsTrigger>
          <TabsTrigger value="visual">Visual</TabsTrigger>
          <TabsTrigger value="preview">{copy.preview}</TabsTrigger>
        </TabsList>
        <TabsContent value="source" forceMount hidden={mode !== "source"}>
          <PlaintextEditor value={source} wrap={wrap} autosave={autosave} onSourceEvent={onSourceEvent} label={copy.source} />
        </TabsContent>
        <TabsContent value="visual" forceMount hidden={mode !== "visual"}>
          <div ref={visualRoot} data-markdown-visual-host="true" />
        </TabsContent>
        <TabsContent value="preview" forceMount hidden={mode !== "preview"}>
          {preview === null ? <pre className="overflow-x-auto whitespace-pre-wrap">{source}</pre> : <SafeMarkdown html={preview.html as TrustedMarkdownHtml} />}
        </TabsContent>
      </Tabs>
      {failure !== null && (
        <div role="alert" className="flex items-center gap-2">
          <span>{errorMessage(locale, "INTERNAL_ERROR")}</span>
          <Button type="button" variant="outline" onClick={retry}>{copy.retry}</Button>
        </div>
      )}
    </section>
  );
}
