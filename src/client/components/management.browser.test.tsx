import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { createRoot, type Root } from "react-dom/client";
import * as React from "react";
import type { ReactNode } from "react";
import { HelpProvider } from "./HelpTrigger";
import { HistoryPanel } from "./HistoryPanel";
import { SettingsPanel, type SettingsPanelState } from "./SettingsPanel";
import { PasswordPanel } from "./PasswordPanel";
import { DeleteFlow } from "./DeleteFlow";
import "../index.css";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; element: HTMLDivElement }> = [];
let consoleErrors: Array<unknown[]> = [];

beforeEach(() => {
  consoleErrors = vi.spyOn(console, "error").mock.calls;
});

async function mount(node: ReactNode) {
  const element = document.createElement("div");
  document.body.appendChild(element);
  const root = createRoot(element);
  React.act(() => root.render(node));
  mounted.push({ root, element });
  return {
    element,
    async render(next: ReactNode): Promise<void> {
      React.act(() => root.render(next));
      await Promise.resolve();
    },
  };
}

function click(element: Element): void {
  React.act(() => (element as HTMLButtonElement).click());
}

async function clickDialogAction(element: Element): Promise<void> {
  await React.act(async () => {
    (element as HTMLButtonElement).click();
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}

async function drainDialogTransition(): Promise<void> {
  await React.act(async () => {
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 160));
  });
}

function historyState(overrides: Record<string, unknown> = {}) {
  return {
    listState: "ready" as const,
    snapshotState: "ready" as const,
    list: {
      id: "demo",
      currentRevision: 3,
      currentVersion: "generation.3",
      revisions: [{ revision: 2, savedAt: "2026-09-13T08:00:00.000Z", supersededAt: "2026-09-13T09:00:00.000Z", byteLength: 12 }],
    },
    selected: {
      id: "demo",
      revision: 2,
      savedAt: "2026-09-13T08:00:00.000Z",
      supersededAt: "2026-09-13T09:00:00.000Z",
      byteLength: 12,
      content: "selected source\n",
    },
    failure: null,
    diff: {
      state: "ready" as const,
      lines: [
        { kind: "delete" as const, text: "selected source\n" },
        { kind: "add" as const, text: "<img src=x>current source\n" },
      ],
    },
    ...overrides,
  };
}

function history(node: ReactNode): ReactNode {
  return <HelpProvider>{node}</HelpProvider>;
}

