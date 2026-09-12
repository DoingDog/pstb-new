import { afterEach, describe, expect, it, vi } from "vitest";

const visual = vi.hoisted(() => {
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

  const fakeDocument = (markdown: string): FakeDoc => ({
    markdown,
    eq(other) {
      return markdown === other.markdown;
    },
  });

  const state = { instances: [] as FakeCrepe[] };

  class FakeCrepe {
    markdown = "";
    private doc = fakeDocument("");
    private documentPlugin: FakeDocumentPlugin | undefined;
    private documentView: ReturnType<NonNullable<FakeDocumentPlugin["spec"]["view"]>> | undefined;
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
      this.doc = fakeDocument(this.markdown);
      state.instances.push(this);
    }

    async create(): Promise<void> {
      this.documentView = this.documentPlugin?.spec.view?.({ state: { doc: this.doc } });
    }
    async destroy(): Promise<void> {}
    getMarkdown(): string {
      return this.markdown;
    }

    documentChanged(markdown: string): void {
      const previous = { doc: this.doc };
      this.markdown = markdown;
      this.doc = fakeDocument(markdown);
      this.documentView?.update?.({ state: { doc: this.doc } }, previous);
    }
  }

  return { state, Crepe: FakeCrepe };
});

vi.mock("@milkdown/crepe", () => ({ Crepe: visual.Crepe }));

import * as app from "./app";
import {
  AutosaveController,
  createAutosaveMarkdownModes,
  createHistoryDiff,
  formatHistoryDiffLine,
  type AutosaveSaveRequest,
  type AutosaveSaveResult,
  type AutosaveSnapshot,
} from "./app";

const browser = app as unknown as {
  currentPastePassword(): string | null;
  setPastePassword(password: string | null): void;
  startApp(): void;
};

class FakeClock {
  private time = 0;
  private nextId = 1;
  private timers = new Map<number, { at: number; callback: () => void }>();

  now = (): number => this.time;

  setTimer = (callback: () => void, delay: number): number => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + delay, callback });
    return id;
  };

  clearTimer = (timer: unknown): void => {
    this.timers.delete(timer as number);
  };

  advance(milliseconds: number): void {
    const end = this.time + milliseconds;
    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= end)
        .sort(([leftId, left], [rightId, right]) => left.at - right.at || leftId - rightId)[0];
      if (!next) break;
      const [id, timer] = next;
      this.timers.delete(id);
      this.time = timer.at;
      timer.callback();
    }
    this.time = end;
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function saveFake() {
  const calls: AutosaveSaveRequest[] = [];
  const pending: Deferred<AutosaveSaveResult>[] = [];
  let active = 0;
  let maxActive = 0;

  return {
    calls,
    pending,
    get active(): number {
      return active;
    },
    get maxActive(): number {
      return maxActive;
    },
    save(request: AutosaveSaveRequest): Promise<AutosaveSaveResult> {
      calls.push(request);
      active += 1;
      maxActive = Math.max(maxActive, active);
      const next = deferred<AutosaveSaveResult>();
      pending.push(next);
      return next.promise.finally(() => {
        active -= 1;
      });
    },
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await Promise.resolve();
  }
}

function setup(getPassword?: () => string | null) {
  const clock = new FakeClock();
  const save = saveFake();
  const states: AutosaveSnapshot[] = [];
  const controller = new AutosaveController({
    content: "first",
    version: "g.1",
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    save: save.save,
    ...(getPassword === undefined ? {} : { getPassword }),
    onStateChange: (snapshot) => states.push(snapshot),
  });
  return { clock, controller, save, states };
}

function lastState(states: AutosaveSnapshot[]): AutosaveSnapshot {
  const state = states.at(-1);
  if (!state) throw new Error("expected an autosave state");
  return state;
}

afterEach(() => {
  vi.unstubAllGlobals();
  browser.setPastePassword?.(null);
});

