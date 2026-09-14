import { afterEach, describe, expect, it, vi } from "vitest";
import type { PasteSummary } from "../types";
import {
  AutosaveController,
  createAutosaveMarkdownModes,
  type AutosaveAuthoritativeTransition,
  type AutosaveSaveRequest,
  type AutosaveSaveResult,
  type AutosaveSnapshot,
} from "./autosave";

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
  const state = { failGetMarkdown: false, instances: [] as FakeCrepe[] };

  class FakeCrepe {
    markdown = "";
    getMarkdownCalls = 0;
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
      this.getMarkdownCalls += 1;
      if (state.failGetMarkdown) throw new Error("Crepe failed to serialize");
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

function summary(overrides: Partial<PasteSummary> = {}): PasteSummary {
  return {
    id: "paste",
    title: "",
    format: "text",
    viewOnce: false,
    protected: false,
    createdAt: null,
    updatedAt: "2026-09-14T00:00:00.000Z",
    expiresAt: null,
    expiration: "never",
    version: "g.2",
    contentRevision: 1,
    contentBytes: 0,
    createdCountry: null,
    links: { view: "", raw: "", html: "", markdown: "", file: "" },
    ...overrides,
  } as PasteSummary;
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
    tryDispatch(request: AutosaveSaveRequest) {
      calls.push(request);
      active += 1;
      maxActive = Math.max(maxActive, active);
      const next = deferred<AutosaveSaveResult>();
      pending.push(next);
      return {
        kind: "started" as const,
        completion: next.promise.finally(() => {
          active -= 1;
        }),
      };
    },
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
}

function autosaveFixture(overrides: {
  tryDispatch?(request: AutosaveSaveRequest): ReturnType<ReturnType<typeof saveFake>["tryDispatch"]> | { kind: "blocked" };
  onCoalescedIntent?(): void;
  getPassword?(): string | null;
} = {}) {
  const clock = new FakeClock();
  const save = saveFake();
  const states: AutosaveSnapshot[] = [];
  const controller = new AutosaveController({
    content: "first",
    version: "g.1",
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    tryDispatch: overrides.tryDispatch ?? save.tryDispatch,
    onCoalescedIntent: overrides.onCoalescedIntent ?? (() => {}),
    ...(overrides.getPassword === undefined ? {} : { getPassword: overrides.getPassword }),
    onStateChange(snapshot) {
      expect(snapshot.acceptedSource).toBe(snapshot.lastSavedContent);
      states.push(snapshot);
    },
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
  visual.state.failGetMarkdown = false;
  visual.state.instances.length = 0;
});

describe("AutosaveController", () => {
  it("replaces the timer and waits exactly 1,000 ms for the latest input", () => {
    const { clock, controller, save } = autosaveFixture();

    controller.input("second", clock.now());
    clock.advance(999);
    expect(save.calls).toEqual([]);

    controller.input("third", clock.now());
    clock.advance(999);
    expect(save.calls).toEqual([]);
    clock.advance(1);
    expect(save.calls).toEqual([{ action: "autosave", content: "third", version: "g.1" }]);
  });

  it("anchors debounce to the supplied monotonic event instant", () => {
    const { clock, controller, save, states } = autosaveFixture();

    clock.advance(200);
    controller.input("second", 125);

    expect(lastState(states).dueAt).toBe(1_125);
    clock.advance(924);
    expect(save.calls).toEqual([]);
    clock.advance(1);
    expect(save.calls).toEqual([{ action: "autosave", content: "second", version: "g.1" }]);
  });

  it("suppresses intermediate IME input until 1,000 ms after composition ends", () => {
    const { clock, controller, save, states } = autosaveFixture();

    controller.input("pending", clock.now());
    clock.advance(500);
    controller.compositionStart();
    controller.input("zhong", clock.now());
    expect(lastState(states)).toMatchObject({
      state: "waiting",
      draft: "zhong",
      lastInputAt: 0,
      dueAt: 1_000,
      dirtyWhileSaving: false,
    });
    clock.advance(1_000);
    expect(save.calls).toEqual([]);

    controller.compositionEnd("最终", clock.now());
    clock.advance(999);
    expect(save.calls).toEqual([]);
    clock.advance(1);
    expect(save.calls).toEqual([{ action: "autosave", content: "最终", version: "g.1" }]);
  });

  it("keeps intermediate composition input from changing event fields or in-flight state", () => {
    const { clock, controller, save } = autosaveFixture();

    controller.input("second", clock.now());
    clock.advance(1_000);
    controller.compositionStart();
    controller.input("zhong", clock.now());

    expect(controller.snapshot()).toMatchObject({
      state: "saving",
      draft: "zhong",
      lastInputAt: 0,
      dueAt: null,
      inFlightContent: "second",
      dirtyWhileSaving: false,
    });
    expect(save.calls).toEqual([{ action: "autosave", content: "second", version: "g.1" }]);
  });

  it("keeps one request in flight and coalesces to the latest overdue draft", async () => {
    const { clock, controller, save } = autosaveFixture();

    controller.input("second", clock.now());
    clock.advance(1_000);
    controller.input("third", clock.now());
    clock.advance(1_000);
    expect(save.calls).toEqual([{ action: "autosave", content: "second", version: "g.1" }]);
    expect(save.maxActive).toBe(1);

    save.pending[0]!.resolve({ status: 200, changed: true, paste: summary({ version: "g.2" }) });
    await settle();
    clock.advance(0);
    expect(save.calls).toEqual([
      { action: "autosave", content: "second", version: "g.1" },
      { action: "autosave", content: "third", version: "g.2" },
    ]);
    expect(save.maxActive).toBe(1);
  });

  it("cleans a client-known no-op and retains saved only for an acknowledged matching source", async () => {
    const { clock, controller, save, states } = autosaveFixture();

    controller.input("first", clock.now());
    expect(lastState(states)).toMatchObject({ state: "clean", dueAt: null });
    clock.advance(1_000);
    expect(save.calls).toEqual([]);

    controller.input("second", clock.now());
    clock.advance(1_000);
    save.pending[0]!.resolve({ status: 200, changed: false, paste: summary({ version: "g.2" }) });
    await settle();
    expect(lastState(states)).toMatchObject({
      state: "saved",
      draft: "second",
      acceptedSource: "second",
      lastSavedContent: "second",
      version: "g.2",
    });
  });

  it.each([
    [403, "password-required", true],
    [404, "not-found", false],
    [409, "conflict", false],
    [413, "error", true],
    [422, "error", true],
  ] as const)("maps HTTP %i to %s", async (status, state, requiresExplicitRetry) => {
    const { clock, controller, save, states } = autosaveFixture();

    controller.input("exact draft", clock.now());
    clock.advance(1_000);
    save.pending[0]!.resolve({ status });
    await settle();

    expect(lastState(states)).toMatchObject({
      state,
      failureStatus: status,
      requiresExplicitRetry,
      draft: "exact draft",
      acceptedSource: "first",
      version: "g.1",
    });
  });

  it("requires explicit retry after 403 and reads the re-entered opaque password", async () => {
    let password: string | null = "old password";
    const { clock, controller, save, states } = autosaveFixture({ getPassword: () => password });

    controller.input("exact draft", clock.now());
    clock.advance(1_000);
    expect(save.calls).toEqual([{ action: "autosave", content: "exact draft", version: "g.1", password: "old password" }]);
    save.pending[0]!.resolve({ status: 403 });
    await settle();

    controller.input("latest draft", clock.now());
    clock.advance(1_000);
    expect(save.calls).toHaveLength(1);
    expect(lastState(states)).toMatchObject({ state: "password-required", requiresExplicitRetry: true });

    password = "new password";
    controller.retry();
    expect(save.calls).toEqual([
      { action: "autosave", content: "exact draft", version: "g.1", password: "old password" },
      { action: "save-retry", content: "latest draft", version: "g.1", password: "new password" },
    ]);
  });

  it.each([413, 422])("does not rearm after %i until explicit retry", async (status) => {
    const { clock, controller, save, states } = autosaveFixture();

    controller.input("invalid draft", clock.now());
    clock.advance(1_000);
    save.pending[0]!.resolve({ status });
    await settle();
    controller.input("corrected draft", clock.now());
    clock.advance(10_000);
    expect(save.calls).toHaveLength(1);
    expect(lastState(states)).toMatchObject({ state: "error", requiresExplicitRetry: true });

    controller.retry();
    expect(save.calls.at(-1)).toEqual({ action: "save-retry", content: "corrected draft", version: "g.1" });
  });

  it("leaves an uncertain mutation failure outside explicit-retry policy", async () => {
    const { clock, controller, save, states } = autosaveFixture();

    controller.input("possibly applied", clock.now());
    clock.advance(1_000);
    save.pending[0]!.resolve({ status: 413, mutationMayHaveApplied: true });
    await settle();

    expect(lastState(states)).toMatchObject({ state: "error", failureStatus: 413, requiresExplicitRetry: false });
  });

  it("preserves an uncertain network failure for page reconciliation without arming autosave", async () => {
    const { clock, controller, save, states } = autosaveFixture();

    controller.input("exact draft\nwith whitespace  ", clock.now());
    clock.advance(1_000);
    save.pending[0]!.reject(new TypeError("network"));
    await settle();
    controller.input("later local edit", clock.now());
    clock.advance(10_000);

    expect(lastState(states)).toMatchObject({
      state: "error",
      failureStatus: null,
      requiresExplicitRetry: false,
      draft: "later local edit",
      acceptedSource: "first",
      version: "g.1",
    });
    expect(save.calls).toHaveLength(1);
  });

  it("keeps the local draft terminal after 404", async () => {
    const { clock, controller, save, states } = autosaveFixture();

    controller.input("exact draft", clock.now());
    clock.advance(1_000);
    save.pending[0]!.resolve({ status: 404 });
    await settle();
    controller.input("later local edit", clock.now());
    controller.retry();
    clock.advance(10_000);

    expect(save.calls).toHaveLength(1);
    expect(lastState(states)).toMatchObject({
      state: "not-found",
      failureStatus: 404,
      requiresExplicitRetry: false,
      draft: "later local edit",
      acceptedSource: "first",
      version: "g.1",
    });
  });

  it("enters conflict without changing the draft or accepted version", async () => {
    const { clock, controller, save, states } = autosaveFixture();

    controller.input("stale draft", clock.now());
    clock.advance(1_000);
    save.pending[0]!.resolve({ status: 409 });
    await settle();
    controller.input("newer local draft", clock.now());
    clock.advance(10_000);

    expect(save.calls).toHaveLength(1);
    expect(lastState(states)).toMatchObject({
      state: "conflict",
      failureStatus: 409,
      draft: "newer local draft",
      acceptedSource: "first",
      version: "g.1",
    });
  });

  it("overwrites a conflict with the latest draft and omits version", async () => {
    const { clock, controller, save, states } = autosaveFixture();

    controller.input("stale draft", clock.now());
    clock.advance(1_000);
    save.pending[0]!.resolve({ status: 409 });
    await settle();
    controller.input("newer local draft", clock.now());
    controller.overwrite();
    expect(save.calls).toEqual([
      { action: "autosave", content: "stale draft", version: "g.1" },
      { action: "overwrite", content: "newer local draft" },
    ]);

    save.pending[1]!.resolve({ status: 200, changed: true, paste: summary({ version: "g.3" }) });
    await settle();
    expect(lastState(states)).toMatchObject({ state: "saved", acceptedSource: "newer local draft", version: "g.3" });
  });

  it("coalesces one latest source intent while the page mutation slot is occupied", () => {
    const dispatches: AutosaveSaveRequest[] = [];
    let blocked = true;
    const coalesced = vi.fn();
    const fixture = autosaveFixture({
      tryDispatch(request) {
        if (blocked) return { kind: "blocked" };
        dispatches.push(request);
        return { kind: "started", completion: Promise.resolve({ status: 200, changed: true, paste: summary({ version: "g.2" }) }) };
      },
      onCoalescedIntent: coalesced,
    });

    fixture.controller.input("latest", 0);
    fixture.clock.advance(1_000);
    expect(dispatches).toEqual([]);
    expect(coalesced).toHaveBeenCalledTimes(1);
    expect(fixture.controller.snapshot()).toMatchObject({ state: "waiting", inFlightContent: null, coalescedIntent: true });

    blocked = false;
    fixture.controller.slotAvailable();
    expect(dispatches).toEqual([{ action: "autosave", content: "latest", version: "g.1" }]);
  });

  it("restores explicit retry state without coalescing when the page slot is blocked", async () => {
    let blocked = false;
    const coalesced = vi.fn();
    const fixture = autosaveFixture({ onCoalescedIntent: coalesced });
    const original = fixture.save.tryDispatch;
    const controller = new AutosaveController({
      content: "first",
      version: "g.1",
      now: fixture.clock.now,
      setTimer: fixture.clock.setTimer,
      clearTimer: fixture.clock.clearTimer,
      tryDispatch(request) {
        return blocked ? { kind: "blocked" } : original(request);
      },
      onCoalescedIntent: coalesced,
      onStateChange() {},
    });

    controller.input("draft", 0);
    fixture.clock.advance(1_000);
    fixture.save.pending[0]!.resolve({ status: 413 });
    await settle();
    blocked = true;
    controller.retry();

    expect(controller.snapshot()).toMatchObject({ state: "error", requiresExplicitRetry: true, inFlightContent: null });
    expect(coalesced).not.toHaveBeenCalled();
  });

  it("removes the pending timer and ignores later work after dispose", () => {
    const { clock, controller, save } = autosaveFixture();

    controller.input("second", clock.now());
    controller.dispose();
    clock.advance(1_000);
    controller.input("third", clock.now());
    clock.advance(1_000);

    expect(save.calls).toEqual([]);
  });

  it("registers beforeunload only while dirty or saving", async () => {
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    vi.stubGlobal("document", {});
    vi.stubGlobal("addEventListener", addEventListener);
    vi.stubGlobal("removeEventListener", removeEventListener);
    const { clock, controller, save } = autosaveFixture();

    controller.input("second", clock.now());
    expect(addEventListener).toHaveBeenCalledTimes(1);
    clock.advance(1_000);
    save.pending[0]!.resolve({ status: 200, changed: true, paste: summary({ version: "g.2" }) });
    await settle();
    expect(removeEventListener).toHaveBeenCalledTimes(1);
  });

  it("never exceeds one active request across 200 generated inputs and saves the final draft", async () => {
    const { clock, controller, save, states } = autosaveFixture();

    controller.input("0", clock.now());
    clock.advance(1_000);
    for (let index = 1; index < 200; index += 1) {
      controller.input(String(index), clock.now());
      clock.advance(1);
    }
    expect(save.maxActive).toBe(1);
    expect(save.calls).toHaveLength(1);

    save.pending[0]!.resolve({ status: 200, changed: true, paste: summary({ version: "g.2" }) });
    await settle();
    clock.advance(1_000);
    expect(save.calls.at(-1)).toEqual({ action: "autosave", content: "199", version: "g.2" });
    expect(save.maxActive).toBe(1);

    save.pending[1]!.resolve({ status: 200, changed: true, paste: summary({ version: "g.3" }) });
    await settle();
    expect(save.active).toBe(0);
    expect(lastState(states)).toMatchObject({ state: "saved", draft: "199", acceptedSource: "199", version: "g.3" });
  });
});

describe("authoritative transitions", () => {
  it.each([
    {
      name: "replace",
      prepare: (fixture: ReturnType<typeof autosaveFixture>) => fixture.controller.input("later", 0),
      transition: { kind: "replace", acceptedSource: "server", version: "g.2" },
      expected: { state: "clean", draft: "server", acceptedSource: "server", version: "g.2", dueAt: null },
    },
    {
      name: "metadata",
      prepare: (fixture: ReturnType<typeof autosaveFixture>) => {
        fixture.controller.input("later", 0);
        fixture.controller.applyAuthoritative({ kind: "pause", state: "conflict", failureStatus: 409 });
      },
      transition: { kind: "metadata", acceptedSource: "first", version: "g.2" },
      expected: { state: "waiting", draft: "later", acceptedSource: "first", version: "g.2", dueAt: 1_000 },
    },
    {
      name: "reconciled-applied",
      prepare: (fixture: ReturnType<typeof autosaveFixture>) => fixture.controller.input("later", 0),
      transition: { kind: "reconciled-applied", acceptedSource: "server", version: "g.2" },
      expected: { state: "waiting", draft: "later", acceptedSource: "server", version: "g.2", dueAt: null },
    },
    {
      name: "reconciled-not-applied",
      prepare: (fixture: ReturnType<typeof autosaveFixture>) => fixture.controller.input("later", 0),
      transition: { kind: "reconciled-not-applied", acceptedSource: "server", version: "g.2" },
      expected: { state: "error", draft: "later", acceptedSource: "server", version: "g.2", requiresExplicitRetry: true, dueAt: null },
    },
    {
      name: "pause",
      prepare: (fixture: ReturnType<typeof autosaveFixture>) => fixture.controller.input("later", 0),
      transition: { kind: "pause", state: "not-found", failureStatus: 404 },
      expected: { state: "not-found", draft: "later", acceptedSource: "first", version: "g.1", failureStatus: 404 },
    },
  ] as Array<{
    name: string;
    prepare(fixture: ReturnType<typeof autosaveFixture>): void;
    transition: AutosaveAuthoritativeTransition;
    expected: Partial<AutosaveSnapshot>;
  }>)("applies $name", ({ prepare, transition, expected }) => {
    const fixture = autosaveFixture();
    prepare(fixture);
    fixture.controller.applyAuthoritative(transition);
    expect(fixture.controller.snapshot()).toMatchObject(expected);
  });

  it("dispatches a later draft only after reconciled-applied releases the slot", () => {
    const { controller, save } = autosaveFixture();

    controller.input("later", 0);
    controller.applyAuthoritative({ kind: "reconciled-applied", acceptedSource: "server", version: "g.2" });
    controller.slotAvailable();

    expect(save.calls).toEqual([{ action: "autosave", content: "later", version: "g.2" }]);
  });

  it("keeps reconciled-not-applied explicit-retry error without automatic dispatch", () => {
    const { controller, save } = autosaveFixture();

    controller.input("later", 0);
    controller.applyAuthoritative({ kind: "reconciled-not-applied", acceptedSource: "server", version: "g.2" });
    controller.slotAvailable();

    expect(controller.snapshot()).toMatchObject({ state: "error", requiresExplicitRetry: true });
    expect(save.calls).toEqual([]);
  });
});

describe("createAutosaveMarkdownModes", () => {
  it("queues one autosave when a recovered serialization retry succeeds once", async () => {
    const { clock, controller, save } = autosaveFixture();
    const input = vi.spyOn(controller, "input");
    const source = { value: "first" } as HTMLTextAreaElement;
    const onVisualError = vi.fn();
    const modes = createAutosaveMarkdownModes({
      autosave: controller,
      onCrepeChange: vi.fn(),
      now: clock.now,
      source,
      visualRoot: { childNodes: [], removeChild: vi.fn() } as unknown as Node,
      onVisualError,
    });

    await modes.enterVisual();
    const editor = visual.state.instances.at(-1)!;
    visual.state.failGetMarkdown = true;
    editor.documentChanged("second");
    const retry = onVisualError.mock.calls[0]![0].retry;

    visual.state.failGetMarkdown = false;
    await retry();

    expect(input).toHaveBeenCalledOnce();
    expect(input).toHaveBeenCalledWith("second", 0);
    expect(editor.getMarkdownCalls).toBe(2);
    clock.advance(999);
    expect(save.calls).toEqual([]);

    await retry();

    expect(input).toHaveBeenCalledOnce();
    expect(editor.getMarkdownCalls).toBe(2);
    clock.advance(1);
    expect(save.calls).toEqual([{ action: "autosave", content: "second", version: "g.1" }]);
    await modes.destroy();
  });

  it("keeps an autosave retry stale after a newer visual transaction succeeds", async () => {
    const { clock, controller, save } = autosaveFixture();
    const input = vi.spyOn(controller, "input");
    const source = { value: "first" } as HTMLTextAreaElement;
    const onVisualError = vi.fn();
    const modes = createAutosaveMarkdownModes({
      autosave: controller,
      onCrepeChange: vi.fn(),
      now: clock.now,
      source,
      visualRoot: { childNodes: [], removeChild: vi.fn() } as unknown as Node,
      onVisualError,
    });

    await modes.enterVisual();
    const editor = visual.state.instances.at(-1)!;
    visual.state.failGetMarkdown = true;
    editor.documentChanged("failed");
    const retry = onVisualError.mock.calls[0]![0].retry;

    visual.state.failGetMarkdown = false;
    editor.documentChanged("newer");

    expect(input).toHaveBeenCalledOnce();
    expect(input).toHaveBeenCalledWith("newer", 0);
    expect(editor.getMarkdownCalls).toBe(2);
    clock.advance(999);
    expect(save.calls).toEqual([]);

    await retry();

    expect(input).toHaveBeenCalledOnce();
    expect(editor.getMarkdownCalls).toBe(2);
    clock.advance(1);
    expect(save.calls).toEqual([{ action: "autosave", content: "newer", version: "g.1" }]);
    await modes.destroy();
  });

  it("does not autosave a visual mode switch but saves one serialized document edit", async () => {
    const { clock, controller, save } = autosaveFixture();
    const source = { value: "first" } as HTMLTextAreaElement;
    const modes = createAutosaveMarkdownModes({
      autosave: controller,
      onCrepeChange: vi.fn(),
      now: clock.now,
      source,
      visualRoot: { childNodes: [], removeChild: vi.fn() } as unknown as Node,
    });

    await modes.enterVisual();
    await modes.enterSource();
    clock.advance(1_000);
    expect(save.calls).toEqual([]);

    await modes.enterVisual();
    visual.state.instances.at(-1)!.documentChanged("second");
    clock.advance(999);
    expect(save.calls).toEqual([]);
    clock.advance(1);
    expect(save.calls).toEqual([{ action: "autosave", content: "second", version: "g.1" }]);
    await modes.destroy();
  });

  it("reads now once and reports Crepe changes before autosave without scheduling mode changes", async () => {
    const changes: string[] = [];
    const now = vi.fn(() => 123);
    const onCrepeChange = vi.fn((content: string, eventAt: number) => changes.push(`page:${content}:${eventAt}`));
    const autosave = {
      input: vi.fn((content: string, eventAt: number) => changes.push(`autosave:${content}:${eventAt}`)),
    };
    const source = { value: "first" } as HTMLTextAreaElement;
    const modes = createAutosaveMarkdownModes({
      autosave,
      onCrepeChange,
      now,
      source,
      visualRoot: { childNodes: [], removeChild: vi.fn() } as unknown as Node,
    });

    await modes.enterVisual();
    await modes.enterSource();
    await modes.enterVisual();
    expect(now).not.toHaveBeenCalled();
    expect(onCrepeChange).not.toHaveBeenCalled();
    expect(autosave.input).not.toHaveBeenCalled();

    visual.state.instances.at(-1)!.documentChanged("second");

    expect(now).toHaveBeenCalledTimes(1);
    expect(onCrepeChange).toHaveBeenCalledWith("second", 123);
    expect(autosave.input).toHaveBeenCalledWith("second", 123);
    expect(changes).toEqual(["page:second:123", "autosave:second:123"]);
    await modes.destroy();
  });
});
