import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const crepe = vi.hoisted(() => {
  interface FakeDoc {
    markdown: string;
    eq(other: FakeDoc): boolean;
  }

  interface FakeEditorView {
    state: { doc: FakeDoc };
  }

  interface FakeDocumentPlugin {
    spec: {
      view?(view: FakeEditorView): { update?(view: FakeEditorView, previous: FakeEditorView["state"]): void };
    };
  }

  interface FakeVisualRoot {
    childNodes: Node[];
    appendChild(child: Node): Node;
    removeChild(child: Node): Node;
  }

  const fakeDocument = (markdown: string): FakeDoc => ({
    markdown,
    eq(other) {
      return markdown === other.markdown;
    },
  });

  const state = {
    failCreate: false,
    failDestroy: false,
    failGetMarkdown: false,
    preserveRootOnDestroy: false,
    createWait: undefined as Promise<void> | undefined,
    destroyWait: undefined as Promise<void> | undefined,
    onCreate: undefined as (() => void) | undefined,
    instances: [] as FakeCrepe[],
  };

  class FakeCrepe {
    markdown: string;
    getMarkdownCalls = 0;
    destroyed = false;
    private doc: FakeDoc;
    private readonly root: FakeVisualRoot;
    private readonly rootNode = {} as Node;
    private documentPlugin: FakeDocumentPlugin | undefined;
    private documentView: ReturnType<NonNullable<FakeDocumentPlugin["spec"]["view"]>> | undefined;
    private readonly markdownUpdated: Array<() => void> = [];
    readonly editor = {
      config: (configure: (ctx: { update(key: unknown, update: (plugins: FakeDocumentPlugin[]) => FakeDocumentPlugin[]): void }) => void): void => {
        configure({
          update: (_key, update) => {
            this.documentPlugin = update([]).at(-1);
          },
        });
      },
    };

    constructor(options: { root: Node; defaultValue?: string }) {
      this.markdown = options.defaultValue ?? "";
      this.doc = fakeDocument(this.markdown);
      this.root = options.root as unknown as FakeVisualRoot;
      this.root.appendChild(this.rootNode);
      state.instances.push(this);
    }

    on(register: (listener: { markdownUpdated(callback: () => void): void }) => void): this {
      register({ markdownUpdated: (callback) => this.markdownUpdated.push(callback) });
      return this;
    }

    async create(): Promise<void> {
      this.documentView = this.documentPlugin?.spec.view?.({ state: { doc: this.doc } });
      state.onCreate?.();
      if (state.createWait !== undefined) await state.createWait;
      if (state.failCreate) throw new Error("Crepe failed to initialize");
    }

    async destroy(): Promise<void> {
      this.destroyed = true;
      if (state.destroyWait !== undefined) await state.destroyWait;
      if (state.failDestroy) throw new Error("Crepe failed to clean up");
      if (!state.preserveRootOnDestroy) this.root.removeChild(this.rootNode);
    }

    getMarkdown(): string {
      this.getMarkdownCalls += 1;
      if (state.failGetMarkdown) throw new Error("Crepe failed to serialize");
      return this.markdown;
    }

    documentChanged(markdown: string): void {
      const previous = { doc: this.doc };
      this.markdown = markdown;
      this.doc = fakeDocument(markdown);
      this.documentView?.update?.({ state: { doc: this.doc } }, previous);
      if (this.markdownUpdated.length > 0) {
        setTimeout(() => this.markdownUpdated.forEach((callback) => callback()), 1_000);
      }
    }

    documentStateReplaced(): void {
      const previous = { doc: this.doc };
      this.doc = fakeDocument(this.markdown);
      this.documentView?.update?.({ state: { doc: this.doc } }, previous);
    }

    appendLateNode(): Node {
      const node = {} as Node;
      this.root.appendChild(node);
      return node;
    }
  }

  return { state, Crepe: FakeCrepe };
});

const preview = vi.hoisted(() => ({
  micromark: vi.fn((source: string) => `<p>${source}</p>`),
  gfm: vi.fn(() => "gfm-extension"),
  gfmHtml: vi.fn(() => "gfm-html-extension"),
}));

