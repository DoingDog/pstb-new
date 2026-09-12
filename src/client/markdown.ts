import type { Crepe } from "@milkdown/crepe";

export type MarkdownMode = "source" | "visual" | "preview";

export interface MarkdownPreview {
  source: string;
  html: string;
}

export interface MarkdownModesOptions {
  source: Pick<HTMLTextAreaElement, "value">;
  visualRoot: Node;
  onDocumentChange(markdown: string): void;
  onModeChange?(mode: MarkdownMode): void;
  onPreview?(preview: MarkdownPreview): void;
  onVisualError?(error: { message: string; retry(): Promise<void> }): void;
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
  let visualSourceSnapshot = "";
  let visualDirty = false;
  let attempt = 0;
  let entering = false;

  const setMode = (next: MarkdownMode): void => {
    mode = next;
    options.onModeChange?.(next);
  };

  const commitVisualDocument = (editor: Crepe): void => {
    if (visualEditor !== editor) return;
    visualDirty = true;
    const markdown = editor.getMarkdown();
    options.source.value = markdown;
    options.onDocumentChange(markdown);
  };

  const leaveVisual = async (): Promise<void> => {
    const editor = visualEditor;
    const sourceSnapshot = visualSourceSnapshot;
    const wasDirty = visualDirty;
    attempt += 1;
    entering = false;
    visualEditor = undefined;
    visualDirty = false;

    if (editor !== undefined) {
      if (wasDirty) {
        const markdown = editor.getMarkdown();
        if (markdown !== options.source.value) {
          options.source.value = markdown;
          options.onDocumentChange(markdown);
        }
      } else {
        options.source.value = sourceSnapshot;
      }
      await editor.destroy();
    }

    setMode("source");
  };

  const enterVisual = async (): Promise<void> => {
    if (mode === "visual" || entering) return;

    const currentAttempt = ++attempt;
    entering = true;
    visualSourceSnapshot = options.source.value;
    visualDirty = false;

    try {
      const { Crepe } = await import("@milkdown/crepe");
      if (currentAttempt !== attempt) return;

      const editor = new Crepe({ root: options.visualRoot, defaultValue: visualSourceSnapshot });
      editor.on((listener) => {
        listener.markdownUpdated(() => commitVisualDocument(editor));
      });
      visualEditor = editor;
      await editor.create();

      if (currentAttempt !== attempt || visualEditor !== editor) {
        await editor.destroy();
        return;
      }

      entering = false;
      setMode("visual");
    } catch (error) {
      if (currentAttempt !== attempt) return;
      const editor = visualEditor;
      visualEditor = undefined;
      entering = false;
      visualDirty = false;
      options.source.value = visualSourceSnapshot;
      if (editor !== undefined) await editor.destroy();
      setMode("source");
      options.onVisualError?.({
        message: error instanceof Error ? error.message : "Unable to start visual editor",
        retry: enterVisual,
      });
    }
  };

  const enterSource = async (): Promise<void> => {
    if (visualEditor !== undefined || entering) {
      await leaveVisual();
      return;
    }
    setMode("source");
  };

  const enterPreview = async (): Promise<void> => {
    await enterSource();
    const source = options.source.value;
    const [{ micromark }, { gfm, gfmHtml }] = await Promise.all([
      import("micromark"),
      import("micromark-extension-gfm"),
    ]);
    const html = micromark(source, {
      allowDangerousHtml: false,
      allowDangerousProtocol: false,
      extensions: [gfm()],
      htmlExtensions: [gfmHtml()],
    });
    options.onPreview?.({ source, html });
    setMode("preview");
  };

  const destroy = async (): Promise<void> => {
    await leaveVisual();
  };

  return { enterSource, enterVisual, enterPreview, leaveVisual, destroy };
}
