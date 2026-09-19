import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import * as React from "react";
import type { ReactNode } from "react";
import { HelpProvider } from "./HelpTrigger";
import { HistoryPanel } from "./HistoryPanel";
import { SettingsPanel } from "./SettingsPanel";
import { PasswordPanel } from "./PasswordPanel";
import { DeleteFlow } from "./DeleteFlow";
import "../index.css";

const mounted: Array<{ root: Root; element: HTMLDivElement }> = [];

async function mount(node: ReactNode) {
  const element = document.createElement("div");
  document.body.appendChild(element);
  const root = createRoot(element);
  flushSync(() => root.render(node));
  mounted.push({ root, element });
  return {
    element,
    async render(next: ReactNode): Promise<void> {
      flushSync(() => root.render(next));
      await Promise.resolve();
    },
  };
}

function click(element: Element): void {
  flushSync(() => (element as HTMLButtonElement).click());
}

function waitForFocus(element: Element): Promise<void> {
  if (document.activeElement === element) return Promise.resolve();
  return new Promise((resolve) => {
    const onFocus = () => {
      if (document.activeElement !== element) return;
      document.removeEventListener("focusin", onFocus);
      resolve();
    };
    document.addEventListener("focusin", onFocus);
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
    flushSync(() => value.root.unmount());
    value.element.remove();
  }
  await page.viewport(1280, 720);
  vi.restoreAllMocks();
});