describe("AutosaveController", () => {
  it("replaces the timer and waits exactly 1,000 ms for the latest input", () => {
    const { clock, controller, save } = setup();

    controller.input("second");
    clock.advance(999);
    expect(save.calls).toEqual([]);

    controller.input("third");
    clock.advance(999);
    expect(save.calls).toEqual([]);
    clock.advance(1);
    expect(save.calls).toEqual([{ content: "third", version: "g.1" }]);
  });

  it("suppresses intermediate IME input until 1,000 ms after composition ends", () => {
    const { clock, controller, save } = setup();

    controller.input("pending");
    clock.advance(500);
    controller.compositionStart();
    controller.input("zhong");
    clock.advance(1_000);
    expect(save.calls).toEqual([]);

    controller.compositionEnd("最终");
    clock.advance(999);
    expect(save.calls).toEqual([]);
    clock.advance(1);
    expect(save.calls).toEqual([{ content: "最终", version: "g.1" }]);
  });

  it("reports a composition edit as waiting until its post-composition debounce completes", () => {
    const { clock, controller, save, states } = setup();

    controller.compositionStart();
    controller.input("zhong");
    expect(lastState(states)).toMatchObject({
      state: "waiting",
      draft: "zhong",
      lastSavedContent: "first",
      lastInputAt: null,
      dueAt: null,
      inFlightContent: null,
    });

    clock.advance(500);
    expect(save.calls).toEqual([]);
    controller.compositionEnd("最终");
    clock.advance(999);
    expect(save.calls).toEqual([]);
    clock.advance(1);
    expect(save.calls).toEqual([{ content: "最终", version: "g.1" }]);
  });

  it("keeps one request in flight and coalesces to the latest overdue draft", async () => {
    const { clock, controller, save } = setup();

    controller.input("second");
    clock.advance(1_000);
    controller.input("third");
    clock.advance(1_000);
    expect(save.calls).toEqual([{ content: "second", version: "g.1" }]);
    expect(save.maxActive).toBe(1);

    save.pending[0]!.resolve({ status: 200, changed: true, paste: { version: "g.2" } });
    await settle();
    clock.advance(0);
    expect(save.calls).toEqual([
      { content: "second", version: "g.1" },
      { content: "third", version: "g.2" },
    ]);
    expect(save.maxActive).toBe(1);
  });

  it("avoids client-known no-ops and accepts both changed and server no-op 200 responses", async () => {
    const { clock, controller, save, states } = setup();

    controller.input("first");
    clock.advance(1_000);
    expect(save.calls).toEqual([]);
    expect(lastState(states)).toMatchObject({
      state: "saved",
      draft: "first",
      lastSavedContent: "first",
      version: "g.1",
    });

    controller.input("second");
    clock.advance(1_000);
    save.pending[0]!.resolve({ status: 200, changed: false, paste: { version: "g.2" } });
    await settle();
    expect(lastState(states)).toMatchObject({
      state: "saved",
      draft: "second",
      lastSavedContent: "second",
      version: "g.2",
    });
  });

  it.each([413, 422, 500, 503])("preserves the exact draft and confirmed version after HTTP %i", async (status) => {
    const { clock, controller, save, states } = setup();

    controller.input("exact draft\nwith whitespace  ");
    clock.advance(1_000);
    save.pending[0]!.resolve({ status });
    await settle();

    expect(lastState(states)).toMatchObject({
      state: "error",
      failureStatus: status,
      draft: "exact draft\nwith whitespace  ",
      lastSavedContent: "first",
      version: "g.1",
    });
    clock.advance(10_000);
    expect(save.calls).toHaveLength(1);
  });

  it("preserves the exact draft and confirmed version after a network failure", async () => {
    const { clock, controller, save, states } = setup();

    controller.input("exact draft\nwith whitespace  ");
    clock.advance(1_000);
    save.pending[0]!.reject(new TypeError("network"));
    await settle();

    expect(lastState(states)).toMatchObject({
      state: "error",
      failureStatus: null,
      draft: "exact draft\nwith whitespace  ",
      lastSavedContent: "first",
      version: "g.1",
    });
  });

  it("retries a network failure only after an explicit retry", async () => {
    const { clock, controller, save, states } = setup();

    controller.input("exact draft");
    clock.advance(1_000);
    save.pending[0]!.reject(new TypeError("network"));
    await settle();
    controller.retry();
    expect(save.calls).toEqual([
      { content: "exact draft", version: "g.1" },
      { content: "exact draft", version: "g.1" },
    ]);

    save.pending[1]!.resolve({ status: 200, changed: true, paste: { version: "g.2" } });
    await settle();
    expect(lastState(states)).toMatchObject({ state: "saved", draft: "exact draft", lastSavedContent: "exact draft", version: "g.2" });
  });

  it("requires explicit retry after 403 and reads the re-entered password", async () => {
    let password: string | null = "old password";
    const { clock, controller, save, states } = setup(() => password);

    controller.input("exact draft");
    clock.advance(1_000);
    expect(save.calls).toEqual([{ content: "exact draft", version: "g.1", password: "old password" }]);
    save.pending[0]!.resolve({ status: 403 });
    await settle();
    expect(lastState(states)).toMatchObject({
      state: "error",
      failureStatus: 403,
      draft: "exact draft",
      lastSavedContent: "first",
      version: "g.1",
    });

    controller.input("latest draft");
    clock.advance(1_000);
    expect(save.calls).toHaveLength(1);

    password = "new password";
    controller.retry();
    expect(save.calls).toEqual([
      { content: "exact draft", version: "g.1", password: "old password" },
      { content: "latest draft", version: "g.1", password: "new password" },
    ]);
  });

  it("keeps the local draft terminal after 404", async () => {
    const { clock, controller, save, states } = setup();

    controller.input("exact draft");
    clock.advance(1_000);
    save.pending[0]!.resolve({ status: 404 });
    await settle();
    controller.input("later local edit");
    controller.retry();
    clock.advance(10_000);

    expect(save.calls).toHaveLength(1);
    expect(lastState(states)).toMatchObject({
      state: "error",
      failureStatus: 404,
      draft: "later local edit",
      lastSavedContent: "first",
      version: "g.1",
    });
  });

  it("enters conflict without changing the draft or confirmed version", async () => {
    const { clock, controller, save, states } = setup();

    controller.input("stale draft");
    clock.advance(1_000);
    save.pending[0]!.resolve({ status: 409 });
    await settle();
    controller.input("newer local draft");
    clock.advance(10_000);

    expect(save.calls).toHaveLength(1);
    expect(lastState(states)).toMatchObject({
      state: "conflict",
      failureStatus: 409,
      draft: "newer local draft",
      lastSavedContent: "first",
      version: "g.1",
    });
  });

  it("overwrites a conflict with the latest draft and omits version", async () => {
    const { clock, controller, save, states } = setup();

    controller.input("stale draft");
    clock.advance(1_000);
    save.pending[0]!.resolve({ status: 409 });
    await settle();
    controller.input("newer local draft");
    controller.overwrite();
    expect(save.calls).toEqual([
      { content: "stale draft", version: "g.1" },
      { content: "newer local draft" },
    ]);

    save.pending[1]!.resolve({ status: 200, changed: true, paste: { version: "g.3" } });
    await settle();
    expect(lastState(states)).toMatchObject({
      state: "saved",
      draft: "newer local draft",
      lastSavedContent: "newer local draft",
      version: "g.3",
    });
  });

  it("overwrites a conflicted in-flight edit after reverting to confirmed content", async () => {
    const { clock, controller, save, states } = setup();

    controller.input("in-flight draft B");
    clock.advance(1_000);
    controller.input("first");
    save.pending[0]!.resolve({ status: 409 });
    await settle();
    expect(lastState(states)).toMatchObject({
      state: "conflict",
      draft: "first",
      lastSavedContent: "first",
      inFlightContent: null,
    });

    controller.overwrite();

    expect(save.calls).toEqual([
      { content: "in-flight draft B", version: "g.1" },
      { content: "first" },
    ]);
  });

  it("reloads confirmed server content only from an explicit conflict action", async () => {
    const { clock, controller, save, states } = setup();

    controller.input("stale draft");
    clock.advance(1_000);
    save.pending[0]!.resolve({ status: 409 });
    await settle();
    controller.reload("server content", "g.9");

    expect(lastState(states)).toMatchObject({
      state: "clean",
      draft: "server content",
      lastSavedContent: "server content",
      version: "g.9",
      inFlightContent: null,
      dirtyWhileSaving: false,
    });
    clock.advance(10_000);
    expect(save.calls).toHaveLength(1);
  });

  it("removes the pending timer and ignores later work after dispose", () => {
    const { clock, controller, save } = setup();

    controller.input("second");
    controller.dispose();
    clock.advance(1_000);
    controller.input("third");
    clock.advance(1_000);

    expect(save.calls).toEqual([]);
  });

  it("registers beforeunload only while dirty or saving", async () => {
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    vi.stubGlobal("document", {});
    vi.stubGlobal("addEventListener", addEventListener);
    vi.stubGlobal("removeEventListener", removeEventListener);
    const { clock, controller, save } = setup();

    expect(addEventListener).not.toHaveBeenCalled();
    controller.input("second");
    expect(addEventListener).toHaveBeenCalledTimes(1);
    clock.advance(1_000);
    expect(addEventListener).toHaveBeenCalledTimes(1);

    save.pending[0]!.resolve({ status: 200, changed: true, paste: { version: "g.2" } });
    await settle();
    expect(removeEventListener).toHaveBeenCalledTimes(1);
  });

  it("never exceeds one active request across 200 generated inputs and saves the final draft", async () => {
    const { clock, controller, save, states } = setup();

    controller.input("0");
    clock.advance(1_000);
    for (let index = 1; index < 200; index += 1) {
      controller.input(String(index));
      clock.advance(1);
    }
    expect(save.maxActive).toBe(1);
    expect(save.calls).toHaveLength(1);

    save.pending[0]!.resolve({ status: 200, changed: true, paste: { version: "g.2" } });
    await settle();
    clock.advance(1_000);
    expect(save.calls.at(-1)).toEqual({ content: "199", version: "g.2" });
    expect(save.maxActive).toBe(1);

    save.pending[1]!.resolve({ status: 200, changed: true, paste: { version: "g.3" } });
    await settle();
    expect(save.active).toBe(0);
    expect(lastState(states)).toMatchObject({ state: "saved", draft: "199", lastSavedContent: "199", version: "g.3" });
  });
});

