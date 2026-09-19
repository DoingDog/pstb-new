import * as React from "react";
import { errorMessage, labels, type Locale } from "../../i18n";
import type { TrustedMarkdownHtml } from "../bootstrap";
import {
  createAutosaveMarkdownModes,
  type AutosaveControllerApi,
  type AutosaveMarkdownModesOptions,
} from "../autosave";
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
type ModeFactory = (options: AutosaveMarkdownModesOptions) => MarkdownModes;
type ModeOwner = {
  generation: number;
  source: string;
  active: boolean;
  target: MarkdownMode;
  request: number;
  editorGeneration: number;
  serializerGeneration: number;
  failedTarget: MarkdownMode | null;
  localAcknowledgement: string | null;
  pendingAutosave: { content: string; eventAt: number; request: number } | null;
  controller: MarkdownModes;
};
type Ports = {
  autosave: MarkdownWorkbenchProps["autosave"];
  onSourceEvent: MarkdownWorkbenchProps["onSourceEvent"];
  now: NonNullable<MarkdownWorkbenchProps["now"]>;
  initialMarkdown: TrustedMarkdownHtml | null;
  initialSource: string;
  loadStyle: NonNullable<MarkdownWorkbenchProps["loadCrepeStyle"]>;
  loadPreview: MarkdownWorkbenchProps["importBrowserMarkdown"];
};

const browserNow = (): number => performance.now();
const loadCrepeStyle = (): Promise<unknown> =>
  // @ts-expect-error The package exports CSS without a TypeScript declaration.
  import("@milkdown/crepe/theme/common/style.css");
let visualTeardown = Promise.resolve();

