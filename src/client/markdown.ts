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
  let visualSession: HTMLElement | undefined;
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

  const createVisualSession = (): HTMLElement => {
    const session = options.visualRoot.ownerDocument?.createElement("div") ?? ({} as HTMLElement);
    options.visualRoot.appendChild?.(session);
    return session;
  };

  const removeVisualSession = (session: Node | undefined): void => {
    if (session === undefined) return;
    try {
      options.visualRoot.removeChild(session);
    } catch {
      // Keep cleanup best-effort when a library node was already removed.
    }
  };

  const destroyEditor = async (editor: Crepe, session: HTMLElement | undefined): Promise<void> => {
    try {
      await editor.destroy();
    } catch {
      // Keep teardown recoverable when the editor rejects its own cleanup.
    } finally {
      removeVisualSession(session);
    }
  };

  const leaveCurrentVisual = async (): Promise<void> => {
    const editor = visualEditor;
    const session = visualSession;
    const wasDirty = visualDirty;
    const serialized = visualSerialized;
    visualEditor = undefined;
    visualSession = undefined;
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
      await destroyEditor(editor, session);
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

        const [{ Crepe }, { prosePluginsCtx }, { Plugin }] = modules;
        let editor: Crepe | undefined;
        let session: HTMLElement | undefined;
        let ready = false;
        try {
          session = createVisualSession();
          const mountedSession = session;
          editor = new Crepe({ root: mountedSession, defaultValue: visualSourceSnapshot });
          const mountedEditor = editor;
          let serializationAttempt = 0;
          const serializeVisualDocument = (): void => {
            if (!ready || !current(id) || visualEditor !== mountedEditor || visualSession !== mountedSession) return;
            const attempt = ++serializationAttempt;
            try {
              const markdown = mountedEditor.getMarkdown();
              if (!ready || !current(id) || visualEditor !== mountedEditor || visualSession !== mountedSession || attempt !== serializationAttempt) return;
              visualSerialized = markdown;
              options.source.value = markdown;
              options.onDocumentChange(markdown);
            } catch (error) {
              if (!ready || !current(id) || visualEditor !== mountedEditor || visualSession !== mountedSession || attempt !== serializationAttempt) return;
              options.onVisualError?.({
                message: error instanceof Error ? error.message : String(error),
                retry: async () => {
                  if (attempt === serializationAttempt) serializeVisualDocument();
                },
              });
            }
          };
          mountedEditor.editor.config((ctx) => {
            ctx.update(prosePluginsCtx, (plugins) =>
              plugins.concat(
                new Plugin({
                  view: () => ({
                    update: (view, previous) => {
                      if (
                        !ready ||
                        !current(id) ||
                        view.state.doc.eq(previous.doc) ||
                        visualEditor !== mountedEditor ||
                        visualSession !== mountedSession
                      ) {
                        return;
                      }
                      visualDirty = true;
                      serializeVisualDocument();
                    },
                  }),
                }),
              ),
            );
          });
        } catch (error) {
          removeVisualSession(session);
          reportVisualError(id, error);
          return;
        }
        if (editor === undefined || session === undefined) return;
        if (!current(id) || options.source.value !== visualSourceSnapshot) {
          removeVisualSession(session);
          if (current(id)) setMode("source");
          return;
        }

        visualEditor = editor;
        visualSession = session;
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
            visualSession = undefined;
            visualDirty = false;
            visualReady = false;
            visualSerialized = "";
            visualTransition = 0;
          }
          removeVisualSession(session);
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
      try {
        await leaveCurrentVisual();
      } catch (error) {
        reportVisualError(id, error);
        return false;
      }
      if (current(id)) setMode("source");
      return true;
    }).then(async (canPreview) => {
      if (!canPreview || !current(id)) return;

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
