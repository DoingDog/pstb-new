import type { Crepe } from "@milkdown/crepe";

export type MarkdownMode = "source" | "visual" | "preview";

export interface MarkdownPreview {
  source: string;
  html: string;
}

type MarkdownPreviewModules = [
  Pick<typeof import("micromark"), "micromark">,
  Pick<typeof import("micromark-extension-gfm"), "gfm" | "gfmHtml">,
];

type MarkdownVisualModules = [
  Pick<typeof import("@milkdown/crepe"), "Crepe">,
  Pick<typeof import("@milkdown/kit/core"), "prosePluginsCtx">,
  Pick<typeof import("@milkdown/kit/prose/state"), "Plugin">,
];

export interface MarkdownModesOptions {
  source: Pick<HTMLTextAreaElement, "value">;
  visualRoot: Node;
  onDocumentChange(markdown: string): void;
  onModeChange?(mode: MarkdownMode): void;
  onPreview?(preview: MarkdownPreview): void;
  onVisualError?(error: { message: string; retry(): Promise<void> }): void;
  loadPreview?(): Promise<MarkdownPreviewModules>;
}

export interface MarkdownModes {
  enterSource(): Promise<void>;
  enterVisual(): Promise<void>;
  enterPreview(): Promise<void>;
  leaveVisual(): Promise<void>;
  destroy(): Promise<void>;
}