function queueVisualTeardown(task: () => Promise<void>): Promise<void> {
  const queued = visualTeardown.then(task, task);
  visualTeardown = queued.then(
    () => undefined,
    () => undefined,
  );
  return queued;
}

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
  const [visualRoot, setVisualRoot] = React.useState<HTMLDivElement | null>(null);
  const pendingMode = React.useRef<MarkdownMode | null>(null);
  const sourceAdapter = React.useRef<Pick<HTMLTextAreaElement, "value">>({ value: source });
  const mounted = React.useRef(false);
  const owners = React.useRef<ModeOwner | null>(null);
  const ownerGeneration = React.useRef(0);
  const requestGeneration = React.useRef(0);
  const ports = React.useRef<Ports>({
    autosave,
    onSourceEvent,
    now,
    initialMarkdown,
    initialSource,
    loadStyle,
    loadPreview: importBrowserMarkdown,
  });
  const [mode, setMode] = React.useState<MarkdownMode>("source");
  const [preview, setPreview] = React.useState<MarkdownPreview | null>(null);
  const [failure, setFailure] = React.useState<WorkbenchFailure | null>(null);

  const isCurrentOwner = React.useCallback((owner: ModeOwner): boolean =>
    mounted.current && owner.active && owners.current === owner, []);

  const runMode = React.useCallback(async (next: MarkdownMode): Promise<void> => {
    const owner = owners.current;
    if (owner === null || !isCurrentOwner(owner)) {
      pendingMode.current = next;
      if (next !== "source") setMode(next);
      return;
    }
    if (owner.failedTarget === next) return;
    owner.failedTarget = null;

    const request = ++requestGeneration.current;
    owner.request = request;
    owner.target = next;
    if (next === "visual") owner.editorGeneration = request;
    owner.pendingAutosave = null;
    setFailure(null);
    if (next === "preview") setPreview(null);

    const current = (): boolean =>
      isCurrentOwner(owner) &&
      owner.request === request &&
      owner.target === next &&
      (owner.source === sourceAdapter.current.value || owner.localAcknowledgement === sourceAdapter.current.value);
    const publishFailure = (): void => {
      if (!current()) return;
      const failedRequest = ++requestGeneration.current;
      const failedSource = sourceAdapter.current.value;
      owner.request = failedRequest;
      owner.target = "source";
      owner.editorGeneration = 0;
      owner.failedTarget = next;
      owner.pendingAutosave = null;
      setMode("source");
      setFailure({
        retry: () => {
          if (
            isCurrentOwner(owner) &&
            owner.generation === ownerGeneration.current &&
            owner.request === failedRequest &&
            owner.target === "source" &&
            sourceAdapter.current.value === failedSource
          ) {
            owner.failedTarget = null;
            void runMode(next);
          }
        },
      });
    };

    try {
      if (next === "source") {
        await visualTeardown;
        if (!current()) return;
        await owner.controller.enterSource();
        if (!current()) return;
        owner.editorGeneration = 0;
        setMode("source");
        return;
      }

      if (next === "visual") {
        await ports.current.loadStyle();
        if (!current()) return;
        await visualTeardown;
        if (!current()) return;
        await owner.controller.enterVisual();
        if (!current()) return;
        owner.editorGeneration = request;
        setMode("visual");
        return;
      }

      if (
        owner.source === ports.current.initialSource &&
        sourceAdapter.current.value === owner.source &&
        ports.current.initialMarkdown !== null
      ) {
        await visualTeardown;
        if (!current()) return;
        await owner.controller.enterSource();
        if (!current()) return;
        owner.editorGeneration = 0;
        setPreview({ source: ports.current.initialSource, html: ports.current.initialMarkdown });
        setMode("preview");
        return;
      }

      await visualTeardown;
      if (!current()) return;
      await owner.controller.enterPreview();
      if (!current()) return;
      owner.editorGeneration = 0;
      setMode("preview");
    } catch {
      publishFailure();
    }
  }, [isCurrentOwner]);

  const createOwner = React.useCallback((canonicalSource: string): ModeOwner | null => {
    if (visualRoot === null || !mounted.current) return null;

    const owner = {} as ModeOwner;
    const current = (): boolean => isCurrentOwner(owner);
    const fail = (retry: () => Promise<void>): void => {
      if (!current()) return;

      if (
        owner.target === "visual" &&
        owner.editorGeneration !== 0 &&
        owner.editorGeneration === owner.request
      ) {
        const request = owner.request;
        const editorGeneration = owner.editorGeneration;
        const serializerGeneration = ++owner.serializerGeneration;
        const failedSource = sourceAdapter.current.value;
        owner.failedTarget = "visual";
        owner.pendingAutosave = null;
        setMode("source");
        setFailure({
          retry: () => {
            if (
              !isCurrentOwner(owner) ||
              owner.generation !== ownerGeneration.current ||
              owner.request !== request ||
              owner.target !== "visual" ||
              owner.editorGeneration !== editorGeneration ||
              owner.serializerGeneration !== serializerGeneration ||
              sourceAdapter.current.value !== failedSource
            ) return;
            void retry().then(
              () => {
                if (
                  isCurrentOwner(owner) &&
                  owner.generation === ownerGeneration.current &&
                  owner.request === request &&
                  owner.target === "visual" &&
                  owner.editorGeneration === editorGeneration &&
                  owner.serializerGeneration === serializerGeneration &&
                  sourceAdapter.current.value === failedSource
                ) {
                  owner.failedTarget = null;
                  setFailure(null);
                  setMode("visual");
                }
              },
              () => fail(retry),
            );
          },
        });
        return;
      }

      if ((owner.target !== "source" && owner.target !== "preview") || owner.editorGeneration === 0) return;
      const target = owner.target;
      const failedRequest = ++requestGeneration.current;
      const failedSource = sourceAdapter.current.value;
      owner.request = failedRequest;
      owner.target = "source";
      owner.editorGeneration = 0;
      owner.failedTarget = target;
      owner.pendingAutosave = null;
      setMode("source");
      setFailure({
        retry: () => {
          if (
            isCurrentOwner(owner) &&
            owner.generation === ownerGeneration.current &&
            owner.request === failedRequest &&
            owner.target === "source" &&
            sourceAdapter.current.value === failedSource
          ) {
            owner.failedTarget = null;
            void runMode(target);
          }
        },
      });
    };
    const controller = (createAutosaveMarkdownModes as ModeFactory)({
      autosave: {
        input: (content, eventAt) => {
          const pending = owner.pendingAutosave;
          owner.pendingAutosave = null;
          if (
            pending === null ||
            pending.content !== content ||
            pending.eventAt !== eventAt ||
            pending.request !== owner.request ||
            !current()
          ) {
            return;
          }
          ports.current.autosave.input(content, eventAt);
        },
      },
      now: () => ports.current.now(),
      source: sourceAdapter.current,
      visualRoot,
      ...(ports.current.loadPreview === undefined ? {} : { loadPreview: ports.current.loadPreview }),
      onCrepeChange: (content, eventAt) => {
        if (
          !current() ||
          owner.target !== "visual" ||
          owner.editorGeneration === 0 ||
          owner.editorGeneration !== owner.request
        ) return;
        ++owner.serializerGeneration;
        owner.failedTarget = null;
        setFailure(null);
        setMode("visual");
        owner.localAcknowledgement = content;
        owner.pendingAutosave = { content, eventAt, request: owner.request };
        sourceAdapter.current.value = content;
        ports.current.onSourceEvent({ type: "crepe-change", content, eventAt });
      },
      onPreview: (nextPreview) => {
        if (
          !current() ||
          owner.target !== "preview" ||
          nextPreview.source !== sourceAdapter.current.value
        ) return;
        setPreview(nextPreview);
      },
      onVisualError: ({ retry }) => fail(retry),
    });
    owner.generation = ++ownerGeneration.current;
    owner.source = canonicalSource;
    owner.active = true;
    owner.target = "source";
    owner.request = ++requestGeneration.current;
    owner.editorGeneration = 0;
    owner.serializerGeneration = 0;
    owner.failedTarget = null;
    owner.localAcknowledgement = null;
    owner.pendingAutosave = null;
    owner.controller = controller;
    owners.current = owner;
    return owner;
  }, [isCurrentOwner, runMode, visualRoot]);

  const retireOwner = React.useCallback((owner: ModeOwner): void => {
    if (owners.current !== owner) return;
    owner.active = false;
    owners.current = null;
    ++requestGeneration.current;
    void queueVisualTeardown(async () => {
      try {
        await owner.controller.destroy();
      } catch {
        // The retired owner cannot publish an error after teardown fails.
      }
    });
  }, []);

  React.useLayoutEffect(() => {
    ports.current = {
      autosave,
      onSourceEvent,
      now,
      initialMarkdown,
      initialSource,
      loadStyle,
      loadPreview: importBrowserMarkdown,
    };
  });

  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const owner = owners.current;
      if (owner !== null) retireOwner(owner);
    };
  }, [retireOwner]);

  React.useEffect(() => {
    if (visualRoot === null || !mounted.current) return;
    const owner = createOwner(sourceAdapter.current.value);
    const requested = pendingMode.current;
    pendingMode.current = null;
    if (requested !== null) void runMode(requested);
    return () => {
      if (owner !== null) retireOwner(owner);
    };
  }, [visualRoot, createOwner, retireOwner, runMode]);

  React.useLayoutEffect(() => {
    const owner = owners.current;
    if (owner === null || !isCurrentOwner(owner)) {
      sourceAdapter.current.value = source;
      return;
    }
    if (source === owner.source) {
      sourceAdapter.current.value = source;
      return;
    }
    if (owner.localAcknowledgement === source) {
      owner.source = source;
      owner.localAcknowledgement = null;
      sourceAdapter.current.value = source;
      return;
    }

    retireOwner(owner);
    sourceAdapter.current.value = source;
    setPreview(null);
    setFailure(null);
    setMode("source");
    createOwner(source);
  }, [source, createOwner, isCurrentOwner, retireOwner]);

  return (
    <section data-markdown-workbench="true" className="flex min-w-0 flex-col gap-3">
      <Tabs value={mode} onValueChange={(value) => void runMode(value as MarkdownMode)} activationMode="automatic">
        <TabsList variant="line" aria-label={copy.markdown}>
          <TabsTrigger value="source">{copy.source}</TabsTrigger>
          <TabsTrigger value="visual">Visual</TabsTrigger>
          <TabsTrigger value="preview">{copy.preview}</TabsTrigger>
        </TabsList>
        <TabsContent value="source" forceMount hidden={mode !== "source"}>
          <PlaintextEditor value={source} wrap={wrap} autosave={autosave} onSourceEvent={onSourceEvent} label={copy.source} />
        </TabsContent>
        <TabsContent value="visual" forceMount hidden={mode !== "visual"}>
          <div ref={setVisualRoot} data-markdown-visual-host="true" />
        </TabsContent>
        <TabsContent value="preview" forceMount hidden={mode !== "preview"}>
          {preview === null ? <pre className="overflow-x-auto whitespace-pre-wrap">{source}</pre> : <SafeMarkdown html={preview.html as TrustedMarkdownHtml} />}
        </TabsContent>
      </Tabs>
      {failure !== null && (
        <div role="alert" className="flex items-center gap-2">
          <span>{errorMessage(locale, "INTERNAL_ERROR")}</span>
          <Button type="button" variant="outline" onClick={() => failure.retry()}>{copy.retry}</Button>
        </div>
      )}
    </section>
  );
}
