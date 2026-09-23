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
  onVisualCompositionStart?(): void;
  onVisualCompositionEnd?(markdown: string): void;
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

export interface PreparedMarkdownVisualBinding {
  onDocumentChange(markdown: string): void;
  onVisualCompositionStart?(): void;
  onVisualCompositionEnd?(markdown: string): void;
  onModeChange?(mode: MarkdownMode): void;
  onPreview?(preview: MarkdownPreview): void;
  onVisualError?(error: { message: string; retry(): Promise<void> }): void;
}

export interface PreparedMarkdownVisual {
  root: HTMLElement;
  source: Pick<HTMLTextAreaElement, "value">;
  modes: MarkdownModes;
  bind(binding: PreparedMarkdownVisualBinding): void;
  dispose(): Promise<void>;
}

export async function prepareMarkdownPreview(source: string, loadPreview?: () => Promise<MarkdownPreviewModules>): Promise<MarkdownPreview> {
  const [{ micromark }, { gfm, gfmHtml }] = await (loadPreview?.() ??
    Promise.all([import("micromark"), import("micromark-extension-gfm")]));
  return {
    source,
    html: micromark(source, {
      allowDangerousHtml: false,
      allowDangerousProtocol: false,
      extensions: [gfm()],
      htmlExtensions: [gfmHtml()],
    }),
  };
}

export async function prepareMarkdownVisual(sourceValue: string, ownerDocument: Pick<Document, "createElement">): Promise<PreparedMarkdownVisual> {
  const root = ownerDocument.createElement("div");
  const source: Pick<HTMLTextAreaElement, "value"> = { value: sourceValue };
  let binding: PreparedMarkdownVisualBinding = { onDocumentChange: () => undefined };
  let ready = false;
  let failure: Error | null = null;
  const modes = createMarkdownModes({
    source,
    visualRoot: root,
    onDocumentChange: (markdown) => binding.onDocumentChange(markdown),
    onVisualCompositionStart: () => binding.onVisualCompositionStart?.(),
    onVisualCompositionEnd: (markdown) => binding.onVisualCompositionEnd?.(markdown),
    onModeChange: (mode) => {
      ready = mode === "visual";
      binding.onModeChange?.(mode);
    },
    onPreview: (preview) => binding.onPreview?.(preview),
    onVisualError: (error) => {
      failure = new Error(error.message);
      binding.onVisualError?.(error);
    },
  });

  await modes.enterVisual();
  if (!ready) {
    await modes.destroy();
    throw failure ?? new Error("Unable to prepare visual editor");
  }

  let disposed = false;
  return {
    root,
    source,
    modes,
    bind(next) {
      binding = next;
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await modes.destroy();
      root.parentNode?.removeChild(root);
    },
  };
}