afterEach(async () => {
  for (const value of mounted.splice(0)) {
    await React.act(async () => {
      value.root.unmount();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    value.element.remove();
  }
  await page.viewport(1280, 720);
  const actWarnings = consoleErrors.filter(
    ([message]) => typeof message === "string" && message.includes("not wrapped in act"),
  );
  vi.restoreAllMocks();
  expect(actWarnings).toHaveLength(0);
});

describe("history lazy load", () => {
  it("keeps history loading non-live but announces diff computation", async () => {
    await page.viewport(1280, 720);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const props = { active: true, openHistory: vi.fn(), selectRevision: vi.fn(), computeDiff: vi.fn(), back: vi.fn() };
    const fixture = await mount(history(
      <HistoryPanel
        {...props}
        state={historyState({ listState: "loading", list: null, snapshotState: "loading", selected: null, diff: { state: "idle", lines: [] } })}
      />,
    ));
    const statusCounts = [fixture.element.querySelectorAll('[role="status"], [aria-live]').length];

    await fixture.render(history(
      <HistoryPanel {...props} state={historyState({ diff: { state: "computing", lines: [] } })} />,
    ));
    statusCounts.push(fixture.element.querySelectorAll('[role="status"], [aria-live]').length);
    expect(statusCounts).toEqual([0, 1]);
  });

  it("loads history only after the History destination opens", async () => {
    const openHistory = vi.fn();
    const fixture = await mount(<HistoryPanel active={false} state={historyState()} openHistory={openHistory} selectRevision={vi.fn()} computeDiff={vi.fn()} back={vi.fn()} />);
    expect(openHistory).not.toHaveBeenCalled();
    await fixture.render(<HistoryPanel active state={historyState()} openHistory={openHistory} selectRevision={vi.fn()} computeDiff={vi.fn()} back={vi.fn()} />);
    expect(openHistory).toHaveBeenCalledTimes(1);
  });

  it("refetches a stale history descriptor while History remains active", async () => {
    const openHistory = vi.fn();
    const fixture = await mount(<HistoryPanel active state={historyState()} openHistory={openHistory} selectRevision={vi.fn()} computeDiff={vi.fn()} back={vi.fn()} />);
    expect(openHistory).toHaveBeenCalledOnce();

    await fixture.render(<HistoryPanel active state={historyState({ listState: "stale" })} openHistory={openHistory} selectRevision={vi.fn()} computeDiff={vi.fn()} back={vi.fn()} />);
    expect(openHistory).toHaveBeenCalledTimes(2);
  });

  it("requests only the selected revision and renders the selected-to-current diff as text", async () => {
    const selectRevision = vi.fn();
    const computeDiff = vi.fn();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const fixture = await mount(history(
      <HistoryPanel active state={historyState()} openHistory={vi.fn()} selectRevision={selectRevision} computeDiff={computeDiff} back={vi.fn()} />,
    ));

    click(Array.from(fixture.element.querySelectorAll("button")).find((button) => button.textContent?.includes("Revision 2"))!);
    expect(selectRevision).toHaveBeenCalledWith(2);
    expect(computeDiff).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(fixture.element.querySelector("img")).toBeNull();
    expect(fixture.element.textContent).toContain("-selected source");
    expect(fixture.element.textContent).toContain("+<img src=x>current source");
  });

  it("registers only the active history diff tab as mounted", async () => {
    await page.viewport(1280, 720);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const setDiffMounted = vi.fn();
    const fixture = await mount(history(
      <HistoryPanel active state={historyState()} openHistory={vi.fn()} selectRevision={vi.fn()} computeDiff={vi.fn()} setDiffMounted={setDiffMounted} back={vi.fn()} />,
    ));

    expect(setDiffMounted).toHaveBeenCalledWith(true);
    setDiffMounted.mockClear();
    await React.act(async () => {
      await userEvent.click(Array.from(fixture.element.querySelectorAll("button")).find((button) => button.textContent?.includes("Full snapshot"))!);
    });
    expect(setDiffMounted).toHaveBeenCalledWith(false);
  });

  it("uses a manual diff action with HelpTrigger copy for oversized sources", async () => {
    const computeDiff = vi.fn();
    const fixture = await mount(history(
      <HistoryPanel
        active
        state={historyState({ diff: { state: "manual", lines: [] } })}
        openHistory={vi.fn()}
        selectRevision={vi.fn()}
        computeDiff={computeDiff}
        back={vi.fn()}
      />,
    ));

    const action = Array.from(fixture.element.querySelectorAll("button")).find((button) => button.textContent === "Compute diff")!;
    expect(fixture.element.textContent).not.toContain("Large differences are computed separately from the editor.");
    click(action);
    expect(computeDiff).toHaveBeenCalledTimes(1);
    const help = Array.from(fixture.element.querySelectorAll("button")).find((button) => button.getAttribute("aria-label") === "Help")!;
    click(help);
    expect(document.body.textContent).toContain("Large differences are computed separately from the editor.");
  });

  it("focuses mobile Back on detail and restores the exact revision on return", async () => {
    await page.viewport(375, 720);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const back = vi.fn();
    const list = {
      ...historyState().list!,
      revisions: [
        { revision: 1, savedAt: "2026-09-13T07:00:00.000Z", supersededAt: "2026-09-13T08:00:00.000Z", byteLength: 10 },
        ...historyState().list!.revisions,
      ],
    };
    const fixture = await mount(history(
      <HistoryPanel
        active
        state={historyState({ list, snapshotState: "idle", selected: null, diff: { state: "idle", lines: [] } })}
        openHistory={vi.fn()}
        selectRevision={vi.fn()}
        computeDiff={vi.fn()}
        back={back}
      />,
    ));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(fixture.element.querySelector("[data-history-list]")).not.toBeNull();
    expect(fixture.element.querySelector("[data-history-detail]")).toBeNull();
    const revision = Array.from(fixture.element.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Revision 2")!;
    React.act(() => revision.focus());
    await React.act(async () => { await userEvent.keyboard("{Enter}"); });

    await fixture.render(history(
      <HistoryPanel active state={historyState({ list })} openHistory={vi.fn()} selectRevision={vi.fn()} computeDiff={vi.fn()} back={back} />,
    ));
    expect(fixture.element.querySelector("[data-history-detail]")).not.toBeNull();
    const backControl = Array.from(fixture.element.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Back")!;
    expect(document.activeElement).toBe(backControl);
    await React.act(async () => { await userEvent.keyboard("{Enter}"); });
    expect(back).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(Array.from(fixture.element.querySelectorAll("button")).find((button) => button.textContent === "Revision 2"));
  });

  it("keeps a 2,000-character mobile revision in a keyboard-scrollable detail view", async () => {
    await page.viewport(320, 720);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const longLine = "W".repeat(2_000);
    const state = historyState({
      selected: { ...historyState().selected!, content: longLine },
      diff: { state: "ready", lines: [{ kind: "add", text: longLine }] },
    });
    const props = { active: true, openHistory: vi.fn(), selectRevision: vi.fn(), computeDiff: vi.fn(), back: vi.fn() };
    const fixture = await mount(history(<HistoryPanel {...props} state={state} />));
    click(Array.from(fixture.element.querySelectorAll("button")).find((button) => button.textContent === "Revision 2")!);

    const detail = fixture.element.querySelector<HTMLElement>("[data-history-detail]")!;
    const diff = detail.querySelector<HTMLPreElement>('pre[aria-label="Selected revision"]')!;
    const snapshotTab = Array.from(detail.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Full snapshot")!;
    expect(detail.getBoundingClientRect().width).toBeLessThanOrEqual(320);
    expect(diff.clientWidth).toBeGreaterThan(0);
    expect(diff.clientWidth).toBeLessThanOrEqual(320);
    expect(diff.scrollWidth).toBeGreaterThan(diff.clientWidth);
    expect(snapshotTab.getBoundingClientRect().right).toBeLessThanOrEqual(320);
    await vi.waitFor(() => expect(diff.style.overflowX).toBe("auto"));
    expect(diff.tabIndex).toBe(0);
    React.act(() => diff.focus());
    await userEvent.keyboard("{ArrowRight}");
    await vi.waitFor(() => expect(diff.scrollLeft).toBeGreaterThan(0));

    await React.act(async () => { await userEvent.click(snapshotTab); });
    const snapshot = detail.querySelector<HTMLPreElement>('[data-slot="tabs-content"][data-state="active"] pre')!;
    expect(snapshot.textContent).toBe(longLine);
    expect(snapshot.clientWidth).toBeGreaterThan(0);
    expect(snapshot.clientWidth).toBeLessThanOrEqual(320);
    expect(snapshot.scrollWidth).toBeGreaterThan(snapshot.clientWidth);
    await vi.waitFor(() => expect(snapshot.style.overflowX).toBe("auto"));
    expect(snapshot.tabIndex).toBe(0);
    React.act(() => snapshot.focus());
    await userEvent.keyboard("{ArrowRight}");
    await vi.waitFor(() => expect(snapshot.scrollLeft).toBeGreaterThan(0));

    await React.act(async () => {
      await page.viewport(1280, 720);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    await fixture.render(history(<HistoryPanel {...props} state={historyState()} />));
    await vi.waitFor(() => expect(fixture.element.querySelector("[data-history-list]")).not.toBeNull());
    expect(snapshotTab.getBoundingClientRect().right).toBeLessThanOrEqual(1280);
    expect(snapshot.textContent).toBe("selected source\n");
    await vi.waitFor(() => expect(snapshot.hasAttribute("tabindex")).toBe(false));
    expect(snapshot.style.overflowX).toBe("");
  });

  it("keeps keyboard focus on Back when a delayed mobile snapshot becomes ready", async () => {
    await page.viewport(320, 720);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const back = vi.fn();
    const props = { active: true, openHistory: vi.fn(), selectRevision: vi.fn(), computeDiff: vi.fn(), back };
    const fixture = await mount(history(
      <HistoryPanel {...props} state={historyState({ snapshotState: "idle", selected: null })} />,
    ));
    const revision = Array.from(fixture.element.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Revision 2")!;
    React.act(() => revision.focus());
    await React.act(async () => { await userEvent.keyboard("{Enter}"); });
    await fixture.render(history(<HistoryPanel {...props} state={historyState({ snapshotState: "loading", selected: null })} />));
    const loadingBack = Array.from(fixture.element.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Back")!;
    expect(document.activeElement).toBe(loadingBack);

    await fixture.render(history(<HistoryPanel {...props} state={historyState()} />));
    const readyBack = Array.from(fixture.element.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Back")!;
    expect(readyBack).not.toBe(loadingBack);
    expect(document.activeElement).toBe(readyBack);
    await React.act(async () => { await userEvent.keyboard("{Enter}"); });
    expect(back).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(Array.from(fixture.element.querySelectorAll("button")).find((button) => button.textContent === "Revision 2"));
  });

  it("transfers the focused desktop revision to mobile Back on resize", async () => {
    await page.viewport(1280, 720);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const selectRevision = vi.fn();
    const props = { active: true, openHistory: vi.fn(), selectRevision, computeDiff: vi.fn(), back: vi.fn() };
    const fixture = await mount(history(<HistoryPanel {...props} state={historyState()} />));
    const revision = Array.from(fixture.element.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Revision 2")!;
    expect(fixture.element.querySelector("[data-history-list]")).not.toBeNull();
    expect(fixture.element.querySelector("[data-history-detail]")).not.toBeNull();
    React.act(() => revision.focus());
    await React.act(async () => { await userEvent.keyboard("{Enter}"); });
    expect(selectRevision).toHaveBeenCalledWith(2);
    expect(document.activeElement).toBe(revision);

    await React.act(async () => {
      await page.viewport(320, 720);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    await vi.waitFor(() => expect(fixture.element.querySelector("[data-history-list]")).toBeNull());
    expect(fixture.element.querySelector("[data-history-detail]")).not.toBeNull();
    expect(document.activeElement).toBe(Array.from(fixture.element.querySelectorAll("button")).find((button) => button.textContent === "Back"));
  });

  it("transfers the focused mobile Back to its exact desktop revision on resize", async () => {
    await page.viewport(320, 720);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const list = {
      ...historyState().list!,
      revisions: [
        { revision: 1, savedAt: "2026-09-13T07:00:00.000Z", supersededAt: "2026-09-13T08:00:00.000Z", byteLength: 10 },
        ...historyState().list!.revisions,
      ],
    };
    const props = { active: true, openHistory: vi.fn(), selectRevision: vi.fn(), computeDiff: vi.fn(), back: vi.fn() };
    const fixture = await mount(history(<HistoryPanel {...props} state={historyState({ list })} />));
    const revision = Array.from(fixture.element.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Revision 2")!;
    React.act(() => revision.focus());
    await React.act(async () => { await userEvent.keyboard("{Enter}"); });
    const back = Array.from(fixture.element.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Back")!;
    expect(document.activeElement).toBe(back);

    await React.act(async () => {
      await page.viewport(1280, 720);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    await vi.waitFor(() => expect(fixture.element.querySelector("[data-history-list]")).not.toBeNull());
    expect(fixture.element.querySelector("[data-history-detail]")).not.toBeNull();
    expect(document.activeElement).toBe(Array.from(fixture.element.querySelectorAll("button")).find((button) => button.textContent === "Revision 2"));
  });

  it("shows loading, empty, and failure states without changing the surrounding draft", async () => {
    function Fixture({ state }: { state: ReturnType<typeof historyState> }) {
      const [draft, setDraft] = React.useState("exact draft");
      return <>
        <input aria-label="Current draft" value={draft} onChange={(event) => setDraft(event.currentTarget.value)} />
        <HistoryPanel active state={state} openHistory={vi.fn()} selectRevision={vi.fn()} computeDiff={vi.fn()} back={vi.fn()} />
      </>;
    }
    const fixture = await mount(<Fixture state={historyState({ listState: "loading", list: null, selected: null, snapshotState: "idle", diff: { state: "idle", lines: [] } })} />);
    const draft = fixture.element.querySelector<HTMLInputElement>('input[aria-label="Current draft"]')!;
    expect(draft.value).toBe("exact draft");
    await fixture.render(<Fixture state={historyState({ listState: "failed", list: null, selected: null, snapshotState: "failed", failure: { target: "list", value: { status: 503, code: "STORAGE_READ_FAILED" } }, diff: { state: "idle", lines: [] } })} />);
    expect(draft.value).toBe("exact draft");
    expect(fixture.element.textContent).toContain("Storage could not be read. Retry the request.");
  });

  it("announces diff computation while the History tab remains focused", async () => {
    await page.viewport(1280, 720);
    const props = { active: true, openHistory: vi.fn(), selectRevision: vi.fn(), computeDiff: vi.fn(), back: vi.fn() };
    const fixture = await mount(history(<HistoryPanel {...props} state={historyState()} />));
    const tab = Array.from(fixture.element.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find((button) => button.textContent === "Unified diff")!;
    React.act(() => tab.focus());
    await fixture.render(history(<HistoryPanel {...props} state={historyState({ diff: { state: "computing", lines: [] } })} />));
    expect(document.activeElement).toBe(tab);
    expect(fixture.element.querySelector('[data-history-detail] [role="status"]')?.textContent).toBe("Compute diff");
  });
});

function settingsState(overrides: Record<string, unknown> = {}) {
  return {
    accepted: { id: "demo", title: "Accepted title", format: "text" as const, expiration: 3_600, viewOnce: false },
    versionUsable: true,
    result: { field: null, state: "idle" as const, message: null },
    ...overrides,
  };
}

// @ts-expect-error reconciliation-required expiration results require an intent
const missingExpirationReconciliationIntent: SettingsPanelState["result"] = { field: "expiration", state: "reconciliation-required", message: null };

function passwordState(overrides: Record<string, unknown> = {}) {
  return {
    protected: false,
    versionUsable: true,
    result: { action: null, state: "idle" as const, message: null },
    ...overrides,
  };
}

function deleteState(overrides: Record<string, unknown> = {}) {
  return {
    phase: "ordinary" as const,
    result: { state: "idle" as const, message: null },
    mutationPending: false,
    versionUsable: true,
    ...overrides,
  };
}

function input(element: HTMLInputElement, value: string): void {
  React.act(() => {
    element.value = value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function change(element: { value: string; dispatchEvent(event: Event): boolean }, value: string): void {
  React.act(() => {
    element.value = value;
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("settings result table", () => {
  it("aligns each setting and password field with its action without duplicate links or Discard buttons", async () => {
    await page.viewport(1000, 720);
    const fixture = await mount(<div>
      <SettingsPanel state={settingsState()} onActivity={vi.fn()} saveTitle={vi.fn()} saveFormat={vi.fn()} saveExpiration={vi.fn()} saveViewOnce={vi.fn()} retry={vi.fn()} reconcile={vi.fn()} reload={vi.fn()} />
      <PasswordPanel state={passwordState({ protected: true })} onActivity={vi.fn()} setPassword={vi.fn()} clearPassword={vi.fn()} retry={vi.fn()} reconcile={vi.fn()} reload={vi.fn()} />
    </div>);
    expect(fixture.element.querySelectorAll('[data-settings-row]')).toHaveLength(7);
    const title = fixture.element.querySelector<HTMLElement>('[data-settings-row="title"]')!;
    const format = fixture.element.querySelector<HTMLElement>('[data-settings-row="format"]')!;
    const password = fixture.element.querySelector<HTMLElement>('[data-settings-row="newPassword"]')!;
    expect(title.querySelector('input')!.getBoundingClientRect().left).toBeCloseTo(format.querySelector('select')!.getBoundingClientRect().left, 0);
    expect(title.querySelector('input')!.getBoundingClientRect().left).toBeCloseTo(password.querySelector('input')!.getBoundingClientRect().left, 0);
    expect(title.querySelector('button')!.getBoundingClientRect().left).toBeCloseTo(password.querySelector('button')!.getBoundingClientRect().left, 0);
    expect(fixture.element.querySelectorAll('button').length).toBeGreaterThan(0);
    expect(Array.from(fixture.element.querySelectorAll('button')).some((button) => button.textContent === "Discard")).toBe(false);
    expect(fixture.element.querySelector('nav[aria-label="Representations"]')).toBeNull();
    for (const select of fixture.element.querySelectorAll('select[name]')) expect(getComputedStyle(select).appearance).toBe("none");
    expect(getComputedStyle(fixture.element.querySelector<HTMLInputElement>('input[name="viewOnce"]')!).appearance).toBe("none");

    await page.viewport(320, 720);
    for (const row of fixture.element.querySelectorAll<HTMLElement>('[data-settings-row]')) {
      expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);
      const controls = Array.from(row.children).map((child) => child.getBoundingClientRect());
      expect(controls[0]!.right).toBeLessThanOrEqual(controls[1]!.left + 1);
      if (controls[2] !== undefined) expect(controls[1]!.right).toBeLessThanOrEqual(controls[2]!.left + 1);
    }
  });

  it("keeps separate controlled drafts, reports owner draft state for field input, and saves one field at a time", async () => {
    const activity = vi.fn();
    const draftState = vi.fn();
    const saveTitle = vi.fn();
    const saveFormat = vi.fn();
    const saveExpiration = vi.fn();
    const saveViewOnce = vi.fn();
    const fixture = await mount(
      <SettingsPanel
        state={settingsState()}
        onActivity={activity}
        onDraftState={draftState}
        saveTitle={saveTitle}
        saveFormat={saveFormat}
        saveExpiration={saveExpiration}
        saveViewOnce={saveViewOnce}
        retry={vi.fn()}
        reconcile={vi.fn()}
        reload={vi.fn()}
      />,
    );

    const id = fixture.element.querySelector<HTMLInputElement>('input[name="id"]')!;
    expect(id.readOnly).toBe(true);
    const title = fixture.element.querySelector<HTMLInputElement>('input[name="title"]')!;
    input(title, "Draft title");
    expect(activity).not.toHaveBeenCalled();
    expect(draftState).toHaveBeenCalledWith(true, expect.any(Number));
    click(Array.from(fixture.element.querySelectorAll("button")).find((button) => button.textContent === "Save title")!);
    expect(saveTitle).toHaveBeenCalledOnce();
    expect(saveTitle).toHaveBeenCalledWith("Draft title");
    expect(activity).not.toHaveBeenCalled();

    const format = fixture.element.querySelector('select[name="format"]') as unknown as { value: string; dispatchEvent(event: Event): boolean };
    change(format, "markdown");
    click(Array.from(fixture.element.querySelectorAll("button")).find((button) => button.textContent === "Save format")!);
    expect(saveFormat).toHaveBeenCalledWith("markdown");

    const expiration = fixture.element.querySelector('select[name="expiration"]') as unknown as { value: string; dispatchEvent(event: Event): boolean };
    change(expiration, "60");
    click(Array.from(fixture.element.querySelectorAll("button")).find((button) => button.textContent === "Save expiration")!);
    expect(saveExpiration).toHaveBeenCalledWith(60);

    const viewOnce = fixture.element.querySelector<HTMLInputElement>('input[name="viewOnce"]')!;
    click(viewOnce);
    click(Array.from(fixture.element.querySelectorAll("button")).find((button) => button.textContent === "Save view once")!);
    expect(saveViewOnce).toHaveBeenCalledWith(true);
  });

  it("submits the specified 360-day one-year expiration from Settings", async () => {
    const saveExpiration = vi.fn();
    const fixture = await mount(<SettingsPanel state={settingsState()} onActivity={vi.fn()} saveTitle={vi.fn()} saveFormat={vi.fn()} saveExpiration={saveExpiration} saveViewOnce={vi.fn()} retry={vi.fn()} reconcile={vi.fn()} reload={vi.fn()} />);
    const select = fixture.element.querySelector('select[name="expiration"]') as unknown as HTMLSelectElement;
    const oneYear = Array.from(select.options).find((option) => option.textContent === "1 year");
    expect(oneYear?.value).toBe("31104000");
    change(select, "31104000");
    click(fixture.element.querySelector<HTMLButtonElement>('button[data-settings-field="expiration"]')!);
    expect(saveExpiration).toHaveBeenCalledWith(31_104_000);
  });

  it("keeps each field outcome on its originating button until that field changes", async () => {
    const props = {
      onActivity: vi.fn(),
      saveTitle: vi.fn(),
      saveFormat: vi.fn(),
      saveExpiration: vi.fn(),
      saveViewOnce: vi.fn(),
      retry: vi.fn(),
      reconcile: vi.fn(),
      reload: vi.fn(),
    };
    const titlePending = { field: "title" as const, state: "pending" as const, message: null };
    const fixture = await mount(<SettingsPanel state={settingsState({ result: titlePending })} {...props} />);
    const outcome = (field: string) => fixture.element.querySelector<HTMLButtonElement>(`button[data-settings-field="${field}"]`)!;

    expect(outcome("title").dataset.settingsActionResult).toBe("pending");
    expect(outcome("title").textContent).toBe("Saving title");

    await fixture.render(<SettingsPanel state={settingsState({ result: { field: "title", state: "succeeded", message: "Title saved by server." } })} {...props} />);
    expect(outcome("title").dataset.settingsActionResult).toBe("succeeded");
    expect(outcome("title").textContent).toBe("Title saved");

    await fixture.render(<SettingsPanel state={settingsState({ result: { field: "format", state: "succeeded", message: "Format saved by server." } })} {...props} />);
    expect(outcome("title").textContent).toBe("Title saved");
    expect(outcome("format").dataset.settingsActionResult).toBe("succeeded");
    expect(outcome("format").textContent).toBe("Format saved");

    await fixture.render(<SettingsPanel state={settingsState({ result: { field: "title", state: "retryable", message: "Storage write failed." } })} {...props} />);
    expect(outcome("title").dataset.settingsActionResult).toBe("failed");
    expect(outcome("title").textContent).toBe("Title failed");
    expect(outcome("format").textContent).toBe("Format saved");
  });

  it("keeps a Retry attempt on its recovery button and resets the matching field button", async () => {
    const retry = vi.fn();
    const props = {
      onActivity: vi.fn(),
      saveTitle: vi.fn(),
      saveFormat: vi.fn(),
      saveExpiration: vi.fn(),
      saveViewOnce: vi.fn(),
      retry,
      reconcile: vi.fn(),
      reload: vi.fn(),
    };
    const fixture = await mount(
      <SettingsPanel state={settingsState({ result: { field: "title", state: "retryable", message: "Storage write failed." } })} {...props} />,
    );
    const title = () => fixture.element.querySelector<HTMLButtonElement>('button[data-settings-field="title"]')!;

    click(Array.from(fixture.element.querySelectorAll("button")).find((button) => button.textContent === "Retry")!);
    expect(retry).toHaveBeenCalledWith(null);
    await fixture.render(
      <SettingsPanel
        state={settingsState({ result: { field: "title", state: "pending", message: null, action: "settings-title" } })}
        {...props}
      />,
    );

    const recovery = fixture.element.querySelector<HTMLButtonElement>('[data-settings-recovery-action="settings-title"]');
    expect(title().textContent).toBe("Save title");
    expect(recovery).not.toBeNull();
    expect(recovery!.textContent).toBe("Saving title");
    expect(recovery!.querySelector('svg[aria-hidden="true"]')).not.toBeNull();

    await fixture.render(
      <SettingsPanel
        state={settingsState({ result: { field: "title", state: "succeeded", message: null, action: "settings-title" } })}
        {...props}
      />,
    );
    expect(title().textContent).toBe("Save title");
    expect(fixture.element.querySelector<HTMLButtonElement>('[data-settings-recovery-action="settings-title"]')?.textContent).toBe("Title saved");
  });

  it("maps relative-expiration reconciliation to settings-reconcile on its recovery button", async () => {
    const reconcile = vi.fn();
    const props = {
      onActivity: vi.fn(),
      saveTitle: vi.fn(),
      saveFormat: vi.fn(),
      saveExpiration: vi.fn(),
      saveViewOnce: vi.fn(),
      retry: vi.fn(),
      reconcile,
      reload: vi.fn(),
    };
    const initial = settingsState({
      reconciliationOwner: "expiration",
      result: { field: "expiration", state: "reconciliation-required", message: null, reconciliationIntent: "relative" },
    });
    const fixture = await mount(<SettingsPanel state={initial} {...props} />);
    click(fixture.element.querySelector('[data-settings-recovery-action="settings-reconcile"]')!);
    expect(reconcile).toHaveBeenCalledOnce();

    await fixture.render(
      <SettingsPanel
        state={settingsState({
          reconciliationOwner: "expiration",
          reconciliationRequestPending: true,
          result: { field: "expiration", state: "pending", message: null, action: "settings-reconcile" },
        })}
        {...props}
      />,
    );
    const recovery = fixture.element.querySelector<HTMLButtonElement>('[data-settings-recovery-action="settings-reconcile"]');
    expect(recovery).not.toBeNull();
    expect(recovery!.textContent).toBe("Reconciling settings");
    expect(recovery!.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(fixture.element.querySelector<HTMLButtonElement>('button[data-settings-field="expiration"]')?.textContent).toBe("Save expiration");

    await fixture.render(
      <SettingsPanel
        state={settingsState({
          reconciliationOwner: "expiration",
          result: { field: "expiration", state: "succeeded", message: null, action: "settings-reconcile" },
        })}
        {...props}
      />,
    );
    expect(fixture.element.querySelector<HTMLButtonElement>('[data-settings-recovery-action="settings-reconcile"]')?.textContent).toBe("Settings reconciled");
  });

  it("retains pending, failed, and succeeded Reload outcomes on its originating Settings button", async () => {
    const reload = vi.fn();
    const props = {
      onActivity: vi.fn(),
      saveTitle: vi.fn(),
      saveFormat: vi.fn(),
      saveExpiration: vi.fn(),
      saveViewOnce: vi.fn(),
      retry: vi.fn(),
      reconcile: vi.fn(),
      reload,
    };
    const fixture = await mount(
      <SettingsPanel state={settingsState({ versionUsable: false, result: { field: "title", state: "conflict", message: null } })} {...props} />,
    );
    const originatingButton = Array.from(fixture.element.querySelectorAll("button")).find((value) => value.textContent === "Reload")!;
    click(originatingButton);
    expect(reload).toHaveBeenCalledOnce();

    await fixture.render(
      <SettingsPanel state={settingsState({ versionUsable: false, result: { field: null, state: "pending", message: null, action: "reload-server", attempt: 1 } })} {...props} />,
    );
    const outcome = () => fixture.element.querySelector<HTMLButtonElement>('[data-settings-recovery-action="reload-server"]');
    expect(outcome()).toBe(originatingButton);
    expect(outcome()?.textContent).toBe("Reloading");
    expect(outcome()?.disabled).toBe(true);
    expect(outcome()?.getAttribute("aria-busy")).toBe("true");

    await fixture.render(
      <SettingsPanel state={settingsState({ versionUsable: false, result: { field: null, state: "conflict", message: null, action: "reload-server", attempt: 1 } })} {...props} />,
    );
    expect(outcome()).toBe(originatingButton);
    expect(outcome()?.textContent).toBe("Reload failed");
    expect(outcome()?.disabled).toBe(false);
    expect(outcome()?.hasAttribute("aria-busy")).toBe(false);
    click(outcome()!);
    expect(reload).toHaveBeenCalledTimes(2);

    await fixture.render(
      <SettingsPanel state={settingsState({ versionUsable: true, result: { field: null, state: "succeeded", message: null, action: "reload-server", attempt: 2 } })} {...props} />,
    );
    expect(outcome()).toBe(originatingButton);
    expect(outcome()?.textContent).toBe("Reloaded");
    expect(outcome()?.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(fixture.element.querySelector("[aria-live], [role=status]")).toBeNull();
  });

  it("retains field outcomes and clears them when paste identity changes", async () => {
    const props = {
      onActivity: vi.fn(),
      saveTitle: vi.fn(),
      saveFormat: vi.fn(),
      saveExpiration: vi.fn(),
      saveViewOnce: vi.fn(),
      retry: vi.fn(),
      reconcile: vi.fn(),
      reload: vi.fn(),
    };
    const fixture = await mount(
      <SettingsPanel state={settingsState({ result: { field: "title", state: "succeeded", message: null } })} {...props} />,
    );
    const outcome = (field: string) => fixture.element.querySelector<HTMLButtonElement>(`button[data-settings-field="${field}"]`)!;

    await fixture.render(
      <SettingsPanel state={settingsState({ result: { field: "format", state: "succeeded", message: null } })} {...props} />,
    );
    expect(Array.from(fixture.element.querySelectorAll("button")).some((button) => button.textContent === "Discard")).toBe(false);
    expect(outcome("title").textContent).toBe("Title saved");
    expect(outcome("format").textContent).toBe("Format saved");

    await fixture.render(
      <SettingsPanel
        state={settingsState({
          accepted: { id: "other", title: "Other title", format: "text", expiration: null, viewOnce: false },
        })}
        {...props}
      />,
    );
    expect(outcome("title").textContent).toBe("Save title");
    expect(outcome("format").textContent).toBe("Save format");
  });

  it("does not commit a prior paste outcome during an identity transition", async () => {
    const committedLabels: string[] = [];
    const props = {
      onActivity: vi.fn(),
      saveTitle: vi.fn(),
      saveFormat: vi.fn(),
      saveExpiration: vi.fn(),
      saveViewOnce: vi.fn(),
      retry: vi.fn(),
      reconcile: vi.fn(),
      reload: vi.fn(),
    };
    function IdentityProbe({ state }: { state: SettingsPanelState }) {
      const host = React.useRef<HTMLDivElement>(null);
      React.useLayoutEffect(() => {
        committedLabels.push(host.current!.querySelector<HTMLButtonElement>('button[data-settings-field="title"]')!.textContent ?? "");
      }, [state.accepted.id]);
      return <div ref={host}><SettingsPanel state={state} {...props} /></div>;
    }
    const fixture = await mount(
      <IdentityProbe state={settingsState({ result: { field: "title", state: "succeeded", message: null } })} />,
    );

    await fixture.render(
      <IdentityProbe
        state={settingsState({ accepted: { id: "other", title: "Other title", format: "text", expiration: null, viewOnce: false } })}
      />,
    );
    expect(committedLabels).toEqual(["Title saved", "Save title"]);
  });

  it("keeps button outcomes non-live and announces blocking errors", async () => {
    const props = {
      onActivity: vi.fn(),
      saveTitle: vi.fn(),
      saveFormat: vi.fn(),
      saveExpiration: vi.fn(),
      saveViewOnce: vi.fn(),
      retry: vi.fn(),
      reconcile: vi.fn(),
      reload: vi.fn(),
    };
    const fixture = await mount(
      <SettingsPanel state={settingsState({ result: { field: "title", state: "pending", message: null } })} {...props} />,
    );
    const title = fixture.element.querySelector<HTMLButtonElement>('button[data-settings-field="title"]')!;

    expect(title.textContent).toBe("Saving title");
    expect(title.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(title.querySelector("[aria-live], [role=status]")).toBeNull();

    await fixture.render(
      <SettingsPanel state={settingsState({ result: { field: "title", state: "retryable", message: "Storage write failed." } })} {...props} />,
    );
    expect(title.textContent).toBe("Title failed");
    expect(fixture.element.textContent).toContain("Storage write failed.");
    expect(fixture.element.querySelector('[role="alert"]')?.textContent).toBe("Storage write failed.");
  });

  it("renders inline validation and credential results without changing accepted drafts", async () => {
    const fixture = await mount(
      <SettingsPanel
        state={settingsState({ result: { field: "title", state: "validation-error", message: "Title is too long." } })}
        onActivity={vi.fn()}
        saveTitle={vi.fn()}
        saveFormat={vi.fn()}
        saveExpiration={vi.fn()}
        saveViewOnce={vi.fn()}
        retry={vi.fn()}
        reconcile={vi.fn()}
        reload={vi.fn()}
      />,
    );
    expect(fixture.element.querySelector('[name="title"]')?.getAttribute("aria-invalid")).toBe("true");
    expect(fixture.element.textContent).toContain("Title is too long.");
    expect(fixture.element.querySelector<HTMLInputElement>('[name="title"]')?.value).toBe("Accepted title");

    const retry = vi.fn();
    await fixture.render(
      <SettingsPanel
        state={settingsState({ result: { field: "title", state: "credential-required", message: "Password is missing or incorrect." } })}
        onActivity={vi.fn()}
        saveTitle={vi.fn()}
        saveFormat={vi.fn()}
        saveExpiration={vi.fn()}
        saveViewOnce={vi.fn()}
        retry={retry}
        reconcile={vi.fn()}
        reload={vi.fn()}
      />,
    );
    expect(fixture.element.textContent).toContain("Password is missing or incorrect.");
    expect(fixture.element.querySelector('input[name="retryCredential"]')).not.toBeNull();
  });

  it("offers the outcome-specific recovery without discarding another field's draft", async () => {
    const retry = vi.fn();
    const reload = vi.fn();
    const reconcile = vi.fn();
    const fixture = await mount(
      <SettingsPanel
        state={settingsState({ versionUsable: false, result: { field: "title", state: "conflict", message: "The paste changed." } })}
        onActivity={vi.fn()}
        saveTitle={vi.fn()}
        saveFormat={vi.fn()}
        saveExpiration={vi.fn()}
        saveViewOnce={vi.fn()}
        retry={retry}
        reconcile={reconcile}
        reload={reload}
      />,
    );
    const retryButton = Array.from(fixture.element.querySelectorAll("button")).find((button) => button.textContent === "Retry")!;
    expect(retryButton.disabled).toBe(true);
    click(Array.from(fixture.element.querySelectorAll("button")).find((button) => button.textContent === "Reload")!);
    expect(reload).toHaveBeenCalledTimes(1);

    await fixture.render(
      <SettingsPanel
        state={settingsState({ result: { field: "title", state: "retryable", message: "Storage write failed." } })}
        onActivity={vi.fn()}
        saveTitle={vi.fn()}
        saveFormat={vi.fn()}
        saveExpiration={vi.fn()}
        saveViewOnce={vi.fn()}
        retry={retry}
        reconcile={reconcile}
        reload={reload}
      />,
    );
    click(Array.from(fixture.element.querySelectorAll("button")).find((button) => button.textContent === "Retry")!);
    expect(retry).toHaveBeenCalledTimes(1);

    await fixture.render(
      <SettingsPanel
        state={settingsState({ accepted: { id: "demo", title: "Latest accepted", format: "text", expiration: 3_600, viewOnce: false }, reconciliationOwner: "expiration", result: { field: "expiration", state: "reconciliation-required", message: "Request outcome is uncertain.", reconciliationIntent: "relative" } })}
        onActivity={vi.fn()}
        saveTitle={vi.fn()}
        saveFormat={vi.fn()}
        saveExpiration={vi.fn()}
        saveViewOnce={vi.fn()}
        retry={retry}
        reconcile={reconcile}
        reload={reload}
      />,
    );
    const reconcileButton = fixture.element.querySelector<HTMLButtonElement>("[data-settings-result] button")!;
    click(reconcileButton);
    expect(reconcile).toHaveBeenCalledTimes(1);
    const title = fixture.element.querySelector<HTMLInputElement>('input[name="title"]')!;
    input(title, "Keep this draft");
    expect(title.value).toBe("Keep this draft");
    expect(Array.from(fixture.element.querySelectorAll("button")).some((button) => button.textContent === "Discard")).toBe(false);
  });
});

describe("reconciliation ownership", () => {
  it("keeps owner recovery enabled while blocking unrelated settings writes", async () => {
    const reconcile = vi.fn();
    const fixture = await mount(
      <SettingsPanel
        state={settingsState({
          mutationOccupied: true,
          mutationPending: false,
          reconciliationOwner: "title",
          result: { field: "title", state: "reconciliation-required", message: "Request outcome is uncertain." },
        })}
        onActivity={vi.fn()}
        saveTitle={vi.fn()}
        saveFormat={vi.fn()}
        saveExpiration={vi.fn()}
        saveViewOnce={vi.fn()}
        retry={vi.fn()}
        reconcile={reconcile}
        reload={vi.fn()}
      />,
    );

    expect(fixture.element.querySelector<HTMLButtonElement>('button[data-settings-field="title"]')?.disabled).toBe(true);
    const recovery = fixture.element.querySelector("[data-settings-result]")!;
    click(Array.from(recovery.querySelectorAll("button")).find((button) => button.textContent === "Reconcile")!);
    expect(reconcile).toHaveBeenCalledOnce();
    expect(Array.from(fixture.element.querySelectorAll("button")).some((button) => button.textContent === "Discard")).toBe(false);
  });

  it("keeps owner Reconcile enabled when an unrelated Last action is pending", async () => {
    const reconcile = vi.fn();
    const fixture = await mount(
      <SettingsPanel
        state={settingsState({
          mutationOccupied: true,
          mutationPending: true,
          reconciliationOwner: "title",
          reconciliationRequestPending: false,
          result: { field: "title", state: "reconciliation-required", message: "Request outcome is uncertain." },
        })}
        onActivity={vi.fn()}
        saveTitle={vi.fn()}
        saveFormat={vi.fn()}
        saveExpiration={vi.fn()}
        saveViewOnce={vi.fn()}
        retry={vi.fn()}
        reconcile={reconcile}
        reload={vi.fn()}
      />,
    );

    const reconcileButton = Array.from(fixture.element.querySelectorAll("button")).find((button) => button.textContent === "Reconcile")!;
    expect(reconcileButton.disabled).toBe(false);
    click(reconcileButton);
    expect(reconcile).toHaveBeenCalledOnce();
    expect(Array.from(fixture.element.querySelectorAll("button")).some((button) => button.textContent === "Discard")).toBe(false);
  });

  it("blocks the owner's Reconcile while its GET is pending without showing Discard", async () => {
    const reconcile = vi.fn();
    const fixture = await mount(
      <SettingsPanel
        state={settingsState({
          mutationOccupied: true,
          mutationPending: false,
          reconciliationOwner: "title",
          reconciliationRequestPending: true,
          result: { field: "title", state: "reconciliation-required", message: "Request outcome is uncertain." },
        })}
        onActivity={vi.fn()}
        saveTitle={vi.fn()}
        saveFormat={vi.fn()}
        saveExpiration={vi.fn()}
        saveViewOnce={vi.fn()}
        retry={vi.fn()}
        reconcile={reconcile}
        reload={vi.fn()}
      />,
    );

    const reconcileButton = Array.from(fixture.element.querySelectorAll("button")).find((button) => button.textContent === "Reconcile")!;
    expect(reconcileButton.disabled).toBe(true);
    expect(Array.from(fixture.element.querySelectorAll("button")).some((button) => button.textContent === "Discard")).toBe(false);
    click(reconcileButton);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("keeps both settings drafts when reconciliation is required without a Discard control", async () => {
    const fixture = await mount(
      <SettingsPanel
        state={settingsState({
          reconciliationOwner: "title",
          result: { field: "title", state: "reconciliation-required", message: "Request outcome is uncertain." },
        })}
        onActivity={vi.fn()}
        saveTitle={vi.fn()}
        saveFormat={vi.fn()}
        saveExpiration={vi.fn()}
        saveViewOnce={vi.fn()}
        retry={vi.fn()}
        reconcile={vi.fn()}
        reload={vi.fn()}
      />,
    );

    const title = fixture.element.querySelector<HTMLInputElement>('input[name="title"]')!;
    const format = fixture.element.querySelector('select[name="format"]') as unknown as { value: string; dispatchEvent(event: Event): boolean };
    input(title, "Uncertain title");
    change(format, "markdown");
    expect(title.value).toBe("Uncertain title");
    expect(format.value).toBe("markdown");
    expect(Array.from(fixture.element.querySelectorAll("button")).some((button) => button.textContent === "Discard")).toBe(false);
  });

  it("keeps password recovery enabled while global occupancy blocks password writes", async () => {
    const reconcile = vi.fn();
    const fixture = await mount(
      <PasswordPanel
        state={passwordState({
          mutationOccupied: true,
          mutationPending: false,
          reconciliationOwner: "password",
          result: { action: "set", state: "reconciliation-required", message: "Request outcome is uncertain." },
        })}
        onActivity={vi.fn()}
        setPassword={vi.fn()}
        clearPassword={vi.fn()}
        retry={vi.fn()}
        reconcile={reconcile}
        reload={vi.fn()}
      />,
    );

    expect(Array.from(fixture.element.querySelectorAll("button")).find((button) => button.textContent === "Set password")?.disabled).toBe(true);
    click(Array.from(fixture.element.querySelectorAll("button")).find((button) => button.textContent === "Reconcile")!);
    expect(reconcile).toHaveBeenCalledOnce();
    expect(Array.from(fixture.element.querySelectorAll("button")).some((button) => button.textContent === "Discard")).toBe(false);
  });

  it("does not render foreign reconciliation controls or invoke their handlers", async () => {
    const settingsReconcile = vi.fn();
    const settingsFixture = await mount(
      <SettingsPanel
        state={settingsState({
          mutationOccupied: true,
          reconciliationOwner: "password",
          reconciliationRequestPending: false,
          result: { field: "title", state: "reconciliation-required", message: "Request outcome is uncertain." },
        })}
        onActivity={vi.fn()}
        saveTitle={vi.fn()}
        saveFormat={vi.fn()}
        saveExpiration={vi.fn()}
        saveViewOnce={vi.fn()}
        retry={vi.fn()}
        reconcile={settingsReconcile}
        reload={vi.fn()}
      />,
    );
    expect(Array.from(settingsFixture.element.querySelectorAll("button")).some((item) => item.textContent === "Reconcile" || item.textContent === "Discard")).toBe(false);
    expect(settingsReconcile).not.toHaveBeenCalled();

    const passwordReconcile = vi.fn();
    const passwordFixture = await mount(
      <PasswordPanel
        state={passwordState({
          mutationOccupied: true,
          reconciliationOwner: "title",
          reconciliationRequestPending: false,
          result: { action: "set", state: "reconciliation-required", message: "Request outcome is uncertain." },
        })}
        onActivity={vi.fn()}
        setPassword={vi.fn()}
        clearPassword={vi.fn()}
        retry={vi.fn()}
        reconcile={passwordReconcile}
        reload={vi.fn()}
      />,
    );
    expect(Array.from(passwordFixture.element.querySelectorAll("button")).some((item) => item.textContent === "Reconcile" || item.textContent === "Discard")).toBe(false);
    expect(passwordReconcile).not.toHaveBeenCalled();
  });
});

describe("retained success settlement", () => {
  it("reports Settings and Password success once per retained result", async () => {
    const settingsDraftState = vi.fn();
    const settingsResult = { field: "title" as const, state: "succeeded" as const, message: "Title saved." };
    const settingsProps = {
      onActivity: vi.fn(),
      onDraftState: settingsDraftState,
      saveTitle: vi.fn(),
      saveFormat: vi.fn(),
      saveExpiration: vi.fn(),
      saveViewOnce: vi.fn(),
      retry: vi.fn(),
      reconcile: vi.fn(),
      reload: vi.fn(),
    };
    const settingsFixture = await mount(<SettingsPanel state={settingsState({ result: settingsResult })} {...settingsProps} />);
    expect(settingsDraftState).toHaveBeenCalledTimes(1);
    await settingsFixture.render(<SettingsPanel state={settingsState({ result: settingsResult })} {...settingsProps} />);
    expect(settingsDraftState).toHaveBeenCalledTimes(1);
    await settingsFixture.render(<SettingsPanel state={settingsState({ result: { field: "title", state: "succeeded", message: "Title saved again." } })} {...settingsProps} />);
    expect(settingsDraftState).toHaveBeenCalledTimes(2);

    const passwordDraftState = vi.fn();
    const passwordResult = { action: "set" as const, state: "succeeded" as const, message: "Password saved." };
    const passwordProps = {
      onActivity: vi.fn(),
      onDraftState: passwordDraftState,
      setPassword: vi.fn(),
      clearPassword: vi.fn(),
      retry: vi.fn(),
      reconcile: vi.fn(),
      reload: vi.fn(),
    };
    const passwordFixture = await mount(<PasswordPanel state={passwordState({ result: passwordResult })} {...passwordProps} />);
    expect(passwordDraftState).toHaveBeenCalledTimes(1);
    await passwordFixture.render(<PasswordPanel state={passwordState({ result: passwordResult })} {...passwordProps} />);
    expect(passwordDraftState).toHaveBeenCalledTimes(1);
    await passwordFixture.render(<PasswordPanel state={passwordState({ result: { action: "set", state: "succeeded", message: "Password saved again." } })} {...passwordProps} />);
    expect(passwordDraftState).toHaveBeenCalledTimes(2);
  });
});

describe("password result table", () => {
  it("sets, changes, and clears passwords through callbacks without fetching", async () => {
    const setPassword = vi.fn();
    const clearPassword = vi.fn();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const fixture = await mount(
      <PasswordPanel
        state={passwordState()}
        onActivity={vi.fn()}
        setPassword={setPassword}
        clearPassword={clearPassword}
        retry={vi.fn()}
        reconcile={vi.fn()}
        reload={vi.fn()}
      />,
    );
    const next = fixture.element.querySelector<HTMLInputElement>('input[name="newPassword"]')!;
    input(next, "intended password");
    click(Array.from(fixture.element.querySelectorAll("button")).find((button) => button.textContent === "Set password")!);
    expect(setPassword).toHaveBeenCalledWith("intended password", null);
    expect(fetch).not.toHaveBeenCalled();

    await fixture.render(
      <PasswordPanel
        state={passwordState({ protected: true, result: { action: "set", state: "succeeded", message: "Password saved." } })}
        onActivity={vi.fn()}
        setPassword={setPassword}
        clearPassword={clearPassword}
        retry={vi.fn()}
        reconcile={vi.fn()}
        reload={vi.fn()}
      />,
    );
    expect(fixture.element.querySelector<HTMLInputElement>('input[name="newPassword"]')?.value).toBe("");
    expect(fixture.element.querySelector('nav[aria-label="Representations"]')).toBeNull();
    expect(fixture.element.textContent).not.toContain("intended password");
    const exposed = Array.from(fixture.element.querySelectorAll("[data-password-status], [data-password-result]"))
      .flatMap((element) => Array.from(element.attributes))
      .some((attribute) => attribute.value.includes("intended password"));
    expect(exposed).toBe(false);

    const current = fixture.element.querySelector<HTMLInputElement>('input[name="currentPassword"]')!;
    input(current, "current");
    click(Array.from(fixture.element.querySelectorAll("button")).find((button) => button.textContent === "Clear password")!);
    expect(clearPassword).toHaveBeenCalledWith("current");
  });

  it("uses a replacement credential only to retry the already intended password operation", async () => {
    const setPassword = vi.fn();
    const retry = vi.fn();
    const fixture = await mount(
      <PasswordPanel
        state={passwordState()}
        onActivity={vi.fn()}
        setPassword={setPassword}
        clearPassword={vi.fn()}
        retry={retry}
        reconcile={vi.fn()}
        reload={vi.fn()}
      />,
    );
    input(fixture.element.querySelector<HTMLInputElement>('input[name="newPassword"]')!, "new password");
    click(Array.from(fixture.element.querySelectorAll("button")).find((button) => button.textContent === "Set password")!);
    expect(setPassword).toHaveBeenCalledWith("new password", null);

    await fixture.render(
      <PasswordPanel
        state={passwordState({ protected: false, result: { action: "set", state: "credential-required", message: "Password is missing or incorrect." } })}
        onActivity={vi.fn()}
        setPassword={setPassword}
        clearPassword={vi.fn()}
        retry={retry}
        reconcile={vi.fn()}
        reload={vi.fn()}
      />,
    );
    const replacement = fixture.element.querySelector<HTMLInputElement>('input[name="retryCredential"]')!;
    input(replacement, "replacement");
    click(Array.from(fixture.element.querySelectorAll("button")).find((button) => button.textContent === "Retry")!);
    expect(retry).toHaveBeenCalledWith("replacement");
    expect(setPassword).toHaveBeenCalledTimes(1);

    await fixture.render(
      <PasswordPanel
        state={passwordState({ protected: false, result: { action: "set", state: "credential-required", message: "Password is missing or incorrect." } })}
        onActivity={vi.fn()}
        setPassword={setPassword}
        clearPassword={vi.fn()}
        retry={retry}
        reconcile={vi.fn()}
        reload={vi.fn()}
      />,
    );
    expect(fixture.element.querySelector('nav[aria-label="Representations"]')).toBeNull();
  });

  it("asks the controller to reconcile uncertain password state without exposing a credential", async () => {
    const reconcile = vi.fn();
    const fixture = await mount(
      <PasswordPanel
        state={passwordState({ protected: true, reconciliationOwner: "password", result: { action: "clear", state: "reconciliation-required", message: "Request outcome is uncertain." } })}
        onActivity={vi.fn()}
        setPassword={vi.fn()}
        clearPassword={vi.fn()}
        retry={vi.fn()}
        reconcile={reconcile}
        reload={vi.fn()}
      />,
    );
    click(Array.from(fixture.element.querySelectorAll("button")).find((button) => button.textContent === "Reconcile")!);
    expect(reconcile).toHaveBeenCalledWith();
    expect(fixture.element.textContent).not.toContain("password=");
  });
});

describe("Delete result", () => {
  it("uses the shared Dialog with safe cancellation, focus return, and an explicit destructive confirmation", async () => {
    const deletePaste = vi.fn();
    const fixture = await mount(<DeleteFlow state={deleteState()} deletePaste={deletePaste} retry={vi.fn()} reload={vi.fn()} />);
    const trigger = Array.from(fixture.element.querySelectorAll("button")).find((button) => button.textContent === "Delete")!;
    React.act(() => trigger.focus());
    await clickDialogAction(trigger);
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Delete this paste permanently.");
    expect(document.activeElement?.textContent).toBe("Cancel");
    const destructive = dialog.querySelector<HTMLButtonElement>('button[data-variant="destructive"]')!;
    expect(destructive.textContent).toBe("Delete");

    await React.act(async () => {
      await userEvent.keyboard("{Escape}");
    });
    await drainDialogTransition();
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(deletePaste).not.toHaveBeenCalled();

    await clickDialogAction(trigger);
    await clickDialogAction(document.querySelector<HTMLElement>('[role="dialog"] button[data-variant="destructive"]')!);
    await drainDialogTransition();
    expect(deletePaste).toHaveBeenCalledWith(null);
  });

  it("disables deletion while another mutation is pending and has no cancel side effects", async () => {
    const deletePaste = vi.fn();
    const fixture = await mount(<DeleteFlow state={deleteState({ mutationPending: true })} deletePaste={deletePaste} retry={vi.fn()} reload={vi.fn()} />);
    const trigger = Array.from(fixture.element.querySelectorAll("button")).find((button) => button.textContent === "Delete")!;
    expect(trigger.disabled).toBe(true);
    click(trigger);
    expect(deletePaste).not.toHaveBeenCalled();
  });

  it("presents 204 as a root handoff and preserves ordinary controls for 403 and 409", async () => {
    const retry = vi.fn();
    const reload = vi.fn();
    const activity = vi.fn();
    const fixture = await mount(<DeleteFlow state={deleteState({ phase: "deleted-root-handoff", result: { state: "succeeded", message: "Paste deleted." } })} deletePaste={vi.fn()} retry={retry} reload={reload} onActivity={activity} />);
    expect(fixture.element.querySelector("[data-root-handoff]")).not.toBeNull();
    expect(fixture.element.querySelector("button")).toBeNull();

    await fixture.render(<DeleteFlow state={deleteState({ result: { state: "credential-required", message: "Password is missing or incorrect." } })} deletePaste={vi.fn()} retry={retry} reload={reload} onActivity={activity} />);
    expect(fixture.element.textContent).toContain("Password is missing or incorrect.");
    expect(Array.from(fixture.element.querySelectorAll("button")).some((button) => button.textContent === "Delete")).toBe(true);
    const credential = fixture.element.querySelector<HTMLInputElement>('input[name="deleteCredential"]')!;
    input(credential, "replacement");
    expect(activity).toHaveBeenCalledWith(expect.any(Number), "recovery-credential");
    click(Array.from(fixture.element.querySelectorAll("button")).find((button) => button.textContent === "Retry")!);
    expect(retry).toHaveBeenCalledWith("replacement");

    await fixture.render(<DeleteFlow state={deleteState({ versionUsable: false, result: { state: "conflict", message: "The paste changed." } })} deletePaste={vi.fn()} retry={retry} reload={reload} />);
    expect(Array.from(fixture.element.querySelectorAll("button")).some((button) => button.textContent === "Retry")).toBe(false);
    click(Array.from(fixture.element.querySelectorAll("button")).find((button) => button.textContent === "Reload")!);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("removes the delete server control for local not-found and uncertain delete terminals", async () => {
    const fixture = await mount(<DeleteFlow state={deleteState({ phase: "not-found", result: { state: "not-found", message: "The paste was not found." } })} deletePaste={vi.fn()} retry={vi.fn()} reload={vi.fn()} />);
    expect(fixture.element.textContent).toContain("The paste was not found.");
    expect(fixture.element.querySelector("button")).toBeNull();
    expect(fixture.element.querySelector("[data-server-controls]")).toBeNull();

    await fixture.render(<DeleteFlow state={deleteState({ phase: "delete-uncertain", result: { state: "uncertain", message: "Delete outcome is uncertain." } })} deletePaste={vi.fn()} retry={vi.fn()} reload={vi.fn()} />);
    expect(fixture.element.textContent).toContain("Delete outcome is uncertain.");
    expect(fixture.element.querySelector("button")).toBeNull();
    expect(fixture.element.querySelector("[data-server-controls]")).toBeNull();
  });
});

describe("management hardening regressions", () => {
  it("preserves each settings draft edited after its save dispatch", async () => {
    const saveTitle = vi.fn();
    const saveFormat = vi.fn();
    const saveExpiration = vi.fn();
    const saveViewOnce = vi.fn();
    const accepted = { id: "demo", title: "Accepted title", format: "text" as const, expiration: 3_600, viewOnce: false };
    const fixture = await mount(
      <SettingsPanel
        state={settingsState({ accepted })}
        onActivity={vi.fn()}
        saveTitle={saveTitle}
        saveFormat={saveFormat}
        saveExpiration={saveExpiration}
        saveViewOnce={saveViewOnce}
        retry={vi.fn()}
        reconcile={vi.fn()}
        reload={vi.fn()}
      />,
    );

    const title = fixture.element.querySelector<HTMLInputElement>('input[name="title"]')!;
    const format = fixture.element.querySelector('select[name="format"]') as unknown as { value: string; dispatchEvent(event: Event): boolean };
    const expiration = fixture.element.querySelector('select[name="expiration"]') as unknown as { value: string; dispatchEvent(event: Event): boolean };
    const viewOnce = fixture.element.querySelector<HTMLInputElement>('input[name="viewOnce"]')!;
    input(title, "Submitted title");
    click(Array.from(fixture.element.querySelectorAll("button")).find((button) => button.textContent === "Save title")!);
    input(title, "Newer title");
    change(format, "markdown");
    click(Array.from(fixture.element.querySelectorAll("button")).find((button) => button.textContent === "Save format")!);
    change(format, "text");
    change(expiration, "60");
    click(Array.from(fixture.element.querySelectorAll("button")).find((button) => button.textContent === "Save expiration")!);
    change(expiration, "3600");
    click(viewOnce);
    click(Array.from(fixture.element.querySelectorAll("button")).find((button) => button.textContent === "Save view once")!);
    click(viewOnce);

    await fixture.render(
      <SettingsPanel
        state={settingsState({ accepted: { ...accepted, title: "Submitted title", format: "markdown", expiration: 60, viewOnce: true }, result: { field: "title", state: "succeeded", message: "Title saved." } })}
        onActivity={vi.fn()}
        saveTitle={saveTitle}
        saveFormat={saveFormat}
        saveExpiration={saveExpiration}
        saveViewOnce={saveViewOnce}
        retry={vi.fn()}
        reconcile={vi.fn()}
        reload={vi.fn()}
      />,
    );
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    expect(title.value).toBe("Newer title");
    expect(format.value).toBe("text");
    expect(expiration.value).toBe("3600");
    expect(viewOnce.checked).toBe(false);
  });

  it("keeps settings and password recovery available without Discard buttons", async () => {
    const fixture = await mount(
      <>
        <SettingsPanel
          state={settingsState({ result: { field: "title", state: "retryable", message: "Storage write failed." } })}
          onActivity={vi.fn()}
          saveTitle={vi.fn()}
          saveFormat={vi.fn()}
          saveExpiration={vi.fn()}
          saveViewOnce={vi.fn()}
          retry={vi.fn()}
          reconcile={vi.fn()}
          reload={vi.fn()}
        />
        <PasswordPanel
          state={passwordState({ reconciliationOwner: "password", result: { action: "set", state: "reconciliation-required", message: "Request outcome is uncertain." } })}
          onActivity={vi.fn()}
          setPassword={vi.fn()}
          clearPassword={vi.fn()}
          retry={vi.fn()}
          reconcile={vi.fn()}
          reload={vi.fn()}
        />
      </>,
    );

    const buttons = Array.from(fixture.element.querySelectorAll("button"));
    expect(buttons.some((button) => button.textContent === "Discard")).toBe(false);
    expect(buttons.some((button) => button.textContent === "Retry")).toBe(true);
    expect(buttons.some((button) => button.textContent === "Reconcile")).toBe(true);
  });

  it("keeps settings writes blocked and Reload visible on an unusable version", async () => {
    const saveTitle = vi.fn();
    const saveFormat = vi.fn();
    const saveExpiration = vi.fn();
    const saveViewOnce = vi.fn();
    const reload = vi.fn();
    const fixture = await mount(
      <SettingsPanel
        state={settingsState({ versionUsable: false, result: { field: "title", state: "conflict", message: "The paste changed." } })}
        onActivity={vi.fn()}
        saveTitle={saveTitle}
        saveFormat={saveFormat}
        saveExpiration={saveExpiration}
        saveViewOnce={saveViewOnce}
        retry={vi.fn()}
        reconcile={vi.fn()}
        reload={reload}
      />,
    );

    expect(Array.from(fixture.element.querySelectorAll("button")).some((button) => button.textContent === "Discard")).toBe(false);
    const saves = Array.from(fixture.element.querySelectorAll<HTMLButtonElement>("button[data-settings-field]"));
    expect(saves).toHaveLength(4);
    for (const save of saves) {
      expect(save.disabled).toBe(true);
      save.disabled = false;
      click(save);
      React.act(() => save.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    }
    expect(saveTitle).not.toHaveBeenCalled();
    expect(saveFormat).not.toHaveBeenCalled();
    expect(saveExpiration).not.toHaveBeenCalled();
    expect(saveViewOnce).not.toHaveBeenCalled();

    click(Array.from(fixture.element.querySelectorAll("button")).find((button) => button.textContent === "Reload")!);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("retains authoritative pending settings authority when disabled saves are forced", async () => {
    const saveTitle = vi.fn();
    const saveFormat = vi.fn();
    const saveExpiration = vi.fn();
    const saveViewOnce = vi.fn();
    const fixture = await mount(
      <SettingsPanel
        state={settingsState({ result: { field: "title", state: "pending", message: "Saving title" } })}
        onActivity={vi.fn()}
        saveTitle={saveTitle}
        saveFormat={saveFormat}
        saveExpiration={saveExpiration}
        saveViewOnce={saveViewOnce}
        retry={vi.fn()}
        reconcile={vi.fn()}
        reload={vi.fn()}
      />,
    );

    const result = () => fixture.element.querySelector("[data-settings-action-result]")?.getAttribute("data-settings-action-result");
    expect(result()).toBe("pending");
    expect(Array.from(fixture.element.querySelectorAll("button")).some((button) => button.textContent === "Discard")).toBe(false);

    const saves = Array.from(fixture.element.querySelectorAll<HTMLButtonElement>("button[data-settings-field]"));
    expect(saves).toHaveLength(4);
    for (const save of saves) {
      expect(save.disabled).toBe(true);
      save.disabled = false;
      click(save);
      React.act(() => save.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    }
    expect(saveTitle).not.toHaveBeenCalled();
    expect(saveFormat).not.toHaveBeenCalled();
    expect(saveExpiration).not.toHaveBeenCalled();
    expect(saveViewOnce).not.toHaveBeenCalled();
  });

  it("keeps password drafts and exposes Reload only for an unusable conflict", async () => {
    const reload = vi.fn();
    const fixture = await mount(
      <PasswordPanel
        state={passwordState({ versionUsable: false, result: { action: "set", state: "conflict", message: "The paste changed." } })}
        onActivity={vi.fn()}
        setPassword={vi.fn()}
        clearPassword={vi.fn()}
        retry={vi.fn()}
        reconcile={vi.fn()}
        reload={reload}
      />,
    );

    const password = fixture.element.querySelector<HTMLInputElement>('input[name="newPassword"]')!;
    input(password, "newer password");
    const set = Array.from(fixture.element.querySelectorAll("button")).find((button) => button.textContent === "Set password")!;
    expect(set.disabled).toBe(true);
    expect(Array.from(fixture.element.querySelectorAll("button")).some((button) => button.textContent === "Retry" || button.textContent === "Reconcile")).toBe(false);
    click(Array.from(fixture.element.querySelectorAll("button")).find((button) => button.textContent === "Reload")!);
    expect(reload).toHaveBeenCalledOnce();
    expect(password.value).toBe("newer password");
  });

  it("keeps password writes blocked and Reload visible on an unusable version", async () => {
    const setPassword = vi.fn();
    const clearPassword = vi.fn();
    const retry = vi.fn();
    const reconcile = vi.fn();
    const reload = vi.fn();
    const fixture = await mount(
      <PasswordPanel
        state={passwordState({ protected: true, versionUsable: false, result: { action: "set", state: "conflict", message: "The paste changed." } })}
        onActivity={vi.fn()}
        setPassword={setPassword}
        clearPassword={clearPassword}
        retry={retry}
        reconcile={reconcile}
        reload={reload}
      />,
    );

    expect(Array.from(fixture.element.querySelectorAll("button")).some((button) => button.textContent === "Discard")).toBe(false);
    const changePassword = Array.from(fixture.element.querySelectorAll("button")).find((button) => button.textContent === "Change password")!;
    const clearPasswordButton = Array.from(fixture.element.querySelectorAll("button")).find((button) => button.textContent === "Clear password")!;
    expect(changePassword.disabled).toBe(true);
    expect(clearPasswordButton.disabled).toBe(true);
    expect(Array.from(fixture.element.querySelectorAll("button")).find((button) => button.textContent === "Reload")).toBeDefined();
    click(changePassword);
    click(clearPasswordButton);
    expect(setPassword).not.toHaveBeenCalled();
    expect(clearPassword).not.toHaveBeenCalled();

    await fixture.render(
      <PasswordPanel
        state={passwordState({ versionUsable: false, result: { action: "set", state: "credential-required", message: "Password is missing or incorrect." } })}
        onActivity={vi.fn()}
        setPassword={setPassword}
        clearPassword={clearPassword}
        retry={retry}
        reconcile={reconcile}
        reload={reload}
      />,
    );
    const retryButton = Array.from(fixture.element.querySelectorAll("button")).find((button) => button.textContent === "Retry")!;
    expect(retryButton.disabled).toBe(true);
    click(retryButton);
    expect(retry).not.toHaveBeenCalled();

    await fixture.render(
      <PasswordPanel
        state={passwordState({ versionUsable: false, reconciliationOwner: "password", result: { action: "set", state: "reconciliation-required", message: "Request outcome is uncertain." } })}
        onActivity={vi.fn()}
        setPassword={setPassword}
        clearPassword={clearPassword}
        retry={retry}
        reconcile={reconcile}
        reload={reload}
      />,
    );
    const reconcileButton = Array.from(fixture.element.querySelectorAll("button")).find((button) => button.textContent === "Reconcile")!;
    expect(reconcileButton.disabled).toBe(false);
    click(reconcileButton);
    expect(reconcile).toHaveBeenCalledOnce();
  });

  it("retains authoritative pending password authority when disabled actions are forced", async () => {
    const setPassword = vi.fn();
    const clearPassword = vi.fn();
    const fixture = await mount(
      <PasswordPanel
        state={passwordState({ result: { action: "set", state: "pending", message: "Saving password" } })}
        onActivity={vi.fn()}
        setPassword={setPassword}
        clearPassword={clearPassword}
        retry={vi.fn()}
        reconcile={vi.fn()}
        reload={vi.fn()}
      />,
    );

    const result = () => fixture.element.querySelector("[data-password-result]")?.getAttribute("data-password-result");
    expect(result()).toBe("pending");
    expect(Array.from(fixture.element.querySelectorAll("button")).some((button) => button.textContent === "Discard")).toBe(false);

    const set = Array.from(fixture.element.querySelectorAll("button")).find((button) => button.textContent === "Set password")!;
    expect(set.disabled).toBe(true);
    set.disabled = false;
    click(set);
    React.act(() => set.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(setPassword).not.toHaveBeenCalled();

    await fixture.render(
      <PasswordPanel
        key="protected"
        state={passwordState({ protected: true, result: { action: "set", state: "pending", message: "Saving password" } })}
        onActivity={vi.fn()}
        setPassword={setPassword}
        clearPassword={clearPassword}
        retry={vi.fn()}
        reconcile={vi.fn()}
        reload={vi.fn()}
      />,
    );
    const changePassword = Array.from(fixture.element.querySelectorAll("button")).find((button) => button.textContent === "Change password")!;
    const clearPasswordButton = Array.from(fixture.element.querySelectorAll("button")).find((button) => button.textContent === "Clear password")!;
    expect(result()).toBe("pending");
    expect(Array.from(fixture.element.querySelectorAll("button")).some((button) => button.textContent === "Discard")).toBe(false);
    for (const action of [changePassword, clearPasswordButton]) {
      expect(action.disabled).toBe(true);
      action.disabled = false;
      click(action);
      React.act(() => action.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    }
    expect(setPassword).not.toHaveBeenCalled();
    expect(clearPassword).not.toHaveBeenCalled();
  });

  it("uses the blocked delete predicate for credential and conflict retries", async () => {
    const retry = vi.fn();
    const fixture = await mount(<DeleteFlow state={deleteState({ mutationPending: true, result: { state: "credential-required", message: "Password is missing or incorrect." } })} deletePaste={vi.fn()} retry={retry} reload={vi.fn()} />);
    let retryButton = Array.from(fixture.element.querySelectorAll("button")).find((button) => button.textContent === "Retry")!;
    expect(retryButton.disabled).toBe(true);
    click(retryButton);
    expect(retry).not.toHaveBeenCalled();

    await fixture.render(<DeleteFlow state={deleteState({ versionUsable: false, result: { state: "credential-required", message: "Password is missing or incorrect." } })} deletePaste={vi.fn()} retry={retry} reload={vi.fn()} />);
    retryButton = Array.from(fixture.element.querySelectorAll("button")).find((button) => button.textContent === "Retry")!;
    expect(retryButton.disabled).toBe(true);
    click(retryButton);
    expect(retry).not.toHaveBeenCalled();

    await fixture.render(<DeleteFlow state={deleteState({ mutationPending: true, result: { state: "conflict", message: "The paste changed." } })} deletePaste={vi.fn()} retry={retry} reload={vi.fn()} />);
    retryButton = Array.from(fixture.element.querySelectorAll("button")).find((button) => button.textContent === "Retry")!;
    expect(retryButton.disabled).toBe(true);
    click(retryButton);
    expect(retry).not.toHaveBeenCalled();
  });

  it("resets mobile history to the list when an inactive visit becomes active", async () => {
    await page.viewport(375, 720);
    const fixture = await mount(history(
      <HistoryPanel active state={historyState({ selected: null, snapshotState: "idle", diff: { state: "idle", lines: [] } })} openHistory={vi.fn()} selectRevision={vi.fn()} computeDiff={vi.fn()} back={vi.fn()} />,
    ));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    click(Array.from(fixture.element.querySelectorAll("button")).find((button) => button.textContent === "Revision 2")!);
    await fixture.render(history(
      <HistoryPanel active state={historyState()} openHistory={vi.fn()} selectRevision={vi.fn()} computeDiff={vi.fn()} back={vi.fn()} />,
    ));
    expect(fixture.element.querySelector("[data-history-detail]")).not.toBeNull();

    await fixture.render(history(
      <HistoryPanel active={false} state={historyState()} openHistory={vi.fn()} selectRevision={vi.fn()} computeDiff={vi.fn()} back={vi.fn()} />,
    ));
    await fixture.render(history(
      <HistoryPanel active state={historyState()} openHistory={vi.fn()} selectRevision={vi.fn()} computeDiff={vi.fn()} back={vi.fn()} />,
    ));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(fixture.element.querySelector("[data-history-list]")).not.toBeNull();
    expect(fixture.element.querySelector("[data-history-detail]")).toBeNull();
  });

  it("blocks delete before opening when the version is unusable and offers Reload only", async () => {
    const deletePaste = vi.fn();
    const reload = vi.fn();
    const fixture = await mount(<DeleteFlow state={deleteState({ versionUsable: false, result: { state: "conflict", message: "The paste changed." } })} deletePaste={deletePaste} retry={vi.fn()} reload={reload} />);
    const trigger = Array.from(fixture.element.querySelectorAll("button")).find((button) => button.textContent === "Delete")!;
    expect(trigger.disabled).toBe(true);
    click(trigger);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(Array.from(fixture.element.querySelectorAll("button")).some((button) => button.textContent === "Retry")).toBe(false);
    click(Array.from(fixture.element.querySelectorAll("button")).find((button) => button.textContent === "Reload")!);
    expect(reload).toHaveBeenCalledOnce();
    expect(deletePaste).not.toHaveBeenCalled();
  });

  it("closes or disables a delete confirmation when another mutation begins", async () => {
    const deletePaste = vi.fn();
    const fixture = await mount(<DeleteFlow state={deleteState()} deletePaste={deletePaste} retry={vi.fn()} reload={vi.fn()} />);
    await clickDialogAction(Array.from(fixture.element.querySelectorAll("button")).find((button) => button.textContent === "Delete")!);
    await fixture.render(<DeleteFlow state={deleteState({ mutationPending: true })} deletePaste={deletePaste} retry={vi.fn()} reload={vi.fn()} />);
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    const destructive = dialog?.querySelector<HTMLButtonElement>('button[data-variant="destructive"]');
    expect(dialog === null || destructive?.disabled === true).toBe(true);
    if (destructive !== null && destructive !== undefined) await clickDialogAction(destructive);
    expect(deletePaste).not.toHaveBeenCalled();
  });

  it("renders exact options for absolute and non-preset relative expiration drafts", async () => {
    const saveExpiration = vi.fn();
    const absolute = "2026-10-01T12:34:56.000Z";
    const fixture = await mount(
      <SettingsPanel
        state={settingsState({ accepted: { id: "demo", title: "Accepted title", format: "text", expiration: absolute, viewOnce: false } })}
        onActivity={vi.fn()}
        saveTitle={vi.fn()}
        saveFormat={vi.fn()}
        saveExpiration={saveExpiration}
        saveViewOnce={vi.fn()}
        retry={vi.fn()}
        reconcile={vi.fn()}
        reload={vi.fn()}
      />,
    );
    const expiration = fixture.element.querySelector('select[name="expiration"]') as unknown as { value: string; selectedOptions: { [index: number]: { textContent: string | null } | undefined } };
    expect(expiration.value).toBe(absolute);
    expect(expiration.selectedOptions[0]?.textContent).toBe(absolute);
    click(Array.from(fixture.element.querySelectorAll("button")).find((button) => button.textContent === "Save expiration")!);
    expect(saveExpiration).toHaveBeenCalledWith(absolute);

    await fixture.render(
      <SettingsPanel
        state={settingsState({ accepted: { id: "demo", title: "Accepted title", format: "text", expiration: 42, viewOnce: false } })}
        onActivity={vi.fn()}
        saveTitle={vi.fn()}
        saveFormat={vi.fn()}
        saveExpiration={saveExpiration}
        saveViewOnce={vi.fn()}
        retry={vi.fn()}
        reconcile={vi.fn()}
        reload={vi.fn()}
      />,
    );
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(expiration.value).toBe("42");
    expect(expiration.selectedOptions[0]?.textContent).toBe("42");
    click(Array.from(fixture.element.querySelectorAll("button")).find((button) => button.textContent === "Save expiration")!);
    expect(saveExpiration).toHaveBeenLastCalledWith(42);
  });

  it("uses list-only and detail-only mobile history states with Back in every detail phase", async () => {
    await page.viewport(375, 720);
    const back = vi.fn();
    const selectRevision = vi.fn();
    const fixture = await mount(history(
      <HistoryPanel
        active
        state={historyState({ selected: null, snapshotState: "idle", diff: { state: "idle", lines: [] } })}
        openHistory={vi.fn()}
        selectRevision={selectRevision}
        computeDiff={vi.fn()}
        back={back}
      />,
    ));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(fixture.element.querySelector("[data-history-list]")).not.toBeNull();
    expect(fixture.element.querySelector("[data-history-detail]")).toBeNull();
    click(Array.from(fixture.element.querySelectorAll("button")).find((button) => button.textContent === "Revision 2")!);
    expect(selectRevision).toHaveBeenCalledWith(2);

    await fixture.render(history(
      <HistoryPanel active state={historyState({ selected: null, snapshotState: "loading", diff: { state: "idle", lines: [] } })} openHistory={vi.fn()} selectRevision={selectRevision} computeDiff={vi.fn()} back={back} />,
    ));
    expect(fixture.element.querySelector("[data-history-list]")).toBeNull();
    expect(fixture.element.querySelector("[data-history-detail]")).not.toBeNull();
    click(Array.from(fixture.element.querySelectorAll("button")).find((button) => button.textContent === "Back")!);
    expect(back).toHaveBeenCalledOnce();
    await fixture.render(history(
      <HistoryPanel active state={historyState({ selected: null, snapshotState: "idle", diff: { state: "idle", lines: [] } })} openHistory={vi.fn()} selectRevision={selectRevision} computeDiff={vi.fn()} back={back} />,
    ));
    click(Array.from(fixture.element.querySelectorAll("button")).find((button) => button.textContent === "Revision 2")!);

    await fixture.render(history(
      <HistoryPanel active state={historyState({ selected: null, snapshotState: "failed", failure: { target: "snapshot", value: { status: 503, code: "STORAGE_READ_FAILED" } }, diff: { state: "idle", lines: [] } })} openHistory={vi.fn()} selectRevision={selectRevision} computeDiff={vi.fn()} back={back} />,
    ));
    expect(fixture.element.querySelector("[data-history-list]")).toBeNull();
    expect(Array.from(fixture.element.querySelectorAll("button")).some((button) => button.textContent === "Back")).toBe(true);
  });

  it("localizes management names and status copy in Chinese", async () => {
    const fixture = await mount(history(
      <>
        <SettingsPanel state={settingsState({ result: { field: "title", state: "pending", message: null } })} onActivity={vi.fn()} saveTitle={vi.fn()} saveFormat={vi.fn()} saveExpiration={vi.fn()} saveViewOnce={vi.fn()} retry={vi.fn()} reconcile={vi.fn()} reload={vi.fn()} locale="zh-CN" />
        <PasswordPanel state={passwordState({ result: { action: "set", state: "pending", message: null } })} onActivity={vi.fn()} setPassword={vi.fn()} clearPassword={vi.fn()} retry={vi.fn()} reconcile={vi.fn()} reload={vi.fn()} locale="zh-CN" />
        <DeleteFlow state={deleteState({ result: { state: "pending", message: null } })} deletePaste={vi.fn()} retry={vi.fn()} reload={vi.fn()} locale="zh-CN" />
        <HistoryPanel active state={historyState({ diff: { state: "computing", lines: [] } })} openHistory={vi.fn()} selectRevision={vi.fn()} computeDiff={vi.fn()} back={vi.fn()} locale="zh-CN" />
      </>,
    ));
    expect(fixture.element.querySelector('[aria-label="设置"]')).not.toBeNull();
    expect(fixture.element.textContent).toContain("保存标题");
    expect(fixture.element.querySelector('[aria-label="密码"]')).not.toBeNull();
    expect(fixture.element.textContent).toContain("设置密码");
    expect(fixture.element.querySelector('[aria-label="删除剪贴板"]')).not.toBeNull();
    expect(fixture.element.textContent).toContain("正在删除");
    expect(fixture.element.querySelector('[aria-label="历史记录"]')).not.toBeNull();
    expect(fixture.element.textContent).toContain("计算差异");
  });

  it("uses expiration intent to reserve rewrite copy for relative seconds", async () => {
    const fixture = await mount(
      <SettingsPanel
        state={settingsState({ reconciliationOwner: "expiration", result: { field: "expiration", state: "reconciliation-required", message: null, reconciliationIntent: "relative" } })}
        onActivity={vi.fn()}
        saveTitle={vi.fn()}
        saveFormat={vi.fn()}
        saveExpiration={vi.fn()}
        saveViewOnce={vi.fn()}
        retry={vi.fn()}
        reconcile={vi.fn()}
        reload={vi.fn()}
      />,
    );
    const resultButtons = () => Array.from(fixture.element.querySelectorAll<HTMLButtonElement>("[data-settings-result] button"));
    expect(resultButtons()).toHaveLength(1);
    expect(resultButtons()[0]?.textContent).toBe("Save expiration");
    expect(resultButtons().some((button) => button.textContent === "Reconcile")).toBe(false);

    await fixture.render(
      <SettingsPanel
        state={settingsState({ reconciliationOwner: "expiration", result: { field: "expiration", state: "reconciliation-required", message: null, reconciliationIntent: "permanent" } })}
        onActivity={vi.fn()}
        saveTitle={vi.fn()}
        saveFormat={vi.fn()}
        saveExpiration={vi.fn()}
        saveViewOnce={vi.fn()}
        retry={vi.fn()}
        reconcile={vi.fn()}
        reload={vi.fn()}
      />,
    );
    expect(resultButtons()).toHaveLength(1);
    expect(resultButtons()[0]?.textContent).toBe("Reconcile");
    expect(resultButtons().some((button) => button.textContent === "Save expiration")).toBe(false);

    await fixture.render(
      <SettingsPanel
        state={settingsState({ reconciliationOwner: "expiration", result: { field: "expiration", state: "reconciliation-required", message: null, reconciliationIntent: "absolute" } })}
        onActivity={vi.fn()}
        saveTitle={vi.fn()}
        saveFormat={vi.fn()}
        saveExpiration={vi.fn()}
        saveViewOnce={vi.fn()}
        retry={vi.fn()}
        reconcile={vi.fn()}
        reload={vi.fn()}
      />,
    );
    expect(resultButtons()).toHaveLength(1);
    expect(resultButtons()[0]?.textContent).toBe("Reconcile");
    expect(resultButtons().some((button) => button.textContent === "Save expiration")).toBe(false);
  });

  it("announces credential, conflict, and retryable Settings errors", async () => {
    const props = { onActivity: vi.fn(), saveTitle: vi.fn(), saveFormat: vi.fn(), saveExpiration: vi.fn(), saveViewOnce: vi.fn(), retry: vi.fn(), reconcile: vi.fn(), reload: vi.fn() };
    const fixture = await mount(<SettingsPanel state={settingsState()} {...props} />);
    for (const [state, message] of [["credential-required", "Password required"], ["conflict", "Version conflict"], ["retryable", "Storage write failed"]] as const) {
      await fixture.render(<SettingsPanel state={settingsState({ result: { field: "title", state, message } })} {...props} />);
      expect(fixture.element.querySelector('[data-settings-result] [role="alert"]')?.textContent).toBe(message);
    }
  });

  it("keeps button outcomes out of live regions and alerts for blocking validation", async () => {
    const fixture = await mount(
      <>
        <SettingsPanel state={settingsState({ result: { field: "title", state: "pending", message: "Saving title" } })} onActivity={vi.fn()} saveTitle={vi.fn()} saveFormat={vi.fn()} saveExpiration={vi.fn()} saveViewOnce={vi.fn()} retry={vi.fn()} reconcile={vi.fn()} reload={vi.fn()} />
        <PasswordPanel state={passwordState({ result: { action: "set", state: "succeeded", message: "Password saved." } })} onActivity={vi.fn()} setPassword={vi.fn()} clearPassword={vi.fn()} retry={vi.fn()} reconcile={vi.fn()} reload={vi.fn()} />
        <DeleteFlow state={deleteState({ result: { state: "pending", message: "Deleting" } })} deletePaste={vi.fn()} retry={vi.fn()} reload={vi.fn()} />
        <SettingsPanel state={settingsState({ result: { field: "title", state: "validation-error", message: "Title is too long." } })} onActivity={vi.fn()} saveTitle={vi.fn()} saveFormat={vi.fn()} saveExpiration={vi.fn()} saveViewOnce={vi.fn()} retry={vi.fn()} reconcile={vi.fn()} reload={vi.fn()} />
      </>,
    );
    expect(fixture.element.querySelectorAll('[role="status"]')).toHaveLength(2);
    expect(fixture.element.querySelectorAll('[role="alert"]')).toHaveLength(1);
  });

  it("does not attach large-diff help to an empty history", async () => {
    const fixture = await mount(history(
      <HistoryPanel active state={historyState({ list: { id: "demo", currentRevision: 0, currentVersion: "generation.0", revisions: [] }, selected: null, snapshotState: "idle", diff: { state: "idle", lines: [] } })} openHistory={vi.fn()} selectRevision={vi.fn()} computeDiff={vi.fn()} back={vi.fn()} />,
    ));
    expect(fixture.element.textContent).toContain("No revisions");
    expect(Array.from(fixture.element.querySelectorAll("button")).some((button) => button.getAttribute("aria-label") === "Help")).toBe(false);
  });
});