vi.mock("@milkdown/crepe", () => ({ Crepe: crepe.Crepe }));
vi.mock("micromark", () => ({ micromark: preview.micromark }));
vi.mock("micromark-extension-gfm", () => ({ gfm: preview.gfm, gfmHtml: preview.gfmHtml }));

import { createMarkdownModes } from "./markdown";

type FakeVisualRoot = Node & {
  childNodes: Node[];
  ownerDocument: Pick<Document, "createElement">;
  appendChild(child: Node): Node;
  removeChild(child: Node): Node;
};

function createVisualRoot(): FakeVisualRoot {
  const childNodes: Node[] = [];
  const ownerDocument = {
    createElement: () => createVisualRoot() as unknown as HTMLElement,
  } as Pick<Document, "createElement">;
  return {
    childNodes,
    ownerDocument,
    appendChild(child: Node) {
      childNodes.push(child);
      return child;
    },
    removeChild(child: Node) {
      const index = childNodes.indexOf(child);
      if (index < 0) throw new Error("missing child");
      childNodes.splice(index, 1);
      return child;
    },
  } as FakeVisualRoot;
}

function fixture() {
  const source = { value: "# exact\n\nspace  \n" } as HTMLTextAreaElement;
  const visualRoot = createVisualRoot();
  const onDocumentChange = vi.fn();
  const onPreview = vi.fn();
  const onVisualError = vi.fn();
  const onModeChange = vi.fn();
  const modes = createMarkdownModes({
    source,
    visualRoot,
    onDocumentChange,
    onPreview,
    onVisualError,
    onModeChange,
  });
  return { source, visualRoot, onDocumentChange, onPreview, onVisualError, onModeChange, modes };
}