export function createMarkdownModes(options: MarkdownModesOptions): MarkdownModes {
  let visualEditor: Crepe | undefined;
  let visualSession: HTMLElement | undefined;
  let visualSerialized = "";
  let visualDirty = false;
  let visualCompositionActive = false;
  let visualCompositionEnded = false;
  let visualCompositionSerial = 0;
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
    const wasComposing = visualCompositionActive;
    const compositionEnded = visualCompositionEnded;
    if (editor !== undefined && wasComposing && compositionEnded) {
      await new Promise<void>((resolve) => {
        const deadline = setTimeout(resolve, 125);
        requestAnimationFrame(() => setTimeout(() => {
          clearTimeout(deadline);
          resolve();
        }, 25));
      });
    }
    if (editor !== undefined && visualDirty && (!wasComposing || compositionEnded) && options.source.value === visualSerialized) {
      const markdown = editor.getMarkdown();
      if (markdown !== options.source.value) {
        options.source.value = markdown;
        options.onDocumentChange(markdown);
      }
    }
    visualEditor = undefined;
    visualSession = undefined;
    visualDirty = false;
    visualCompositionActive = false;
    visualCompositionEnded = false;
    visualReady = false;
    visualSerialized = "";
    visualTransition = 0;

    if (editor === undefined) return;
    try {
      if (wasComposing) options.onVisualCompositionEnd?.(options.source.value);
    } finally {
      await destroyEditor(editor, session);
    }
  };

  const leaveToSource = (id: number): Promise<void> =>
    useVisualRoot(async () => {
      try {
        await leaveCurrentVisual();
      } catch (error) {
        reportVisualError(id, error, enterSource);
        return;
      }
      if (current(id)) setMode("source");
    });

  const reportVisualError = (id: number, error: unknown, retry: () => Promise<void> = enterVisual): void => {
    if (!current(id)) return;
    setMode("source");
    options.onVisualError?.({
      message: error instanceof Error ? error.message : "Unable to start visual editor",
      retry,
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
    if (visualReady && visualEditor !== undefined && visualTransition === transition) {
      setMode("visual");
      return Promise.resolve();
    }

    const id = ++transition;
    const requestedSource = options.source.value;
    const pendingCompositionCommit = visualCompositionActive && visualCompositionEnded;

    return useVisualRoot(async () => {
      if (!current(id) || visualEditor !== undefined) return null;
      if (!pendingCompositionCommit && options.source.value !== requestedSource) {
        setMode("source");
        return null;
      }
      return options.source.value;
    }).then(async (visualSourceSnapshot) => {
      if (visualSourceSnapshot === null) return;

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
          const serializeVisualDocument = (skipUnchanged = false): boolean => {
            if (!ready || !current(id) || visualEditor !== mountedEditor || visualSession !== mountedSession) return false;
            const attempt = ++serializationAttempt;
            try {
              const markdown = mountedEditor.getMarkdown();
              if (!ready || !current(id) || visualEditor !== mountedEditor || visualSession !== mountedSession || attempt !== serializationAttempt) return false;
              if (skipUnchanged && markdown === visualSerialized) return true;
              visualSerialized = markdown;
              options.source.value = markdown;
              options.onDocumentChange(markdown);
              return true;
            } catch (error) {
              if (!ready || !current(id) || visualEditor !== mountedEditor || visualSession !== mountedSession || attempt !== serializationAttempt) return false;
              options.onVisualError?.({
                message: error instanceof Error ? error.message : String(error),
                retry: async () => {
                  if (attempt !== serializationAttempt || !serializeVisualDocument() || !visualCompositionActive || !visualCompositionEnded) return;
                  visualCompositionActive = false;
                  visualCompositionEnded = false;
                  options.onVisualCompositionEnd?.(options.source.value);
                },
              });
              return false;
            }
          };
          mountedEditor.editor.config((ctx) => {
            ctx.update(prosePluginsCtx, (plugins) =>
              plugins.concat(
                new Plugin({
                  view: (view) => {
                    const stillCurrent = () => ready && current(id) && visualEditor === mountedEditor && visualSession === mountedSession;
                    const finish = () => {
                      if (!stillCurrent() || !visualCompositionActive || visualCompositionEnded) return;
                      visualCompositionEnded = true;
                      const serial = visualCompositionSerial;
                      // ProseMirror completes the composition DOM flush after its own 20 ms timer.
                      setTimeout(() => {
                        if (!stillCurrent() || !visualCompositionActive || !visualCompositionEnded || serial !== visualCompositionSerial) return;
                        if (visualDirty && !serializeVisualDocument(true)) return;
                        visualCompositionActive = false;
                        visualCompositionEnded = false;
                        options.onVisualCompositionEnd?.(options.source.value);
                      }, 25);
                    };
                    const start = () => {
                      if (!stillCurrent() || (visualCompositionActive && !visualCompositionEnded)) return;
                      const serial = ++visualCompositionSerial;
                      visualCompositionEnded = false;
                      if (!visualCompositionActive) {
                        visualCompositionActive = true;
                        options.onVisualCompositionStart?.();
                      }
                      const check = () => {
                        if (!stillCurrent() || !visualCompositionActive || visualCompositionEnded || serial !== visualCompositionSerial) return;
                        if (!view.composing) finish();
                        else setTimeout(check, 1_000);
                      };
                      setTimeout(check, 5_100);
                    };
                    const onInput = (event: Event) => {
                      if (event instanceof InputEvent && !event.isComposing) finish();
                    };
                    view.dom.addEventListener("compositionstart", start, true);
                    view.dom.addEventListener("compositionend", finish, true);
                    view.dom.addEventListener("focusout", finish, true);
                    view.dom.addEventListener("input", onInput, true);
                    return {
                      update: (next, previous) => {
                        if (!ready || visualEditor !== mountedEditor || visualSession !== mountedSession || next.state.doc.eq(previous.doc)) return;
                        if (!stillCurrent() && !(visualCompositionActive && visualCompositionEnded)) return;
                        visualDirty = true;
                        if (!stillCurrent()) return;
                        if (next.composing && !visualCompositionActive) start();
                        if (!visualCompositionActive) serializeVisualDocument();
                      },
                      destroy: () => {
                        view.dom.removeEventListener("compositionstart", start, true);
                        view.dom.removeEventListener("compositionend", finish, true);
                        view.dom.removeEventListener("focusout", finish, true);
                        view.dom.removeEventListener("input", onInput, true);
                      },
                    };
                  },
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
        reportVisualError(id, error, enterPreview);
        return false;
      }
      if (current(id)) setMode("source");
      return true;
    }).then(async (canPreview) => {
      if (!canPreview || !current(id)) return;

      try {
        const preview = await prepareMarkdownPreview(options.source.value, options.loadPreview);
        if (!current(id)) return;
        options.onPreview?.(preview);
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
