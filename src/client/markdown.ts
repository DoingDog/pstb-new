import type { Crepe } from "@milkdown/crepe";
import { prosePluginsCtx } from "@milkdown/kit/core";
import { Plugin } from "@milkdown/kit/prose/state";

export type MarkdownMode = "source" | "visual" | "preview";

export interface MarkdownPreview {
  source: string;
  html: string;
}

type MarkdownPreviewModules = [
  Pick<typeof import("micromark"), "micromark">,
  Pick<typeof import("micromark-extension-gfm"), "gfm" | "gfmHtml">,
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
  let mode: MarkdownMode = "source";
  let visualEditor: Crepe | undefined;
  let visualSerialized = "";
  let visualDirty = false;
  let transition = 0;
  let entering = false;

  const setMode = (next: MarkdownMode): void => {
    mode = next;
    options.onModeChange?.(next);
  };

  const destroyEditor = (editor: Crepe): void => {
    try {
      void editor.destroy().catch(() => undefined);
    } catch {
      // Crepe cleanup must not block a newer mode transition.
    }
  };

  const leaveCurrentVisual = (): void => {
    const editor = visualEditor;
    const wasDirty = visualDirty;
    const serialized = visualSerialized;
    visualEditor = undefined;
    entering = false;
    visualDirty = false;
    visualSerialized = "";

    if (editor === undefined) return;

    if (wasDirty && options.source.value === serialized) {
      const markdown = editor.getMarkdown();
      if (markdown !== options.source.value) {
        options.source.value = markdown;
        options.onDocumentChange(markdown);
      }
    }
    destroyEditor(editor);
  };

  const transitionToSource = (): void => {
    const currentTransition = ++transition;
    leaveCurrentVisual();
    if (currentTransition === transition) setMode("source");
  };

  const enterSource = async (): Promise<void> => {
    transitionToSource();
  };

  const leaveVisual = async (): Promise<void> => {
    transitionToSource();
  };

  const enterVisual = async (): Promise<void> => {
    if (mode === "visual" || entering) return;

    const currentTransition = ++transition;
    const visualSourceSnapshot = options.source.value;
    entering = true;
    visualDirty = false;
    visualSerialized = visualSourceSnapshot;
    let editor: Crepe | undefined;

    try {
      const { Crepe } = await import("@milkdown/crepe");
      if (currentTransition !== transition) return;
      if (options.source.value !== visualSourceSnapshot) {
        entering = false;
        visualSerialized = "";
        setMode("source");
        return;
      }

      const createdEditor = new Crepe({ root: options.visualRoot, defaultValue: visualSourceSnapshot });
      editor = createdEditor;
      createdEditor.editor.config((ctx) => {
        ctx.update(prosePluginsCtx, (plugins) =>
          plugins.concat(
            new Plugin({
              view: () => ({
                update: (view, previous) => {
                  if (view.state.doc === previous.doc || visualEditor !== createdEditor || entering) return;
                  visualDirty = true;
                  const markdown = createdEditor.getMarkdown();
                  visualSerialized = markdown;
                  options.source.value = markdown;
                  options.onDocumentChange(markdown);
                },
              }),
            }),
          ),
        );
      });
      visualEditor = createdEditor;
      await createdEditor.create();

      if (currentTransition !== transition || visualEditor !== createdEditor) return;
      if (options.source.value !== visualSourceSnapshot && !visualDirty) {
        visualEditor = undefined;
        entering = false;
        visualSerialized = "";
        destroyEditor(createdEditor);
        setMode("source");
        return;
      }

      entering = false;
      setMode("visual");
    } catch (error) {
      if (currentTransition !== transition) return;
      if (visualEditor === editor) visualEditor = undefined;
      entering = false;
      visualDirty = false;
      visualSerialized = "";
      if (editor !== undefined) destroyEditor(editor);
      setMode("source");
      options.onVisualError?.({
        message: error instanceof Error ? error.message : "Unable to start visual editor",
        retry: enterVisual,
      });
    }
  };

  const enterPreview = async (): Promise<void> => {
    const currentTransition = ++transition;
    leaveCurrentVisual();
    if (currentTransition !== transition) return;
    setMode("source");
    if (currentTransition !== transition) return;

    try {
      const [{ micromark }, { gfm, gfmHtml }] = await (options.loadPreview?.() ??
        Promise.all([import("micromark"), import("micromark-extension-gfm")]));
      if (currentTransition !== transition) return;

      const source = options.source.value;
      const html = micromark(source, {
        allowDangerousHtml: false,
        allowDangerousProtocol: false,
        extensions: [gfm()],
        htmlExtensions: [gfmHtml()],
      });
      if (currentTransition !== transition) return;
      options.onPreview?.({ source, html });
      if (currentTransition === transition) setMode("preview");
    } catch (error) {
      if (currentTransition === transition) throw error;
    }
  };

  const destroy = async (): Promise<void> => {
    transitionToSource();
  };

  return { enterSource, enterVisual, enterPreview, leaveVisual, destroy };
}