beforeEach(() => {
  crepe.state.failCreate = false;
  crepe.state.failDestroy = false;
  crepe.state.failGetMarkdown = false;
  crepe.state.preserveRootOnDestroy = false;
  crepe.state.createWait = undefined;
  crepe.state.destroyWait = undefined;
  crepe.state.onCreate = undefined;
  crepe.state.instances.length = 0;
  preview.micromark.mockClear();
  preview.gfm.mockClear();
  preview.gfmHtml.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createMarkdownModes", () => {
  it("ignores a stale preview import after newer source and visual transitions", async () => {
    const { source, onDocumentChange, onModeChange, onPreview } = fixture();
    const exact = source.value;
    let releaseImport!: () => void;
    let markImportStarted!: () => void;
    const importStarted = new Promise<void>((resolve) => {
      markImportStarted = resolve;
    });
    const importWait = new Promise<void>((resolve) => {
      releaseImport = resolve;
    });
    const modes = createMarkdownModes({
      source,
      visualRoot: createVisualRoot(),
      onDocumentChange,
      onModeChange,
      onPreview,
      loadPreview: async () => {
        markImportStarted();
        await importWait;
        return [
          { micromark: preview.micromark as unknown as typeof import("micromark").micromark },
          {
            gfm: preview.gfm as unknown as typeof import("micromark-extension-gfm").gfm,
            gfmHtml: preview.gfmHtml as unknown as typeof import("micromark-extension-gfm").gfmHtml,
          },
        ];
      },
    });

    const pendingPreview = modes.enterPreview();
    const importOutcome = await Promise.race([
      importStarted.then(() => "started" as const),
      new Promise<"not started">((resolve) => setTimeout(() => resolve("not started"), 0)),
    ]);
    expect(importOutcome).toBe("started");
    await modes.enterSource();
    await modes.enterVisual();
    releaseImport();
    await pendingPreview;

    expect(source.value).toBe(exact);
    expect(onDocumentChange).not.toHaveBeenCalled();
    expect(onPreview).not.toHaveBeenCalled();
    expect(onModeChange).toHaveBeenLastCalledWith("visual");
  });

  it("restores byte-exact source without saving when visual mode has no document transaction", async () => {
    const { source, onDocumentChange, modes } = fixture();
    const exact = source.value;

    await modes.enterVisual();
    const editor = crepe.state.instances[0]!;
    await modes.leaveVisual();

    expect(source.value).toBe(exact);
    expect(editor.getMarkdownCalls).toBe(0);
    expect(onDocumentChange).not.toHaveBeenCalled();
  });

  it("serializes a visual edit when leaving before markdown serialization", async () => {
    vi.useFakeTimers();
    const { source, onDocumentChange, modes } = fixture();

    await modes.enterVisual();
    crepe.state.instances[0]!.documentChanged("# serialized\n");
    await modes.leaveVisual();

    expect(source.value).toBe("# serialized\n");
    expect(onDocumentChange).toHaveBeenCalledTimes(1);
    expect(onDocumentChange).toHaveBeenCalledWith("# serialized\n");
  });

  it("cleans up after dirty serialization fails and exposes a retry", async () => {
    const { source, visualRoot, onDocumentChange, onModeChange, onVisualError, modes } = fixture();
    const lastValid = "# last valid  \n\n";

    await modes.enterVisual();
    const editor = crepe.state.instances[0]!;
    editor.documentChanged(lastValid);
    crepe.state.failGetMarkdown = true;

    await expect(modes.leaveVisual()).resolves.toBeUndefined();

    expect(source.value).toBe(lastValid);
    expect(onDocumentChange).toHaveBeenCalledTimes(1);
    expect(onDocumentChange).toHaveBeenCalledWith(lastValid);
    expect(editor.destroyed).toBe(true);
    expect(visualRoot.childNodes).toEqual([]);
    expect(onModeChange).toHaveBeenLastCalledWith("source");
    expect(onVisualError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Crepe failed to serialize" }),
    );

    crepe.state.failGetMarkdown = false;
    await onVisualError.mock.calls[0]![0].retry();

    expect(crepe.state.instances).toHaveLength(2);
    expect(crepe.state.instances[0]!.destroyed).toBe(true);
    expect(crepe.state.instances[1]!.markdown).toBe(lastValid);
    expect(visualRoot.childNodes).toHaveLength(1);
    expect(onModeChange).toHaveBeenLastCalledWith("visual");
  });

  it.each([
    ["resolves", false, true],
    ["rejects", true, false],
  ])("recovers from a preview teardown serialization failure when destroy %s", async (_outcome, failDestroy, preserveRootOnDestroy) => {
    const { source, visualRoot, onDocumentChange, onModeChange, onPreview, onVisualError, modes } = fixture();
    const canonical = "# canonical visual source  \n\n";

    await modes.enterVisual();
    const editor = crepe.state.instances[0]!;
    editor.documentChanged(canonical);
    crepe.state.failGetMarkdown = true;
    crepe.state.failDestroy = failDestroy;
    crepe.state.preserveRootOnDestroy = preserveRootOnDestroy;

    await expect(modes.enterPreview()).resolves.toBeUndefined();

    expect(source.value).toBe(canonical);
    expect(onDocumentChange).toHaveBeenCalledTimes(1);
    expect(editor.destroyed).toBe(true);
    expect(visualRoot.childNodes).toEqual([]);
    expect(onPreview).not.toHaveBeenCalled();
    expect(preview.micromark).not.toHaveBeenCalled();
    expect(onModeChange).toHaveBeenLastCalledWith("source");
    expect(onVisualError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Crepe failed to serialize" }),
    );

    crepe.state.failGetMarkdown = false;
    crepe.state.failDestroy = false;
    crepe.state.preserveRootOnDestroy = false;
    await onVisualError.mock.calls[0]![0].retry();

    expect(crepe.state.instances).toHaveLength(2);
    expect(crepe.state.instances[1]!.markdown).toBe(canonical);
    expect(visualRoot.childNodes).toHaveLength(1);
    expect(onModeChange).toHaveBeenLastCalledWith("visual");
  });

  it.each([
    ["source", false],
    ["preview", true],
  ])("ignores an editor transaction after %s transition is requested", async (_mode, previewRequested) => {
    const { source, onDocumentChange, onModeChange, modes } = fixture();
    const exact = source.value;

    await modes.enterVisual();
    const editor = crepe.state.instances[0]!;
    const pendingTransition = previewRequested ? modes.enterPreview() : modes.enterSource();
    editor.documentChanged("# stale visual transaction\n");
    await pendingTransition;

    expect(source.value).toBe(exact);
    expect(onDocumentChange).not.toHaveBeenCalled();
    expect(onModeChange).toHaveBeenLastCalledWith(previewRequested ? "preview" : "source");
  });

  it("keeps the visual document and retries an edit serialization failure", async () => {
    const { source, visualRoot, onDocumentChange, onModeChange, onVisualError, modes } = fixture();
    const canonical = source.value;
    const edited = "# edited but not yet serialized\n";

    await modes.enterVisual();
    const editor = crepe.state.instances[0]!;
    crepe.state.failGetMarkdown = true;

    expect(() => editor.documentChanged(edited)).not.toThrow();
    expect(source.value).toBe(canonical);
    expect(editor.markdown).toBe(edited);
    expect(editor.destroyed).toBe(false);
    expect(crepe.state.instances).toEqual([editor]);
    expect(visualRoot.childNodes).toHaveLength(1);
    expect(onModeChange).toHaveBeenLastCalledWith("visual");
    expect(onDocumentChange).not.toHaveBeenCalled();
    expect(onVisualError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Crepe failed to serialize" }),
    );

    await onVisualError.mock.calls[0]![0].retry();

    expect(source.value).toBe(canonical);
    expect(editor.markdown).toBe(edited);
    expect(crepe.state.instances).toEqual([editor]);
    expect(onDocumentChange).not.toHaveBeenCalled();
    expect(onVisualError).toHaveBeenCalledTimes(2);

    crepe.state.failGetMarkdown = false;
    await onVisualError.mock.calls[1]![0].retry();

    expect(source.value).toBe(edited);
    expect(crepe.state.instances).toEqual([editor]);
    expect(onDocumentChange).toHaveBeenCalledTimes(1);
    expect(onDocumentChange).toHaveBeenCalledWith(edited);
  });

  it.each(["source", "preview", "destroy"])("does not publish a failed edit serialization retry after a newer %s transition", async (next) => {
    const { source, onDocumentChange, onVisualError, modes } = fixture();
    const canonical = source.value;

    await modes.enterVisual();
    const editor = crepe.state.instances[0]!;
    crepe.state.failGetMarkdown = true;
    expect(() => editor.documentChanged("# stale retry\n")).not.toThrow();
    const retry = onVisualError.mock.calls[0]![0].retry;

    await (next === "source" ? modes.enterSource() : next === "preview" ? modes.enterPreview() : modes.destroy());
    crepe.state.failGetMarkdown = false;
    await retry();

    expect(source.value).toBe(canonical);
    expect(editor.destroyed).toBe(true);
    expect(onDocumentChange).not.toHaveBeenCalled();
  });

  it("notifies autosave at the edit instead of 1,000 ms later", async () => {
    vi.useFakeTimers();
    const { onDocumentChange, modes } = fixture();

    await modes.enterVisual();
    crepe.state.instances[0]!.documentChanged("# saved at edit\n");

    expect(onDocumentChange).toHaveBeenCalledWith("# saved at edit\n");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onDocumentChange).toHaveBeenCalledTimes(1);
  });

  it("keeps a ready visual editor active after entering visual mode again", async () => {
    const { source, onDocumentChange, modes } = fixture();

    await modes.enterVisual();
    const editor = crepe.state.instances[0]!;
    await modes.enterVisual();
    editor.documentChanged("# retained after repeated entry\n");
    await modes.leaveVisual();

    expect(crepe.state.instances).toHaveLength(1);
    expect(source.value).toBe("# retained after repeated entry\n");
    expect(onDocumentChange).toHaveBeenCalledTimes(1);
    expect(onDocumentChange).toHaveBeenCalledWith("# retained after repeated entry\n");
  });

  it("ignores structurally equal ProseMirror document replacements", async () => {
    const { onDocumentChange, modes } = fixture();

    await modes.enterVisual();
    crepe.state.instances[0]!.documentStateReplaced();

    expect(onDocumentChange).not.toHaveBeenCalled();
  });

  it("renders preview from the current draft without changing it", async () => {
    const { source, onPreview, modes } = fixture();
    source.value = "| a | b |\n| - | - |\n| 1 | 2 |";

    await modes.enterPreview();

    expect(onPreview).toHaveBeenCalledWith({
      source: "| a | b |\n| - | - |\n| 1 | 2 |",
      html: "<p>| a | b |\n| - | - |\n| 1 | 2 |</p>",
    });
    expect(source.value).toBe("| a | b |\n| - | - |\n| 1 | 2 |");
    expect(preview.micromark).toHaveBeenCalledWith(source.value, {
      allowDangerousHtml: false,
      allowDangerousProtocol: false,
      extensions: ["gfm-extension"],
      htmlExtensions: ["gfm-html-extension"],
    });
  });

  it("keeps source available and exposes a retry when Crepe initialization fails", async () => {
    const { source, onVisualError, onModeChange, modes } = fixture();
    const exact = source.value;
    crepe.state.failCreate = true;

    await modes.enterVisual();

    expect(source.value).toBe(exact);
    expect(onModeChange).toHaveBeenLastCalledWith("source");
    expect(onVisualError).toHaveBeenCalledTimes(1);

    crepe.state.failCreate = false;
    await onVisualError.mock.calls[0]![0].retry();

    expect(crepe.state.instances).toHaveLength(2);
    expect(onModeChange).toHaveBeenLastCalledWith("visual");
  });

  it("ignores document updates emitted while Crepe is creating", async () => {
    const { source, onDocumentChange, onVisualError, modes } = fixture();
    const exact = source.value;
    crepe.state.failCreate = true;
    crepe.state.onCreate = () => {
      crepe.state.instances[0]!.documentChanged("# initialization noise\n");
    };

    await modes.enterVisual();

    expect(source.value).toBe(exact);
    expect(onDocumentChange).not.toHaveBeenCalled();
    expect(onVisualError).toHaveBeenCalledTimes(1);
  });

  it("settles a failed initialization without destroying an OnCreate editor", async () => {
    const { source, visualRoot, onDocumentChange, onModeChange, onVisualError, modes } = fixture();
    const preservedRootNode = {} as Node;
    const editedDuringInitialization = "# source edit during initialization\n";
    visualRoot.appendChild(preservedRootNode);
    crepe.state.failCreate = true;
    crepe.state.destroyWait = new Promise<void>(() => {});
    crepe.state.onCreate = () => {
      source.value = editedDuringInitialization;
      crepe.state.instances[0]!.documentChanged("# initialization noise\n");
    };

    const outcome = await Promise.race([
      modes.enterVisual().then(() => "settled" as const),
      new Promise<"timed out">((resolve) => setTimeout(() => resolve("timed out"), 0)),
    ]);

    expect(outcome).toBe("settled");
    expect(source.value).toBe(editedDuringInitialization);
    expect(onDocumentChange).not.toHaveBeenCalled();
    expect(crepe.state.instances[0]!.destroyed).toBe(false);
    expect(visualRoot.childNodes).toEqual([preservedRootNode]);
    expect(onModeChange).toHaveBeenLastCalledWith("source");
    expect(onVisualError).toHaveBeenCalledTimes(1);

    crepe.state.failCreate = false;
    crepe.state.destroyWait = undefined;
    crepe.state.onCreate = undefined;
    await onVisualError.mock.calls[0]![0].retry();

    expect(crepe.state.instances[1]!.markdown).toBe(editedDuringInitialization);
    expect(onModeChange).toHaveBeenLastCalledWith("visual");
  });

  it.each([
    ["resolves", false],
    ["rejects", true],
  ])("isolates a failed Crepe create root and removes its retry container when destroy %s", async (_outcome, failDestroy) => {
    const { visualRoot, onVisualError, modes } = fixture();
    const applicationNode = {} as Node;
    visualRoot.appendChild(applicationNode);
    crepe.state.failCreate = true;

    await modes.enterVisual();
    const failedEditor = crepe.state.instances[0]!;
    const lateNode = failedEditor.appendLateNode();

    expect(visualRoot.childNodes).toEqual([applicationNode]);

    crepe.state.failCreate = false;
    await onVisualError.mock.calls[0]![0].retry();

    const session = visualRoot.childNodes[1]!;
    expect(visualRoot.childNodes).toEqual([applicationNode, session]);
    expect(session.childNodes).toHaveLength(1);
    expect(session.childNodes).not.toContain(lateNode);

    crepe.state.failDestroy = failDestroy;
    await modes.enterSource();

    expect(visualRoot.childNodes).toEqual([applicationNode]);
  });

  it("waits for a stale visual creation to finish teardown before destroy settles", async () => {
    const { source, visualRoot, onDocumentChange, onModeChange, modes } = fixture();
    let releaseCreate!: () => void;
    let markCreateStarted!: () => void;
    const createStarted = new Promise<void>((resolve) => {
      markCreateStarted = resolve;
    });
    crepe.state.createWait = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    crepe.state.onCreate = markCreateStarted;

    const pendingVisual = modes.enterVisual();
    await createStarted;
    source.value = "# source edit before destroy\n";
    const destroying = modes.destroy();
    const outcome = await Promise.race([
      destroying.then(() => "settled" as const),
      new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), 0)),
    ]);
    expect(outcome).toBe("waiting");

    releaseCreate();
    await Promise.all([pendingVisual, destroying]);

    expect(source.value).toBe("# source edit before destroy\n");
    expect(crepe.state.instances[0]!.destroyed).toBe(true);
    expect(visualRoot.childNodes).toEqual([]);
    expect(onDocumentChange).not.toHaveBeenCalled();
    expect(onModeChange).toHaveBeenLastCalledWith("source");
  });

  it("waits for visual teardown before rendering preview", async () => {
    const { onPreview, modes } = fixture();
    let releaseDestroy!: () => void;
    crepe.state.destroyWait = new Promise<void>((resolve) => {
      releaseDestroy = resolve;
    });

    await modes.enterVisual();
    const pendingPreview = modes.enterPreview();
    const outcome = await Promise.race([
      pendingPreview.then(() => "settled" as const),
      new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), 0)),
    ]);
    expect(outcome).toBe("waiting");

    releaseDestroy();
    await pendingPreview;

    expect(onPreview).toHaveBeenCalledTimes(1);
  });

  it("removes only completed editor nodes after destroy rejects", async () => {
    const { visualRoot, modes } = fixture();
    const applicationNode = {} as Node;
    visualRoot.appendChild(applicationNode);

    await modes.enterVisual();
    crepe.state.failDestroy = true;
    await modes.enterSource();

    expect(crepe.state.instances[0]!.destroyed).toBe(true);
    expect(visualRoot.childNodes).toEqual([applicationNode]);

    crepe.state.failDestroy = false;
    await modes.enterVisual();

    expect(crepe.state.instances).toHaveLength(2);
    expect(visualRoot.childNodes[0]).toBe(applicationNode);
    expect(visualRoot.childNodes).toHaveLength(2);
  });

  it("waits for visual teardown before mounting a replacement editor", async () => {
    const { visualRoot, modes } = fixture();
    let releaseDestroy!: () => void;
    crepe.state.destroyWait = new Promise<void>((resolve) => {
      releaseDestroy = resolve;
    });

    await modes.enterVisual();
    const pendingSource = modes.enterSource();
    const pendingVisual = modes.enterVisual();
    const sourceOutcome = await Promise.race([
      pendingSource.then(() => "settled" as const),
      new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), 0)),
    ]);
    expect(sourceOutcome).toBe("waiting");
    const visualOutcome = await Promise.race([
      pendingVisual.then(() => "settled" as const),
      new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), 0)),
    ]);
    expect(visualOutcome).toBe("waiting");
    expect(crepe.state.instances).toHaveLength(1);
    expect(visualRoot.childNodes).toHaveLength(1);

    releaseDestroy();
    await Promise.all([pendingSource, pendingVisual]);

    expect(crepe.state.instances).toHaveLength(2);
    expect(visualRoot.childNodes).toHaveLength(1);
  });
});