describe("browser document state", () => {
  it("keeps password only in the current document and rewrites its unique URL query", () => {
    const replaceState = vi.fn();
    const localStorage = { setItem: vi.fn() };
    const sessionStorage = { setItem: vi.fn() };
    vi.stubGlobal("document", {});
    vi.stubGlobal("location", { href: "https://paste.example/a?keep=yes&password=old+password" });
    vi.stubGlobal("history", { state: { current: true }, replaceState });
    vi.stubGlobal("localStorage", localStorage);
    vi.stubGlobal("sessionStorage", sessionStorage);

    browser.startApp();
    expect(browser.currentPastePassword()).toBe("old password");

    browser.setPastePassword("new +%&#?");
    expect(browser.currentPastePassword()).toBe("new +%&#?");
    const withPassword = new URL(String(replaceState.mock.calls[0]![2]));
    expect(withPassword.searchParams.getAll("password")).toEqual(["new +%&#?"]);
    expect(withPassword.searchParams.get("keep")).toBe("yes");

    browser.setPastePassword(null);
    const withoutPassword = new URL(String(replaceState.mock.calls[1]![2]));
    expect(withoutPassword.searchParams.has("password")).toBe(false);
    expect(withoutPassword.searchParams.get("keep")).toBe("yes");
    expect(localStorage.setItem).not.toHaveBeenCalled();
    expect(sessionStorage.setItem).not.toHaveBeenCalled();
  });
});

