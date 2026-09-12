import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const crepe = vi.hoisted(() => {
  interface FakeEditorView {
    state: { doc: object };
  }

  interface FakeDocumentPlugin {
    spec: {
      view?(view: FakeEditorView): { update?(view: FakeEditorView, previous: FakeEditorView["state"]): void };
    };
  }

  const state = {
    failCreate: false,
    createWait: undefined as Promise<void> | undefined,
    destroyWait: undefined as Promise<void> | undefined,
    onCreate: undefined as (() => void) | undefined,
    instances: [] as FakeCrepe[],
  };

  class FakeCrepe {
    markdown: string;
    getMarkdownCalls = 0;
    destroyed = false;
    private doc = {};
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

    constructor(options: { defaultValue?: string }) {
      this.markdown = options.defaultValue ?? "";
      state.instances.push(this);
    }

    on(register: (listener: { markdownUpdated(callback: () => void): void }) => void): this {
      register({ markdownUpdated: (callback) => this.markdownUpdated.push(callback) });
      return this;
    }

    async create(): Promise<void> {
      state.onCreate?.();
      if (state.createWait !== undefined) await state.createWait;
      if (state.failCreate) throw new Error("Crepe failed to initialize");
      this.documentView = this.documentPlugin?.spec.view?.({ state: { doc: this.doc } });
    }

    async destroy(): Promise<void> {
      this.destroyed = true;
      if (state.destroyWait !== undefined) await state.destroyWait;
    }

    getMarkdown(): string {
      this.getMarkdownCalls += 1;
      return this.markdown;
    }

    documentChanged(markdown: string): void {
      const previous = { doc: this.doc };
      this.markdown = markdown;
      this.doc = {};
      this.documentView?.update?.({ state: { doc: this.doc } }, previous);
      if (this.markdownUpdated.length > 0) {
        setTimeout(() => this.markdownUpdated.forEach((callback) => callback()), 1_000);
      }
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

function fixture() {
  const source = { value: "# exact\n\nspace  \n" } as HTMLTextAreaElement;
  const onDocumentChange = vi.fn();
  const onPreview = vi.fn();
  const onVisualError = vi.fn();
  const onModeChange = vi.fn();
  const modes = createMarkdownModes({
    source,
    visualRoot: {} as Node,
    onDocumentChange,
    onPreview,
    onVisualError,
    onModeChange,
  });
  return { source, onDocumentChange, onPreview, onVisualError, onModeChange, modes };
}

beforeEach(() => {
  crepe.state.failCreate = false;
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
      visualRoot: {} as Node,
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

  it("notifies autosave at the edit instead of 1,000 ms later", async () => {
    vi.useFakeTimers();
    const { onDocumentChange, modes } = fixture();

    await modes.enterVisual();
    crepe.state.instances[0]!.documentChanged("# saved at edit\n");

    expect(onDocumentChange).toHaveBeenCalledWith("# saved at edit\n");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onDocumentChange).toHaveBeenCalledTimes(1);
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

  it("settles a failed initialization without awaiting a hanging cleanup", async () => {
    const { source, onModeChange, onVisualError, modes } = fixture();
    const editedDuringInitialization = "# source edit during initialization\n";
    crepe.state.failCreate = true;
    crepe.state.destroyWait = new Promise<void>(() => {});
    crepe.state.onCreate = () => {
      source.value = editedDuringInitialization;
    };

    const outcome = await Promise.race([
      modes.enterVisual().then(() => "settled" as const),
      new Promise<"timed out">((resolve) => setTimeout(() => resolve("timed out"), 0)),
    ]);

    expect(outcome).toBe("settled");
    expect(source.value).toBe(editedDuringInitialization);
    expect(crepe.state.instances[0]!.destroyed).toBe(true);
    expect(onModeChange).toHaveBeenLastCalledWith("source");
    expect(onVisualError).toHaveBeenCalledTimes(1);

    crepe.state.failCreate = false;
    crepe.state.destroyWait = undefined;
    crepe.state.onCreate = undefined;
    await onVisualError.mock.calls[0]![0].retry();

    expect(crepe.state.instances[1]!.markdown).toBe(editedDuringInitialization);
    expect(onModeChange).toHaveBeenLastCalledWith("visual");
  });

  it("keeps source edits when destroy cancels initialization", async () => {
    const { source, onDocumentChange, onModeChange, modes } = fixture();
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
    await modes.destroy();
    releaseCreate();
    await pendingVisual;

    expect(source.value).toBe("# source edit before destroy\n");
    expect(onDocumentChange).not.toHaveBeenCalled();
    expect(onModeChange).toHaveBeenLastCalledWith("source");
  });
});