describe("history lazy load", () => {
  it("loads history only after the History destination opens", async () => {
    const openHistory = vi.fn();
    const fixture = await mount(<HistoryPanel active={false} state={historyState()} openHistory={openHistory} selectRevision={vi.fn()} computeDiff={vi.fn()} back={vi.fn()} />);
    expect(openHistory).not.toHaveBeenCalled();
    await fixture.render(<HistoryPanel active state={historyState()} openHistory={openHistory} selectRevision={vi.fn()} computeDiff={vi.fn()} back={vi.fn()} />);
    expect(openHistory).toHaveBeenCalledTimes(1);
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

  it("keeps the list layout on mobile until a revision is selected, then returns with Back", async () => {
    await page.viewport(375, 720);
    const back = vi.fn();
    const fixture = await mount(history(
      <HistoryPanel
        active
        state={historyState({ snapshotState: "idle", selected: null, diff: { state: "idle", lines: [] } })}
        openHistory={vi.fn()}
        selectRevision={vi.fn()}
        computeDiff={vi.fn()}
        back={back}
      />,
    ));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(fixture.element.querySelector("[data-history-list]")).not.toBeNull();
    expect(fixture.element.querySelector("[data-history-detail]")).toBeNull();

    await fixture.render(history(
      <HistoryPanel active state={historyState()} openHistory={vi.fn()} selectRevision={vi.fn()} computeDiff={vi.fn()} back={back} />,
    ));
    expect(fixture.element.querySelector("[data-history-detail]")).not.toBeNull();
    click(Array.from(fixture.element.querySelectorAll("button")).find((button) => button.textContent === "Back")!);
    expect(back).toHaveBeenCalledTimes(1);
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
});

function settingsState(overrides: Record<string, unknown> = {}) {
  return {
    accepted: { id: "demo", title: "Accepted title", format: "text" as const, expiration: 3_600, viewOnce: false },
    versionUsable: true,
    result: { field: null, state: "idle" as const, message: null },
    ...overrides,
  };
}

function passwordState(overrides: Record<string, unknown> = {}) {
  return {
    protected: false,
    result: { action: null, state: "idle" as const, message: null },
    currentUrl: "/demo",
    representations: [
      { label: "Raw", href: "/raw/demo" },
      { label: "HTML", href: "/html/demo" },
    ],
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
  flushSync(() => {
    element.value = value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function change(element: { value: string; dispatchEvent(event: Event): boolean }, value: string): void {
  flushSync(() => {
    element.value = value;
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("settings result table", () => {
  it("keeps separate controlled drafts, reports activity only for field input, and saves one field at a time", async () => {
    const activity = vi.fn();
    const saveTitle = vi.fn();
    const saveFormat = vi.fn();
    const saveExpiration = vi.fn();
    const saveViewOnce = vi.fn();
    const fixture = await mount(
      <SettingsPanel
        state={settingsState()}
        onActivity={activity}
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
    expect(activity).toHaveBeenCalledTimes(1);
    expect(activity.mock.calls[0]?.[0]).toEqual(expect.any(Number));
    click(Array.from(fixture.element.querySelectorAll("button")).find((button) => button.textContent === "Save title")!);
    expect(saveTitle).toHaveBeenCalledOnce();
    expect(saveTitle).toHaveBeenCalledWith("Draft title");
    expect(activity).toHaveBeenCalledTimes(1);

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

  it("offers the outcome-specific recovery and restores the latest accepted draft on Discard", async () => {
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
        state={settingsState({ accepted: { id: "demo", title: "Latest accepted", format: "text", expiration: 3_600, viewOnce: false }, result: { field: "expiration", state: "reconciliation-required", message: "Request outcome is uncertain." } })}
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
    const reconcileButton = Array.from(fixture.element.querySelectorAll("button")).find((button) => button.textContent?.includes("new full rewrite"))!;
    click(reconcileButton);
    expect(reconcile).toHaveBeenCalledTimes(1);
    const title = fixture.element.querySelector<HTMLInputElement>('input[name="title"]')!;
    input(title, "Discard me");
    click(Array.from(fixture.element.querySelectorAll("button")).find((button) => button.textContent === "Discard")!);
    expect(title.value).toBe("Latest accepted");
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
      />,
    );
    const next = fixture.element.querySelector<HTMLInputElement>('input[name="newPassword"]')!;
    input(next, "intended password");
    click(Array.from(fixture.element.querySelectorAll("button")).find((button) => button.textContent === "Set password")!);
    expect(setPassword).toHaveBeenCalledWith("intended password", null);
    expect(fetch).not.toHaveBeenCalled();

    await fixture.render(
      <PasswordPanel
        state={passwordState({ protected: true, result: { action: "set", state: "succeeded", message: "Password saved." }, currentUrl: "/demo?password=intended%20password", representations: [{ label: "Raw", href: "/raw/demo?password=intended%20password" }] })}
        onActivity={vi.fn()}
        setPassword={setPassword}
        clearPassword={clearPassword}
        retry={vi.fn()}
        reconcile={vi.fn()}
      />,
    );
    expect(fixture.element.querySelector<HTMLInputElement>('input[name="newPassword"]')?.value).toBe("");
    expect(fixture.element.querySelector('a[aria-label="Current URL"]')?.getAttribute("href")).toBe("/demo?password=intended%20password");
    expect(fixture.element.querySelector('a[href="/raw/demo?password=intended%20password"]')?.textContent).toBe("Raw");
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
      />,
    );
    expect(fixture.element.querySelector('a[aria-label="Current URL"]')?.getAttribute("href")).toBe("/demo");
  });

  it("asks the controller to reconcile uncertain password state without exposing a credential", async () => {
    const reconcile = vi.fn();
    const fixture = await mount(
      <PasswordPanel
        state={passwordState({ protected: true, result: { action: "clear", state: "reconciliation-required", message: "Request outcome is uncertain." } })}
        onActivity={vi.fn()}
        setPassword={vi.fn()}
        clearPassword={vi.fn()}
        retry={vi.fn()}
        reconcile={reconcile}
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
    trigger.focus();
    click(trigger);
    await Promise.resolve();
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Delete this paste permanently.");
    expect(document.activeElement?.textContent).toBe("Cancel");
    const destructive = dialog.querySelector<HTMLButtonElement>('button[data-variant="destructive"]')!;
    expect(destructive.textContent).toBe("Delete");

    flushSync(() => dialog.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })));
    await Promise.resolve();
    expect(document.querySelector('[role="dialog"]')?.getAttribute("data-state")).toBe("closed");
    expect(deletePaste).not.toHaveBeenCalled();
    await waitForFocus(trigger);
    expect(document.activeElement).toBe(trigger);

    click(trigger);
    await Promise.resolve();
    click(document.querySelector<HTMLElement>('[role="dialog"] button[data-variant="destructive"]')!);
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
    const fixture = await mount(<DeleteFlow state={deleteState({ phase: "deleted-root-handoff", result: { state: "succeeded", message: "Paste deleted." } })} deletePaste={vi.fn()} retry={retry} reload={reload} />);
    expect(fixture.element.querySelector("[data-root-handoff]")).not.toBeNull();
    expect(fixture.element.querySelector("button")).toBeNull();

    await fixture.render(<DeleteFlow state={deleteState({ result: { state: "credential-required", message: "Password is missing or incorrect." } })} deletePaste={vi.fn()} retry={retry} reload={reload} />);
    expect(fixture.element.textContent).toContain("Password is missing or incorrect.");
    expect(Array.from(fixture.element.querySelectorAll("button")).some((button) => button.textContent === "Delete")).toBe(true);
    const credential = fixture.element.querySelector<HTMLInputElement>('input[name="deleteCredential"]')!;
    input(credential, "replacement");
    click(Array.from(fixture.element.querySelectorAll("button")).find((button) => button.textContent === "Retry")!);
    expect(retry).toHaveBeenCalledWith("replacement");

    await fixture.render(<DeleteFlow state={deleteState({ versionUsable: false, result: { state: "conflict", message: "The paste changed." } })} deletePaste={vi.fn()} retry={retry} reload={reload} />);
    const conflictRetry = Array.from(fixture.element.querySelectorAll("button")).find((button) => button.textContent === "Retry")!;
    expect(conflictRetry.disabled).toBe(true);
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