describe("Markdown and history integration", () => {
  it("does not autosave a visual mode switch but saves one serialized document edit after 1,000 ms", () => {
    const { clock, controller, save } = setup();
    visual.state.instances.length = 0;
    const source = { value: "first" } as HTMLTextAreaElement;
    const modes = createAutosaveMarkdownModes({
      autosave: controller,
      source,
      visualRoot: { childNodes: [], removeChild: vi.fn() } as unknown as Node,
    });

    return modes.enterVisual().then(async () => {
      await modes.enterSource();
      clock.advance(1_000);
      expect(save.calls).toEqual([]);

      await modes.enterVisual();
      visual.state.instances.at(-1)!.documentChanged("second");
      clock.advance(999);
      expect(save.calls).toEqual([]);
      clock.advance(1);
      expect(save.calls).toEqual([{ content: "second", version: "g.1" }]);
      await modes.destroy();
    });
  });

  it("formats diff prefixes as text without constructing HTML", () => {
    expect(formatHistoryDiffLine({ kind: "same", text: "unchanged\n" })).toBe(" unchanged\n");
    expect(formatHistoryDiffLine({ kind: "delete", text: "<script>old</script>\n" })).toBe("-<script>old</script>\n");
    expect(formatHistoryDiffLine({ kind: "add", text: "<img src=x>\n" })).toBe("+<img src=x>\n");
  });

  it("creates the diff worker only for a selected revision and ignores stale text responses", () => {
    const workers: Array<{
      postMessage: ReturnType<typeof vi.fn>;
      terminate: ReturnType<typeof vi.fn>;
      onmessage: ((event: MessageEvent<unknown>) => void) | null;
      onerror: ((event: ErrorEvent) => void) | null;
    }> = [];
    const onLines = vi.fn();
    const history = createHistoryDiff({
      createWorker: () => {
        const worker = { postMessage: vi.fn(), terminate: vi.fn(), onmessage: null, onerror: null };
        workers.push(worker);
        return worker;
      },
      onLines,
    });

    expect(history.selectRevision("1", "a\nb\n", "a\nc\n")).toBe("automatic");
    expect(workers).toHaveLength(1);
    expect(history.selectRevision("2", "old\n", "<img src=x>\n")).toBe("automatic");

    workers[0]!.onmessage?.({
      data: { type: "result", id: 1, lines: [{ kind: "same", text: "stale\n" }] },
    } as MessageEvent<unknown>);
    expect(onLines).not.toHaveBeenCalled();

    workers[0]!.onmessage?.({
      data: { type: "result", id: 2, lines: [{ kind: "add", text: "<img src=x>\n" }] },
    } as MessageEvent<unknown>);
    expect(onLines).toHaveBeenCalledWith([{ kind: "add", text: "<img src=x>\n" }]);

    history.destroy();
    expect(workers[0]!.terminate).toHaveBeenCalledOnce();
  });

  it("requires explicit diff calculation when either side exceeds the automatic policy", () => {
    const createWorker = vi.fn();
    const history = createHistoryDiff({ createWorker, onLines: vi.fn() });

    expect(history.selectRevision("1", "x".repeat(1_048_577), "current")).toBe("manual");
    expect(createWorker).not.toHaveBeenCalled();
  });
});