export function createMarkdownModes(options: MarkdownModesOptions): MarkdownModes {
  let visualEditor: Crepe | undefined;
  let visualRootSnapshot: ReadonlySet<ChildNode> | undefined;
  let visualSerialized = "";
  let visualDirty = false;
  let visualReady = false;
  let visualTransition = 0;
  let transition = 0;
  let visualRootTransition = Promise.resolve();

  const current = (id: number): boolean => id === transition;

  const setMode = (next: MarkdownMode): void => {
    options.onModeChange?.(next);
  };

  const useVisualRoot = <T>(task: () => Promise<T>): Promise<T> => {
    const next = visualRootTransition.then(task, task);
    visualRootTransition = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const removePartialVisualRoot = (initialNodes: ReadonlySet<ChildNode>): void => {
    for (const child of Array.from(options.visualRoot.childNodes)) {
      if (initialNodes.has(child)) continue;
      try {
        options.visualRoot.removeChild(child);
      } catch {
        // Keep cleanup best-effort when a library node was already removed.
      }
    }
  };

  const destroyEditor = async (editor: Crepe, initialNodes: ReadonlySet<ChildNode> | undefined): Promise<void> => {
    try {
      await editor.destroy();
    } catch {
      if (initialNodes !== undefined) removePartialVisualRoot(initialNodes);
    }
  };

  const leaveCurrentVisual = async (): Promise<void> => {
    const editor = visualEditor;
    const rootSnapshot = visualRootSnapshot;
    const wasDirty = visualDirty;
    const serialized = visualSerialized;
    visualEditor = undefined;
    visualRootSnapshot = undefined;
    visualDirty = false;
    visualReady = false;
    visualSerialized = "";
    visualTransition = 0;

    if (editor === undefined) return;

    try {
      if (wasDirty && options.source.value === serialized) {
        const markdown = editor.getMarkdown();
        if (markdown !== options.source.value) {
          options.source.value = markdown;
          options.onDocumentChange(markdown);
        }
      }
    } finally {
      await destroyEditor(editor, rootSnapshot);
    }
  };

  const leaveToSource = (id: number): Promise<void> =>
    useVisualRoot(async () => {
      try {
        await leaveCurrentVisual();
      } catch (error) {
        reportVisualError(id, error);
        return;
      }
      if (current(id)) setMode("source");
    });

  const reportVisualError = (id: number, error: unknown): void => {
    if (!current(id)) return;
    setMode("source");
    options.onVisualError?.({
      message: error instanceof Error ? error.message : "Unable to start visual editor",
      retry: enterVisual,
    });
  };

  const enterSource = (): Promise<void> => {
    const id = ++transition;
    return leaveToSource(id);
  };

  const leaveVisual = (): Promise<void> => {
    const id = ++transition;
    return leaveToSource(id);
  };

  const enterVisual = (): Promise<void> => {
    if (visualReady && visualEditor !== undefined && visualTransition === transition) return Promise.resolve();

    const id = ++transition;
    const visualSourceSnapshot = options.source.value;

    return useVisualRoot(async () => {
      if (!current(id) || visualEditor !== undefined) return false;
      if (options.source.value !== visualSourceSnapshot) {
        setMode("source");
        return false;
      }
      return true;
    }).then(async (canMount) => {
      if (!canMount) return;

      let modules: MarkdownVisualModules;
      try {
        modules = await Promise.all([
          import("@milkdown/crepe"),
          import("@milkdown/kit/core"),
          import("@milkdown/kit/prose/state"),
        ]);
      } catch (error) {
        reportVisualError(id, error);
        return;
      }
      if (!current(id) || options.source.value !== visualSourceSnapshot) {
        if (current(id)) setMode("source");
        return;
      }

      await useVisualRoot(async () => {
        if (!current(id) || visualEditor !== undefined) return;
        if (options.source.value !== visualSourceSnapshot) {
          setMode("source");
          return;
        }

        const initialNodes = new Set<ChildNode>(Array.from(options.visualRoot.childNodes));
        const [{ Crepe }, { prosePluginsCtx }, { Plugin }] = modules;
        let editor: Crepe;
        let ready = false;
        try {
          editor = new Crepe({ root: options.visualRoot, defaultValue: visualSourceSnapshot });
          editor.editor.config((ctx) => {
            ctx.update(prosePluginsCtx, (plugins) =>
              plugins.concat(
                new Plugin({
                  view: () => ({
                    update: (view, previous) => {
                      if (!ready || view.state.doc.eq(previous.doc) || visualEditor !== editor) return;
                      visualDirty = true;
                      const markdown = editor.getMarkdown();
                      visualSerialized = markdown;
                      options.source.value = markdown;
                      options.onDocumentChange(markdown);
                    },
                  }),
                }),
              ),
            );
          });
        } catch (error) {
          removePartialVisualRoot(initialNodes);
          reportVisualError(id, error);
          return;
        }
        if (!current(id) || options.source.value !== visualSourceSnapshot) {
          removePartialVisualRoot(initialNodes);
          if (current(id)) setMode("source");
          return;
        }

        visualEditor = editor;
        visualRootSnapshot = initialNodes;
        visualDirty = false;
        visualReady = false;
        visualSerialized = visualSourceSnapshot;
        visualTransition = 0;
        try {
          await editor.create();
        } catch (error) {
          // Milkdown can remain OnCreate here, where destroy() does not settle.
          if (visualEditor === editor) {
            visualEditor = undefined;
            visualRootSnapshot = undefined;
            visualDirty = false;
            visualReady = false;
            visualSerialized = "";
            visualTransition = 0;
          }
          removePartialVisualRoot(initialNodes);
          reportVisualError(id, error);
          return;
        }

        if (!current(id) || visualEditor !== editor || options.source.value !== visualSourceSnapshot) {
          await leaveCurrentVisual();
          if (current(id)) setMode("source");
          return;
        }

        ready = true;
        visualReady = true;
        visualTransition = id;
        setMode("visual");
      });
    });
  };

  const enterPreview = (): Promise<void> => {
    const id = ++transition;
    return useVisualRoot(async () => {
      await leaveCurrentVisual();
      if (current(id)) setMode("source");
    }).then(async () => {
      if (!current(id)) return;

      try {
        const [{ micromark }, { gfm, gfmHtml }] = await (options.loadPreview?.() ??
          Promise.all([import("micromark"), import("micromark-extension-gfm")]));
        if (!current(id)) return;

        const source = options.source.value;
        const html = micromark(source, {
          allowDangerousHtml: false,
          allowDangerousProtocol: false,
          extensions: [gfm()],
          htmlExtensions: [gfmHtml()],
        });
        if (!current(id)) return;
        options.onPreview?.({ source, html });
        if (current(id)) setMode("preview");
      } catch (error) {
        if (current(id)) throw error;
      }
    });
  };

  const destroy = (): Promise<void> => {
    const id = ++transition;
    return leaveToSource(id);
  };

  return { enterSource, enterVisual, enterPreview, leaveVisual, destroy };
}
