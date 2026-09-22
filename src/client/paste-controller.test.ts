import { describe, expect, it, vi } from "vitest";
import type { MutationResult, PasteSummary } from "../types";
import type { RemoteSnapshot } from "./contracts";
import {
  createPasteController,
  type ContentReconcileResult,
  type MetadataReconcileResult,
  type PasteController,
  type PasteControllerSnapshot,
  type ReconcileReadFailure,
  type RemoteApplyActionClaim,
} from "./paste-controller";

function summary(overrides: Partial<PasteSummary> = {}): PasteSummary {
  return {
    id: "paste",
    title: "",
    format: "text",
    viewOnce: false,
    protected: false,
    createdAt: null,
    updatedAt: "2026-09-15T00:00:00.000Z",
    expiresAt: null,
    expiration: "never",
    version: "g.1",
    contentRevision: 1,
    contentBytes: 3,
    createdCountry: null,
    links: { view: "", raw: "", html: "", markdown: "", file: "" },
    ...overrides,
  } as PasteSummary;
}

function mutationResult(overrides: Partial<MutationResult> & { content?: string; etag?: `"sha256-${string}"` } = {}): MutationResult & {
  content?: string;
  etag?: `"sha256-${string}"`;
} {
  return {
    changed: true,
    paste: summary({ version: "g.2", contentRevision: 2, updatedAt: "2026-09-15T00:00:01.000Z" }),
    ...overrides,
  };
}

function pasteControllerFixture(overrides: Partial<Parameters<typeof createPasteController>[0]> = {}) {
  const activity = vi.fn();
  const controller = createPasteController({
    accepted: {
      acceptedSource: "one",
      draft: "one",
      summary: summary(),
      version: "g.1",
      versionUsable: true,
      contentRevision: 1,
      updatedAt: "2026-09-15T00:00:00.000Z",
      responseEtag: '"sha256-one"',
      acceptedApplyGeneration: 1,
      localGeneration: 0,
      displayGeneration: 1,
    },
    onSourceActivity: activity,
    ...overrides,
  });
  return { controller, activity };
}

function dispatch(controller: PasteController, intent: Parameters<PasteController["startMutation"]>[0]) {
  const started = controller.startMutation(intent, 0);
  if (started.kind !== "dispatch") throw new Error("expected mutation dispatch");
  return started;
}

function snapshot(controller: PasteController): PasteControllerSnapshot {
  return controller.snapshot();
}

function reloadSnapshot(overrides: Partial<RemoteSnapshot> = {}): RemoteSnapshot {
  return {
    etag: '"sha256-remote"',
    source: "remote",
    summary: summary({ version: "g.2", contentRevision: 2, updatedAt: "2026-09-15T00:00:01.000Z" }),
    identity: { kind: "v2", generation: "g", versionCounter: 2 },
    contentRevision: 2,
    updatedAtMs: Date.parse("2026-09-15T00:00:01.000Z"),
    ...overrides,
  };
}

function remoteApplyOptions(controller: PasteController, action: RemoteApplyActionClaim = null) {
  const current = snapshot(controller);
  if (current.resource !== "active") throw new Error("expected active controller");
  return {
    expectedBaseline: {
      acceptedApplyGeneration: current.acceptedApplyGeneration,
      localGeneration: current.localGeneration,
      generation: "g",
      version: current.version,
      contentRevision: current.contentRevision,
      updatedAt: current.updatedAt,
      acceptedSource: current.acceptedSource,
    },
    expectedDraft: current.draft,
    targetDisplayGeneration: current.displayGeneration + 1,
    action,
  };
}

describe("PasteController mutation slot", () => {
  it("serializes autosave and settings while retaining one latest source intent", () => {
    const { controller } = pasteControllerFixture();
    const save = dispatch(controller, { kind: "content", action: "autosave", content: "one", omitVersion: false });

    expect(controller.startMutation({ kind: "settings-title", action: "settings-title", title: "T" }, 1).kind).toBe("blocked");
    controller.sourceEvent({ type: "input", content: "two", eventAt: 10 });
    controller.sourceEvent({ type: "input", content: "three", eventAt: 11 });
    expect(snapshot(controller).coalescedSource).toBe("three");

    expect(controller.acceptContentMutation(save.token, mutationResult(), 12)).toBe(true);
    expect(controller.effects().filter((effect) => effect.type === "autosave-slot-available")).toHaveLength(1);
    expect(controller.effects().filter((effect) => effect.type === "dispatch-content")).toHaveLength(0);
  });

  it("commits only the credential that an authorized read proved", () => {
    const { controller } = pasteControllerFixture({ credential: { committed: "old", pending: "new" } });

    expect(controller.commitProvenCredential("wrong")).toBe(false);
    expect(controller.commitProvenCredential("new")).toBe(true);
    expect(snapshot(controller).credential).toEqual({ committed: "new", pending: null });
    expect(controller.effects()).toContainEqual({ type: "credential-commit", credential: "new" });
  });

  it("records wall-clock status timestamps when mutations use monotonic time", () => {
    const { controller } = pasteControllerFixture({ wallNow: () => "2026-09-15T12:00:00.000Z" });
    const save = dispatch(controller, { kind: "content", action: "autosave", content: "two", omitVersion: false });

    expect(snapshot(controller).lastAction).toMatchObject({ startedAt: "2026-09-15T12:00:00.000Z" });
    controller.acceptContentMutation(save.token, mutationResult(), 2);
    expect(snapshot(controller).lastAction).toMatchObject({ settledAt: "2026-09-15T12:00:00.000Z" });
  });

  it("settles only the current local action attempt", () => {
    const { controller } = pasteControllerFixture();

    controller.recordLocalAction({ key: "copy", state: "pending", attempt: 1, startedAt: "2026-09-20T00:00:00.000Z" });
    controller.recordLocalAction({ key: "download", state: "pending", attempt: 2, startedAt: "2026-09-20T00:00:01.000Z" });
    controller.recordLocalAction({ key: "copy", state: "succeeded", attempt: 1, startedAt: "2026-09-20T00:00:00.000Z", settledAt: "2026-09-20T00:00:02.000Z" });

    expect(snapshot(controller).lastAction).toEqual({ state: "pending", key: "download", attempt: 2, startedAt: "2026-09-20T00:00:01.000Z" });

    controller.recordLocalAction({ key: "download", state: "succeeded", attempt: 2, startedAt: "2026-09-20T00:00:01.000Z", settledAt: "2026-09-20T00:00:03.000Z" });
    expect(snapshot(controller).lastAction).toEqual({ state: "succeeded", key: "download", attempt: 2, startedAt: "2026-09-20T00:00:01.000Z", settledAt: "2026-09-20T00:00:03.000Z", outcomeKey: null });
  });

  it("does not let an autosave callback settle a later Copy action", () => {
    const { controller } = pasteControllerFixture();
    const save = dispatch(controller, { kind: "content", action: "autosave", content: "two", omitVersion: false });
    controller.recordLocalAction({ key: "copy", state: "pending", attempt: 7, startedAt: "2026-09-20T00:00:00.000Z" });

    expect(controller.acceptContentMutation(save.token, mutationResult(), 1)).toBe(true);

    expect(snapshot(controller).lastAction).toEqual({ state: "pending", key: "copy", attempt: 7, startedAt: "2026-09-20T00:00:00.000Z" });
  });

  it("retains only one autosave when settings owns the slot", () => {
    const { controller } = pasteControllerFixture();
    const title = dispatch(controller, { kind: "settings-title", action: "settings-title", title: "T" });

    controller.sourceEvent({ type: "input", content: "two", eventAt: 1 });
    controller.sourceEvent({ type: "input", content: "three", eventAt: 2 });
    expect(snapshot(controller).coalescedSource).toBe("three");
    expect(controller.acceptMetadataMutation(title.token, mutationResult({ paste: summary({ title: "T", version: "g.2", contentRevision: 1 }) }), 3)).toBe(true);

    expect(controller.effects().filter((effect) => effect.type === "autosave-slot-available")).toHaveLength(1);
    expect(controller.effects().filter((effect) => effect.type === "dispatch-content")).toHaveLength(0);
  });

  it("retires an occupied token before a remote apply can settle it", () => {
    const { controller } = pasteControllerFixture();
    const save = dispatch(controller, { kind: "content", action: "autosave", content: "new", omitVersion: false });

    controller.retireForRemoteApply();

    expect(controller.acceptContentMutation(save.token, mutationResult({ paste: summary({ version: "g.2" }) }), 1)).toBe(false);
    expect(snapshot(controller).mutation.state).toBe("idle");
  });

  it("publishes a prepared Reload snapshot atomically in the existing controller", () => {
    const { controller } = pasteControllerFixture();
    const before = snapshot(controller);
    const prepared = controller.prepareRemoteSnapshot(reloadSnapshot(), remoteApplyOptions(controller));
    if (prepared === null) throw new Error("expected prepared Reload");

    prepared.commit("2026-09-20T00:00:00.000Z");

    expect(snapshot(controller)).toMatchObject({
      acceptedSource: "remote",
      draft: "remote",
      lastSavedContent: "remote",
      version: "g.2",
      contentRevision: 2,
      responseEtag: '"sha256-remote"',
      versionUsable: true,
      acceptedApplyGeneration: before.acceptedApplyGeneration! + 1,
      localGeneration: before.localGeneration,
      mutation: { state: "idle" },
    });
  });

  it("drops reverse-settled callbacks after a terminal transition", () => {
    const { controller } = pasteControllerFixture();
    const save = dispatch(controller, { kind: "content", action: "autosave", content: "new", omitVersion: false });
    const before = snapshot(controller);

    controller.enterTerminal("not-found", 1);
    expect(controller.acceptContentMutation(save.token, mutationResult({ paste: summary({ version: "g.99" }) }), 2)).toBe(false);

    expect(snapshot(controller)).toMatchObject({ phase: "not-found", acceptedSource: before.acceptedSource, version: before.version });
    expect(controller.effects().filter((effect) => effect.type === "dispatch-content")).toEqual([]);
  });

  it("rejects a stale token without rolling back accepted markers or ETag", () => {
    const { controller } = pasteControllerFixture();
    const first = dispatch(controller, { kind: "content", action: "autosave", content: "two", omitVersion: false });
    expect(controller.acceptContentMutation(first.token, mutationResult(), 1)).toBe(true);
    const second = dispatch(controller, { kind: "content", action: "autosave", content: "three", omitVersion: false });
    expect(controller.acceptContentMutation(second.token, mutationResult({ paste: summary({ version: "g.3", contentRevision: 3 }), etag: '"sha256-three"' }), 2)).toBe(true);
    const current = snapshot(controller);

    expect(controller.acceptContentMutation(first.token, mutationResult({ paste: summary({ version: "g.0" }), etag: '"sha256-old"' }), 3)).toBe(false);
    expect(snapshot(controller)).toMatchObject({
      acceptedSource: "three",
      lastSavedContent: "three",
      version: "g.3",
      responseEtag: null,
    });
    expect(snapshot(controller)).toEqual(current);
  });

  it("requires overwrite omission and a usable version for every other content mutation", () => {
    const { controller } = pasteControllerFixture();
    expect(() => controller.startMutation({ kind: "content", action: "autosave", content: "two", omitVersion: true }, 0)).toThrow();
    expect(() => controller.startMutation({ kind: "content", action: "overwrite", content: "two", omitVersion: false }, 0)).toThrow();

    const conflict = dispatch(controller, { kind: "content", action: "autosave", content: "two", omitVersion: false });
    controller.failMutation(conflict.token, { status: 409 }, 1);
    expect(controller.startMutation({ kind: "content", action: "manual-save", content: "two", omitVersion: false }, 2)).toMatchObject({ kind: "blocked", reason: "version-unusable" });
    expect(controller.startMutation({ kind: "content", action: "overwrite", content: "two", omitVersion: true }, 3).kind).toBe("dispatch");
  });

  it("only moves activity for source events that represent completed source changes", () => {
    const { controller, activity } = pasteControllerFixture();
    controller.sourceEvent({ type: "composition-start", content: "a", eventAt: 1 });
    controller.sourceEvent({ type: "composition-input", content: "b", eventAt: 2 });
    controller.sourceEvent({ type: "input", content: "c", eventAt: 3 });
    controller.sourceEvent({ type: "composition-end", content: "d", eventAt: 4 });
    controller.sourceEvent({ type: "crepe-change", content: "e", eventAt: 5 });

    expect(activity.mock.calls).toEqual([[3], [4], [5]]);
    expect(snapshot(controller)).toMatchObject({ draft: "e", localGeneration: 5 });
  });
});

describe("PasteController prepared remote snapshots", () => {
  it("rejects stale preparation without changing controller state", () => {
    const { controller } = pasteControllerFixture();
    const options = remoteApplyOptions(controller);
    options.expectedBaseline.localGeneration += 1;
    const before = snapshot(controller);
    const effects = controller.effects();

    expect(controller.prepareRemoteSnapshot(reloadSnapshot(), options)).toBeNull();

    expect(snapshot(controller)).toEqual(before);
    expect(controller.effects()).toEqual(effects);
  });

  it("commits a prepared remote snapshot without a second authority check", () => {
    const { controller } = pasteControllerFixture();
    const action = { key: "use-remote" as const, attempt: 7, startedAt: "2026-09-20T00:00:00.000Z" };
    controller.recordLocalAction({ ...action, state: "pending" });
    const options = remoteApplyOptions(controller, action);
    const before = snapshot(controller);
    const prepared = controller.prepareRemoteSnapshot(reloadSnapshot(), options);
    if (prepared === null) throw new Error("expected prepared remote snapshot");

    expect(snapshot(controller)).toEqual(before);
    expect(prepared.previousBaseline).toEqual(options.expectedBaseline);
    expect(prepared.nextBaseline).toMatchObject({ acceptedSource: "remote", version: "g.2", contentRevision: 2 });
    expect(prepared.nextDisplayGeneration).toBe(options.targetDisplayGeneration);

    controller.recordLocalActivity();
    prepared.commit("2026-09-20T00:00:01.000Z");

    expect(snapshot(controller)).toMatchObject({
      acceptedSource: "remote",
      draft: "remote",
      lastSavedContent: "remote",
      version: "g.2",
      contentRevision: 2,
      responseEtag: '"sha256-remote"',
      acceptedApplyGeneration: before.acceptedApplyGeneration! + 1,
      displayGeneration: options.targetDisplayGeneration,
      mutation: { state: "idle" },
      lastAction: {
        state: "succeeded",
        key: "use-remote",
        attempt: 7,
        startedAt: action.startedAt,
        settledAt: "2026-09-20T00:00:01.000Z",
        outcomeKey: null,
      },
    });
    expect(controller.effects()).toEqual([]);
  });

  it.each(["use-remote", "reload-server"] as const)("settles only the claimed %s action", (key) => {
    const action = { key, attempt: 7, startedAt: "2026-09-20T00:00:00.000Z" };
    const success = pasteControllerFixture().controller;
    success.recordLocalAction({ ...action, state: "pending" });
    const committed = success.prepareRemoteSnapshot(reloadSnapshot(), remoteApplyOptions(success, action));
    if (committed === null) throw new Error("expected prepared remote snapshot");

    committed.commit("2026-09-20T00:00:01.000Z");
    expect(snapshot(success).lastAction).toEqual({
      state: "succeeded",
      key,
      attempt: 7,
      startedAt: action.startedAt,
      settledAt: "2026-09-20T00:00:01.000Z",
      outcomeKey: null,
    });

    const failure = pasteControllerFixture().controller;
    failure.recordLocalAction({ ...action, state: "pending" });
    const before = snapshot(failure);
    const rejected = failure.prepareRemoteSnapshot(reloadSnapshot(), remoteApplyOptions(failure, action));
    if (rejected === null) throw new Error("expected prepared remote snapshot");

    failure.sourceEvent({ type: "input", content: "local draft", eventAt: 1 });
    rejected.fail("2026-09-20T00:00:02.000Z");
    expect(snapshot(failure)).toMatchObject({
      acceptedSource: before.acceptedSource,
      draft: "local draft",
      version: before.version,
      contentRevision: before.contentRevision,
      lastAction: {
        state: "failed",
        key,
        attempt: 7,
        startedAt: action.startedAt,
        settledAt: "2026-09-20T00:00:02.000Z",
        outcomeKey: null,
      },
    });
    expect(failure.effects()).toEqual([]);
  });

  it("rejects a stale claimed action without changing state", () => {
    const { controller } = pasteControllerFixture();
    controller.recordLocalAction({ key: "reload-server", state: "pending", attempt: 7, startedAt: "2026-09-20T00:00:00.000Z" });
    const before = snapshot(controller);
    const action = { key: "reload-server" as const, attempt: 7, startedAt: "2026-09-20T00:00:01.000Z" };

    expect(controller.prepareRemoteSnapshot(reloadSnapshot(), remoteApplyOptions(controller, action))).toBeNull();

    expect(snapshot(controller)).toEqual(before);
    expect(controller.effects()).toEqual([]);
  });

  it("preserves a newer action while committing canonical remote state", () => {
    const { controller } = pasteControllerFixture();
    const action = { key: "use-remote" as const, attempt: 7, startedAt: "2026-09-20T00:00:00.000Z" };
    controller.recordLocalAction({ ...action, state: "pending" });
    const prepared = controller.prepareRemoteSnapshot(reloadSnapshot(), remoteApplyOptions(controller, action));
    if (prepared === null) throw new Error("expected prepared remote snapshot");
    const newer = { key: "copy" as const, attempt: 8, startedAt: "2026-09-20T00:00:01.000Z" };
    controller.recordLocalAction({ ...newer, state: "pending" });

    prepared.commit("2026-09-20T00:00:02.000Z");

    expect(snapshot(controller)).toMatchObject({
      acceptedSource: "remote",
      draft: "remote",
      lastSavedContent: "remote",
      version: "g.2",
      contentRevision: 2,
      responseEtag: '"sha256-remote"',
      mutation: { state: "idle" },
    });
    expect(snapshot(controller).lastAction).toEqual({ state: "pending", ...newer });
  });

  it("preserves a newer action when a prepared remote snapshot fails", () => {
    const { controller } = pasteControllerFixture();
    const action = { key: "reload-server" as const, attempt: 7, startedAt: "2026-09-20T00:00:00.000Z" };
    controller.recordLocalAction({ ...action, state: "pending" });
    const prepared = controller.prepareRemoteSnapshot(reloadSnapshot(), remoteApplyOptions(controller, action));
    if (prepared === null) throw new Error("expected prepared remote snapshot");
    const newer = { key: "download" as const, attempt: 8, startedAt: "2026-09-20T00:00:01.000Z" };
    controller.recordLocalAction({ ...newer, state: "pending" });
    const before = snapshot(controller);

    prepared.fail("2026-09-20T00:00:02.000Z");

    expect(snapshot(controller)).toEqual(before);
  });

  it("settles a prepared remote snapshot at most once", () => {
    const { controller } = pasteControllerFixture();
    const action = { key: "use-remote" as const, attempt: 7, startedAt: "2026-09-20T00:00:00.000Z" };
    controller.recordLocalAction({ ...action, state: "pending" });
    const prepared = controller.prepareRemoteSnapshot(reloadSnapshot(), remoteApplyOptions(controller, action));
    if (prepared === null) throw new Error("expected prepared remote snapshot");

    prepared.commit("2026-09-20T00:00:01.000Z");
    const after = snapshot(controller);
    const effects = controller.effects();
    prepared.fail("2026-09-20T00:00:02.000Z");
    prepared.commit("2026-09-20T00:00:03.000Z");

    expect(snapshot(controller)).toEqual(after);
    expect(controller.effects()).toEqual(effects);
  });
});

describe("PasteController authoritative acceptance and reconciliation", () => {
  it("updates accepted source and its last-saved alias in the same accepted content transition", () => {
    const { controller } = pasteControllerFixture();
    const save = dispatch(controller, { kind: "content", action: "manual-save", content: "two", omitVersion: false });
    controller.sourceEvent({ type: "input", content: "later", eventAt: 1 });

    controller.acceptContentMutation(save.token, mutationResult({ etag: '"sha256-two"' }), 2);

    expect(snapshot(controller)).toMatchObject({
      acceptedSource: "two",
      lastSavedContent: "two",
      draft: "later",
      summary: expect.objectContaining({ version: "g.2" }),
      version: "g.2",
      contentRevision: 2,
      responseEtag: null,
      versionUsable: true,
    });
  });

  it("reconciles a server target as applied while retaining a later local draft", () => {
    const { controller } = pasteControllerFixture();
    const save = dispatch(controller, { kind: "content", action: "autosave", content: "two", omitVersion: false });
    controller.sourceEvent({ type: "input", content: "later", eventAt: 1 });
    controller.failMutation(save.token, { status: 503, mutationMayHaveApplied: true }, 2);

    const reconcile = controller.startContentReconcile(3);
    if (reconcile.kind !== "dispatch") throw new Error("expected reconcile GET");
    expect(reconcile).toMatchObject({ cache: "no-store", ifNoneMatch: null, mutationToken: save.token });
    expect(controller.acceptContentReconcile(reconcile.requestToken, reconcileSnapshot("two", { version: "g.2", contentRevision: 2 }), 4)).toBe(true);

    expect(snapshot(controller)).toMatchObject({ mutation: { state: "idle" }, acceptedSource: "two", lastSavedContent: "two", draft: "later" });
    expect(controller.effects()).toContainEqual(expect.objectContaining({ type: "apply-authoritative", kind: "reconciled-applied" }));
    expect(controller.effects()).toContainEqual(expect.objectContaining({ type: "autosave-slot-available" }));
    expect(controller.effects().some((effect) => effect.type === "dispatch-content")).toBe(false);
  });

  it("requires explicit retry when reconciliation proves the write was not applied", () => {
    const { controller } = pasteControllerFixture();
    const save = dispatch(controller, { kind: "content", action: "manual-save", content: "two", omitVersion: false });
    controller.failMutation(save.token, { status: null }, 1);
    const reconcile = controller.startContentReconcile(2);
    if (reconcile.kind !== "dispatch") throw new Error("expected reconcile GET");

    controller.acceptContentReconcile(reconcile.requestToken, reconcileSnapshot("one"), 3);

    expect(snapshot(controller)).toMatchObject({ mutation: { state: "idle" }, draft: "one", acceptedSource: "one", autosave: { state: "error" } });
    expect(controller.effects().some((effect) => effect.type === "autosave-slot-available")).toBe(false);
    expect(controller.effects().some((effect) => effect.type === "dispatch-content")).toBe(false);
  });

  it("preserves an unmatched reconciliation read as a conflict candidate", () => {
    const { controller } = pasteControllerFixture();
    const save = dispatch(controller, { kind: "content", action: "autosave", content: "two", omitVersion: false });
    controller.failMutation(save.token, { status: 500 }, 1);
    const reconcile = controller.startContentReconcile(2);
    if (reconcile.kind !== "dispatch") throw new Error("expected reconcile GET");

    controller.acceptContentReconcile(reconcile.requestToken, reconcileSnapshot("one", { version: "g.2", updatedAt: "2026-09-15T00:00:01.000Z" }), 3);

    expect(snapshot(controller)).toMatchObject({ mutation: { state: "idle" }, conflictCandidate: expect.objectContaining({ source: "one" }), acceptedSource: "one" });
    expect(controller.effects()).toContainEqual(expect.objectContaining({ type: "apply-authoritative", kind: "pause", state: "conflict" }));
    expect(controller.effects().some((effect) => effect.type === "autosave-slot-available")).toBe(false);
  });

  it("keeps content reconciliation occupied after forbidden and network outcomes", () => {
    const { controller } = pasteControllerFixture();
    const save = dispatch(controller, { kind: "content", action: "autosave", content: "two", omitVersion: false });
    controller.failMutation(save.token, { status: 503 }, 1);
    const first = controller.startContentReconcile(2);
    if (first.kind !== "dispatch") throw new Error("expected reconcile GET");
    controller.acceptContentReconcile(first.requestToken, reconcileFailure("forbidden"), 3);
    expect(snapshot(controller).mutation.state).toBe("content-reconciliation");

    const second = controller.startContentReconcile(4);
    if (second.kind !== "dispatch") throw new Error("expected reconcile GET");
    controller.acceptContentReconcile(second.requestToken, reconcileFailure("unavailable"), 5);
    expect(snapshot(controller).mutation.state).toBe("content-reconciliation");
  });

  it("uses a pending replacement credential for the next explicit content reconcile request", () => {
    const { controller } = pasteControllerFixture();
    const save = dispatch(controller, { kind: "content", action: "autosave", content: "two", omitVersion: false });
    controller.failMutation(save.token, { status: 503 }, 1);
    controller.setPendingCredential("replacement credential");

    expect(controller.startContentReconcile(2)).toMatchObject({ kind: "dispatch", authorizationPassword: "replacement credential" });
  });

  it("takes terminal view-once precedence over content reconciliation comparisons", () => {
    const { controller } = pasteControllerFixture();
    const save = dispatch(controller, { kind: "content", action: "autosave", content: "two", omitVersion: false });
    controller.failMutation(save.token, { status: 500 }, 1);
    const reconcile = controller.startContentReconcile(2);
    if (reconcile.kind !== "dispatch") throw new Error("expected reconcile GET");

    controller.acceptContentReconcile(reconcile.requestToken, reconcileSnapshot("two", { viewOnce: true }), 3);

    expect(snapshot(controller)).toMatchObject({ phase: "consumed", mutation: { state: "idle" }, acceptedSource: "one", draft: "one", terminalResponseSource: "two", terminalOrigin: expect.objectContaining({ actionKey: "content-reconcile" }) });
    expect(controller.effects().some((effect) => effect.type === "terminal-settled")).toBe(false);
  });

  it("terminalizes a retired strict valid view-once content reconcile without fabricating its action", () => {
    const { controller } = pasteControllerFixture();
    const save = dispatch(controller, { kind: "content", action: "autosave", content: "two", omitVersion: false });
    controller.failMutation(save.token, { status: 500 }, 1);
    const reconcile = controller.startContentReconcile(2);
    if (reconcile.kind !== "dispatch") throw new Error("expected reconcile GET");
    controller.sourceEvent({ type: "input", content: "local draft", eventAt: 3 });
    controller.retireForRemoteApply();

    expect(controller.acceptContentReconcile(reconcile.requestToken, reconcileSnapshot("consumed", { viewOnce: true }), 4)).toBe(true);

    expect(snapshot(controller)).toMatchObject({
      phase: "consumed",
      mutation: { state: "idle" },
      serverCapabilities: false,
      draft: "local draft",
      terminalResponseSource: "consumed",
      terminalOrigin: null,
      lastAction: { state: "failed", key: "content-reconcile", attempt: reconcile.requestToken },
    });
  });
});

describe("PasteController password and reconciliation failure policy", () => {
  it("probes the captured authorization credential only after intended password authorization is forbidden", () => {
    const { controller } = pasteControllerFixture();
    const password = dispatch(controller, {
      kind: "password-set",
      action: "password-set",
      newPassword: "intended value",
      authorizationPassword: "previous value",
    });
    controller.failMutation(password.token, { status: 500 }, 1);
    const intended = controller.startMetadataReconcile(2);
    expect(intended).toMatchObject({ kind: "dispatch", credentialProbe: "intended", authorizationPassword: "intended value" });
    if (intended.kind !== "dispatch" || intended.type !== "reconcile-settings") throw new Error("expected intended credential probe");

    controller.acceptMetadataReconcile(intended.requestToken, reconcileFailure("forbidden"), 3);

    expect(controller.effects()).toContainEqual(expect.objectContaining({
      type: "dispatch-metadata-reconcile",
      credentialProbe: "authorization",
      authorizationPassword: "previous value",
    }));
  });

  it("does not repeat an equal intended and authorizing password credential probe", () => {
    const { controller } = pasteControllerFixture();
    const password = dispatch(controller, {
      kind: "password-set",
      action: "password-set",
      newPassword: "same value",
      authorizationPassword: "same value",
    });
    controller.failMutation(password.token, { status: 500 }, 1);
    const intended = controller.startMetadataReconcile(2);
    if (intended.kind !== "dispatch" || intended.type !== "reconcile-settings") throw new Error("expected intended credential probe");

    controller.acceptMetadataReconcile(intended.requestToken, reconcileFailure("forbidden"), 3);

    expect(controller.effects().some((effect) => effect.type === "dispatch-metadata-reconcile")).toBe(false);
    expect(snapshot(controller).mutation.state).toBe("metadata-reconciliation");
  });

  it("commits the intended password from an authorized 304 settings read", () => {
    const { controller } = pasteControllerFixture();
    const password = dispatch(controller, {
      kind: "password-set",
      action: "password-set",
      newPassword: "intended value",
      authorizationPassword: "previous value",
    });
    controller.failMutation(password.token, { status: 500 }, 1);
    const intended = controller.startMetadataReconcile(2);
    if (intended.kind !== "dispatch" || intended.type !== "reconcile-settings") throw new Error("expected intended credential probe");

    expect(controller.acceptMetadataReconcile(intended.requestToken, reconcileFailure("not-modified"), 3)).toBe(true);
    expect(snapshot(controller).credential).toEqual({ committed: "intended value", pending: null });
  });

  it("settles failed reconciliation reads without releasing an autosave slot", () => {
    const { controller } = pasteControllerFixture();
    const save = dispatch(controller, { kind: "content", action: "autosave", content: "two", omitVersion: false });
    controller.failMutation(save.token, { status: 503 }, 1);
    const reconcile = controller.startContentReconcile(2);
    if (reconcile.kind !== "dispatch") throw new Error("expected reconcile GET");

    expect(controller.acceptContentReconcile(reconcile.requestToken, reconcileFailure("not-modified"), 3)).toBe(true);
    expect(snapshot(controller)).toMatchObject({ mutation: { state: "content-reconciliation" }, lastAction: { state: "failed", key: "content-reconcile" } });
    expect(controller.effects().some((effect) => effect.type === "autosave-slot-available")).toBe(false);
  });

  it("pauses before terminal disposal when a content reconcile read reports not found", () => {
    const { controller } = pasteControllerFixture();
    const save = dispatch(controller, { kind: "content", action: "autosave", content: "two", omitVersion: false });
    controller.failMutation(save.token, { status: 500 }, 1);
    const reconcile = controller.startContentReconcile(2);
    if (reconcile.kind !== "dispatch") throw new Error("expected reconcile GET");

    controller.acceptContentReconcile(reconcile.requestToken, reconcileFailure("not-found"), 3);

    const effects = controller.effects();
    const pauseIndex = effects.findIndex((effect) => effect.type === "pause" && effect.state === "not-found");
    const disposeIndex = effects.findIndex((effect) => effect.type === "dispose-server-capabilities");
    expect(pauseIndex).toBeGreaterThanOrEqual(0);
    expect(pauseIndex).toBeLessThan(disposeIndex);
  });
});

describe("PasteController metadata, passwords, and delete", () => {
  it("accepts metadata only against matching source markers and clears the read ETag before release", () => {
    const { controller } = pasteControllerFixture();
    const title = dispatch(controller, { kind: "settings-title", action: "settings-title", title: "T" });

    expect(controller.acceptMetadataMutation(title.token, mutationResult({ paste: summary({ title: "T", version: "g.2" }) }), 1)).toBe(true);
    expect(snapshot(controller)).toMatchObject({ summary: expect.objectContaining({ title: "T", version: "g.2" }), version: "g.2", responseEtag: null });
    const effects = controller.effects();
    expect(effects.findIndex((effect) => effect.type === "apply-authoritative")).toBeLessThan(effects.findIndex((effect) => effect.type === "autosave-slot-available"));
  });

  it("accepts metadata after a local edit without changing the source draft", () => {
    const { controller } = pasteControllerFixture();
    const title = dispatch(controller, { kind: "settings-title", action: "settings-title", title: "T" });
    controller.sourceEvent({ type: "input", content: "local", eventAt: 1 });

    expect(controller.acceptMetadataMutation(title.token, mutationResult({ paste: summary({ title: "T", version: "g.2" }) }), 2)).toBe(true);
    expect(snapshot(controller)).toMatchObject({ draft: "local", acceptedSource: "one", summary: expect.objectContaining({ title: "T" }) });
  });

  it("keeps source mutations paused while a metadata validation draft is unresolved", () => {
    const { controller } = pasteControllerFixture();
    const title = dispatch(controller, { kind: "settings-title", action: "settings-title", title: "T" });
    controller.sourceEvent({ type: "input", content: "two", eventAt: 1 });

    controller.failMutation(title.token, { status: 422 }, 2);

    expect(snapshot(controller).mutation.state).toBe("idle");
    expect(controller.effects().some((effect) => effect.type === "autosave-slot-available" || effect.type === "dispatch-content")).toBe(false);
  });

  it("uses intended password state after a successful password mutation rather than retry authorization", () => {
    const { controller } = pasteControllerFixture();
    controller.setPendingCredential("retry authorization");
    const password = dispatch(controller, {
      kind: "password-set",
      action: "password-set",
      newPassword: "intended value",
      authorizationPassword: "retry authorization",
    });

    controller.acceptMetadataMutation(password.token, mutationResult({ paste: summary({ protected: true }) }), 1);

    expect(snapshot(controller).credential).toEqual({ committed: "intended value", pending: null });
  });

  it("does not prove same-seconds relative expiry from a settings read", () => {
    const { controller } = pasteControllerFixture();
    const expiry = dispatch(controller, { kind: "settings-expiration", action: "settings-expiration", expiration: 60 });
    controller.failMutation(expiry.token, { status: 500 }, 1);
    const reconcile = controller.startMetadataReconcile(2);

    expect(reconcile).toMatchObject({ kind: "dispatch", type: "reconcile-settings" });
    expect(snapshot(controller).reconciliationRequired).toBe(true);
  });

  it.each([
    [204, "ordinary", true],
    [403, "ordinary", false],
    [409, "ordinary", false],
    [404, "not-found", false],
    [503, "delete-uncertain", false],
  ] as const)("settles delete status %s with the required terminal capability", (status, phase, rootHandoff) => {
    const { controller } = pasteControllerFixture();
    const deletion = dispatch(controller, { kind: "delete", action: "delete", authorizationPassword: null });

    controller.acceptDeleteMutation(deletion.token, { status }, 1);

    expect(snapshot(controller).phase).toBe(phase);
    expect(snapshot(controller).mutation.state).toBe("idle");
    expect(snapshot(controller).versionUsable).toBe(status !== 204 && status !== 409);
    expect(controller.effects().some((effect) => effect.type === "root-handoff")).toBe(rootHandoff);
  });

  it("does not commit a pending credential on delete 204, 409, 404, or uncertain outcome", () => {
    for (const status of [204, 409, 404, 503] as const) {
      const { controller } = pasteControllerFixture();
      controller.setPendingCredential("replacement");
      const deletion = dispatch(controller, { kind: "delete", action: "delete", authorizationPassword: "replacement" });
      controller.acceptDeleteMutation(deletion.token, { status }, 1);
      expect(snapshot(controller).credential.committed).toBeNull();
      expect(snapshot(controller).credential.pending).toBe(status === 204 ? null : "replacement");
    }
  });

  it("clears deleted paste identity and capability state before root handoff", () => {
    const prior = summary({
      id: "prior-paste",
      version: "prior.7",
      contentRevision: 7,
      updatedAt: "2026-09-15T00:00:07.000Z",
      links: { view: "/p/prior-paste", raw: "/raw/prior-paste", html: "/html/prior-paste", markdown: "/md/prior-paste", file: "/file/prior-paste" },
    });
    const { controller } = pasteControllerFixture({
      accepted: {
        acceptedSource: "prior source",
        draft: "prior source",
        summary: prior,
        version: prior.version,
        versionUsable: true,
        contentRevision: prior.contentRevision,
        updatedAt: prior.updatedAt,
        responseEtag: '"sha256-prior"',
        acceptedApplyGeneration: 7,
        localGeneration: 6,
        displayGeneration: 5,
      },
    });
    controller.setPendingCredential("replacement credential");
    const deletion = dispatch(controller, { kind: "delete", action: "delete", authorizationPassword: "replacement credential" });

    expect(controller.acceptDeleteMutation(deletion.token, { status: 204 }, 1)).toBe(true);

    expect(snapshot(controller)).toMatchObject({
      resource: "deleted-root-handoff",
      acceptedSource: "",
      draft: "",
      lastSavedContent: "",
      summary: null,
      version: null,
      versionUsable: false,
      contentRevision: null,
      updatedAt: null,
      responseEtag: null,
      acceptedApplyGeneration: null,
      localGeneration: null,
      displayGeneration: null,
      credential: { committed: null, pending: null },
      autosave: { state: "clean", confirmedAt: null, failedAt: null },
      conflictCandidate: null,
      terminalResponseSource: null,
      terminalOrigin: null,
      originalMutationFailure: null,
      reconciliationRequired: false,
      serverCapabilities: false,
      coalescedSource: null,
      lastAction: { state: "succeeded", key: "delete" },
    });
    expect(controller.takeEffects().filter((effect) => effect.type === "root-handoff")).toEqual([{ type: "root-handoff" }]);
    expect(controller.acceptDeleteMutation(deletion.token, { status: 204 }, 2)).toBe(false);
    expect(snapshot(controller).summary).toBeNull();
  });
});

function remoteSnapshot(source: string, overrides: Partial<PasteSummary> = {}) {
  const remote = summary(overrides);
  const separator = remote.version.lastIndexOf(".");
  return {
    etag: '"sha256-remote"' as const,
    source,
    summary: remote,
    identity: remote.version === "legacy"
      ? { kind: "legacy" as const }
      : { kind: "v2" as const, generation: remote.version.slice(0, separator), versionCounter: Number(remote.version.slice(separator + 1)) },
    contentRevision: remote.contentRevision,
    updatedAtMs: Date.parse(remote.updatedAt),
  };
}

function reconcileSnapshot(source: string, overrides: Partial<PasteSummary> = {}): ContentReconcileResult {
  return { kind: "snapshot", snapshot: remoteSnapshot(source, overrides) };
}

function metadataSummary(overrides: Partial<PasteSummary> = {}): MetadataReconcileResult {
  return { kind: "summary", summary: summary(overrides) };
}

function reconcileFailure(kind: "forbidden" | "not-found" | "unavailable" | "network" | "malformed" | "not-modified"): ReconcileReadFailure {
  return { kind };
}

describe("PasteController round-one regressions", () => {
  it("releases an eligible slot without dispatching an unfinished IME draft", () => {
    const { controller } = pasteControllerFixture();
    const title = dispatch(controller, { kind: "settings-title", action: "settings-title", title: "T" });
    controller.sourceEvent({ type: "composition-start", content: "", eventAt: 1 });
    controller.sourceEvent({ type: "composition-input", content: "中文", eventAt: 2 });

    controller.acceptMetadataMutation(title.token, mutationResult({ paste: summary({ title: "T", version: "g.2", contentRevision: 1 }) }), 3);

    expect(controller.effects().filter((effect) => effect.type === "autosave-slot-available")).toHaveLength(1);
    expect(controller.effects().filter((effect) => effect.type === "dispatch-content")).toHaveLength(0);
  });

  it("clears coordinator coalescing when an ineligible release follows a conflict", () => {
    const { controller } = pasteControllerFixture();
    const save = dispatch(controller, { kind: "content", action: "autosave", content: "two", omitVersion: false });
    controller.sourceEvent({ type: "input", content: "later", eventAt: 1 });
    controller.failMutation(save.token, { status: 409 }, 2);

    expect(snapshot(controller).coalescedSource).toBeNull();
  });

  it("blocks delete, settings, and password mutations after any version conflict", () => {
    const { controller } = pasteControllerFixture();
    const deletion = dispatch(controller, { kind: "delete", action: "delete", authorizationPassword: null });
    controller.acceptDeleteMutation(deletion.token, { status: 409 }, 1);

    for (const intent of [
      { kind: "delete", action: "delete", authorizationPassword: null },
      { kind: "settings-title", action: "settings-title", title: "T" },
      { kind: "password-set", action: "password-set", newPassword: "new", authorizationPassword: null },
    ] as const) {
      expect(controller.startMutation(intent, 2)).toMatchObject({ kind: "blocked", reason: "version-unusable" });
    }
  });

  it("rejects metadata that splices a changed content revision into the captured source", () => {
    const { controller } = pasteControllerFixture();
    const title = dispatch(controller, { kind: "settings-title", action: "settings-title", title: "T" });

    expect(controller.acceptMetadataMutation(title.token, mutationResult({ paste: summary({ title: "T", version: "g.2", contentRevision: 99 }) }), 1)).toBe(false);
    expect(snapshot(controller)).toMatchObject({ acceptedSource: "one", contentRevision: 1, reconciliationRequired: true });
  });

  it("clears mutation ETags instead of using them as resource validators", () => {
    const { controller } = pasteControllerFixture();
    const save = dispatch(controller, { kind: "content", action: "manual-save", content: "two", omitVersion: false });

    controller.acceptContentMutation(save.token, mutationResult({ etag: '"sha256-mutation"' }), 1);

    expect(snapshot(controller).responseEtag).toBeNull();
  });

  it("releases reconciliation ownership without dispatching another business request", () => {
    const { controller } = pasteControllerFixture();
    const save = dispatch(controller, { kind: "content", action: "autosave", content: "two", omitVersion: false });
    controller.failMutation(save.token, { status: 503 }, 1);
    expect(snapshot(controller).mutation.state).toBe("content-reconciliation");

    expect(controller.discardReconciliation()).toBe(true);
    expect(snapshot(controller)).toMatchObject({
      mutation: { state: "idle" },
      reconciliationRequired: false,
      acceptedSource: "one",
      draft: "one",
    });
    expect(controller.effects().some((effect) => effect.type === "dispatch-content" || effect.type === "dispatch-metadata-reconcile")).toBe(false);
    expect(controller.startContentReconcile(2)).toMatchObject({ kind: "blocked", reason: "not-reconciling" });
  });

  it("preserves a source edit when discarding an uncertain title reconciliation", () => {
    const { controller } = pasteControllerFixture();
    const title = dispatch(controller, { kind: "settings-title", action: "settings-title", title: "updated" });
    controller.failMutation(title.token, { status: 503 }, 1);
    controller.sourceEvent({ type: "input", content: "local source", eventAt: 2 });

    expect(controller.discardReconciliation()).toBe(true);

    expect(snapshot(controller)).toMatchObject({
      mutation: { state: "idle" },
      acceptedSource: "one",
      draft: "local source",
      reconciliationRequired: false,
    });
  });

  it("blocks Discard until an in-flight content reconcile GET settles", () => {
    const { controller } = pasteControllerFixture();
    const save = dispatch(controller, { kind: "content", action: "autosave", content: "two", omitVersion: false });
    controller.failMutation(save.token, { status: 503 }, 1);
    const reconcile = controller.startContentReconcile(2);
    if (reconcile.kind !== "dispatch") throw new Error("expected reconcile GET");
    controller.recordLocalAction({ key: "copy", state: "pending", attempt: 9, startedAt: "2026-09-20T00:00:00.000Z" });

    expect(controller.discardReconciliation()).toBe(false);
    expect(controller.acceptContentReconcile(reconcile.requestToken, reconcileFailure("network"), 3)).toBe(true);
    expect(controller.discardReconciliation()).toBe(true);
  });

  it("restores the accepted content when discarding a reconciliation with a later draft", () => {
    const { controller } = pasteControllerFixture();
    const save = dispatch(controller, { kind: "content", action: "autosave", content: "two", omitVersion: false });
    controller.sourceEvent({ type: "input", content: "later", eventAt: 1 });
    controller.failMutation(save.token, { status: 503 }, 2);

    expect(controller.discardReconciliation()).toBe(true);
    expect(snapshot(controller)).toMatchObject({
      mutation: { state: "idle" },
      acceptedSource: "one",
      draft: "one",
      autosave: { state: "clean" },
    });
  });

  it("uses canonical remote snapshots and extracts generations at the final dot", () => {
    const { controller } = pasteControllerFixture({
      accepted: {
        acceptedSource: "one",
        draft: "one",
        summary: summary({ version: "generation.with.dots.1" }),
        version: "generation.with.dots.1",
        versionUsable: true,
        contentRevision: 1,
        updatedAt: "2026-09-15T00:00:00.000Z",
        responseEtag: '"sha256-one"',
        acceptedApplyGeneration: 1,
        localGeneration: 0,
        displayGeneration: 1,
      },
    });
    const save = dispatch(controller, { kind: "content", action: "autosave", content: "two", omitVersion: false });
    expect(save.capture.generation).toBe("generation.with.dots");
    controller.failMutation(save.token, { status: 500 }, 1);
    const reconcile = controller.startContentReconcile(2);
    if (reconcile.kind !== "dispatch") throw new Error("expected reconcile GET");

    controller.acceptContentReconcile(reconcile.requestToken, reconcileSnapshot("two", { version: "generation.with.dots.2", contentRevision: 2 }), 3);

    expect(snapshot(controller)).toMatchObject({ acceptedSource: "two", responseEtag: '"sha256-remote"', reconciliationRequired: false });
  });

  it("keeps canonical conflict authority with its original target and capture", () => {
    const { controller } = pasteControllerFixture();
    const save = dispatch(controller, { kind: "content", action: "autosave", content: "two", omitVersion: false });
    controller.failMutation(save.token, { status: 500 }, 1);
    const reconcile = controller.startContentReconcile(2);
    if (reconcile.kind !== "dispatch") throw new Error("expected reconcile GET");

    controller.acceptContentReconcile(reconcile.requestToken, reconcileSnapshot("third", { version: "g.3", contentRevision: 3 }), 3);

    expect(snapshot(controller).conflictCandidate).toMatchObject({ source: "third", originalTarget: "two", capture: expect.objectContaining({ inFlightContent: "two" }), snapshot: expect.objectContaining({ etag: '"sha256-remote"' }) });
  });

  it("settles proved-not-applied reconciliation as succeeded while retaining the save failure", () => {
    const { controller } = pasteControllerFixture();
    const save = dispatch(controller, { kind: "content", action: "manual-save", content: "two", omitVersion: false });
    controller.failMutation(save.token, { status: null }, 1);
    const reconcile = controller.startContentReconcile(2);
    if (reconcile.kind !== "dispatch") throw new Error("expected reconcile GET");

    controller.acceptContentReconcile(reconcile.requestToken, reconcileSnapshot("one"), 3);

    expect(snapshot(controller)).toMatchObject({ lastAction: { state: "succeeded", key: "content-reconcile" }, originalMutationFailure: expect.objectContaining({ key: "manual-save", status: null }) });
  });

  it("allows only one in-flight reconciliation read and settles unavailable reads for retry", () => {
    const { controller } = pasteControllerFixture();
    const save = dispatch(controller, { kind: "content", action: "autosave", content: "two", omitVersion: false });
    controller.failMutation(save.token, { status: 503 }, 1);
    const first = controller.startContentReconcile(2);
    if (first.kind !== "dispatch") throw new Error("expected reconcile GET");
    expect(controller.startContentReconcile(3)).toMatchObject({ kind: "blocked", reason: "reconcile-pending" });
    controller.acceptContentReconcile(first.requestToken, reconcileFailure("network"), 4);

    expect(snapshot(controller)).toMatchObject({ mutation: { state: "content-reconciliation" }, lastAction: { state: "failed", key: "content-reconcile" } });
    expect(controller.startContentReconcile(5)).toMatchObject({ kind: "dispatch" });
  });

  it("reads current settings before rewriting a relative expiration from a fresh version", () => {
    const { controller } = pasteControllerFixture();
    const expiry = dispatch(controller, { kind: "settings-expiration", action: "settings-expiration", expiration: 60 });
    controller.failMutation(expiry.token, { status: 500 }, 1);

    const read = controller.startMetadataReconcile(2);
    expect(read).toMatchObject({ kind: "dispatch", type: "reconcile-settings" });
    if (read.kind !== "dispatch" || read.type !== "reconcile-settings") throw new Error("expected settings read");
    controller.acceptMetadataReconcile(read.requestToken, metadataSummary({ version: "g.2", contentRevision: 1 }), 3);

    expect(controller.effects()).toContainEqual(expect.objectContaining({ type: "dispatch-relative-expiration-retry", version: "g.2", now: 3 }));
  });

  it("initializes and commits the controller-owned credential used by authorized non-password mutations", () => {
    const { controller } = pasteControllerFixture({ credential: "bootstrap credential" } as never);
    expect(snapshot(controller).credential).toEqual({ committed: "bootstrap credential", pending: null });
    controller.setPendingCredential("replacement credential");
    const title = dispatch(controller, { kind: "settings-title", action: "settings-title", title: "T" });
    controller.acceptMetadataMutation(title.token, mutationResult({ paste: summary({ title: "T", version: "g.2", contentRevision: 1 }) }), 1);

    expect(snapshot(controller).credential).toEqual({ committed: "replacement credential", pending: null });
    expect(controller.effects()).toContainEqual({ type: "credential-commit", credential: "replacement credential" });
  });

  it("enters irreversible armed-view-once before releasing a view-once settings mutation", () => {
    const { controller } = pasteControllerFixture();
    const viewOnce = dispatch(controller, { kind: "settings-view-once", action: "settings-view-once", viewOnce: true });

    controller.acceptMetadataMutation(viewOnce.token, mutationResult({ paste: summary({ viewOnce: true, version: "g.2", contentRevision: 1 }) }), 1);

    expect(snapshot(controller)).toMatchObject({ phase: "armed-view-once", serverCapabilities: false, summary: expect.objectContaining({ viewOnce: true }) });
    expect(controller.effects().some((effect) => effect.type === "autosave-slot-available")).toBe(false);
  });

  it("retains a terminal origin until a display commit supplies a closed outcome", () => {
    const { controller } = pasteControllerFixture();
    controller.recordLocalAction({ key: "reload-server", state: "pending", attempt: 7, startedAt: "2026-09-15T00:00:00.000Z" });
    controller.enterTerminal("consumed", 1, { actionKey: "reload-server", actionAttempt: 7, startedAt: "2026-09-15T00:00:00.000Z" });

    expect(snapshot(controller)).toMatchObject({ phase: "consumed", terminalOrigin: expect.objectContaining({ actionKey: "reload-server" }), lastAction: { state: "pending", key: "reload-server", attempt: 7 } });
    expect(controller.effects().some((effect) => effect.type === "terminal-settled")).toBe(false);
    expect(controller.settleTerminal("use-consumed-response-displayed", 2)).toBe(false);
    expect(controller.settleTerminal("reload-terminal-response-displayed", 3)).toBe(true);
  });

  it("fails closed for all unknown 5xx mutation results and recognizes permanent and normalized absolute expiry", () => {
    const { controller } = pasteControllerFixture();
    const save = dispatch(controller, { kind: "content", action: "autosave", content: "two", omitVersion: false });
    controller.failMutation(save.token, { status: 502 }, 1);
    expect(snapshot(controller).mutation.state).toBe("content-reconciliation");

    const absolute = createPasteController({
      accepted: {
        acceptedSource: "one",
        draft: "one",
        summary: summary({ expiration: { kind: "permanent" }, expiresAt: null }),
        version: "g.1",
        versionUsable: true,
        contentRevision: 1,
        updatedAt: "2026-09-15T00:00:00.000Z",
        responseEtag: '"sha256-one"',
        acceptedApplyGeneration: 1,
        localGeneration: 0,
        displayGeneration: 1,
      },
    });
    const permanent = dispatch(absolute, { kind: "settings-expiration", action: "settings-expiration", expiration: null });
    absolute.failMutation(permanent.token, { status: 500 }, 1);
    const permanentRead = absolute.startMetadataReconcile(2);
    if (permanentRead.kind !== "dispatch" || permanentRead.type !== "reconcile-settings") throw new Error("expected settings reconcile");
    absolute.acceptMetadataReconcile(permanentRead.requestToken, metadataSummary({ expiration: { kind: "permanent" }, expiresAt: null }), 3);
    expect(snapshot(absolute).lastAction).toMatchObject({ state: "succeeded", key: "settings-reconcile" });

    const offset = dispatch(absolute, { kind: "settings-expiration", action: "settings-expiration", expiration: "2026-09-15T02:00:00+02:00" });
    absolute.failMutation(offset.token, { status: 500 }, 4);
    const offsetRead = absolute.startMetadataReconcile(5);
    if (offsetRead.kind !== "dispatch" || offsetRead.type !== "reconcile-settings") throw new Error("expected settings reconcile");
    absolute.acceptMetadataReconcile(offsetRead.requestToken, metadataSummary({ expiration: { kind: "absolute" }, expiresAt: "2026-09-15T00:00:00.000Z" }), 6);
    expect(snapshot(absolute).lastAction).toMatchObject({ state: "succeeded", key: "settings-reconcile" });
  });
});

describe("PasteController round-two reconciliation regressions", () => {
  it("arms before releasing a settings read whose requested title did not apply", () => {
    const { controller } = pasteControllerFixture();
    const title = dispatch(controller, { kind: "settings-title", action: "settings-title", title: "local title" });
    controller.failMutation(title.token, { status: 502 }, 1);
    const read = controller.startMetadataReconcile(2);
    if (read.kind !== "dispatch") throw new Error("expected settings read");

    expect(controller.acceptMetadataReconcile(read.requestToken, metadataSummary({ title: "server title", viewOnce: true, version: "g.2", contentRevision: 1 }), 3)).toBe(true);

    expect(snapshot(controller)).toMatchObject({
      phase: "armed-view-once",
      serverCapabilities: false,
      acceptedSource: "one",
      summary: expect.objectContaining({ title: "server title", viewOnce: true }),
      responseEtag: null,
    });
    expect(controller.effects().some((effect) => effect.type === "autosave-slot-available" || effect.type === "dispatch-relative-expiration-retry")).toBe(false);
  });

  it("arms before rewriting a relative expiration from a view-once settings read", () => {
    const { controller } = pasteControllerFixture();
    const expiry = dispatch(controller, { kind: "settings-expiration", action: "settings-expiration", expiration: 60 });
    controller.failMutation(expiry.token, { status: 502 }, 1);
    const read = controller.startMetadataReconcile(2);
    if (read.kind !== "dispatch") throw new Error("expected settings read");

    expect(controller.acceptMetadataReconcile(read.requestToken, metadataSummary({ viewOnce: true, version: "g.2", contentRevision: 1 }), 3)).toBe(true);

    expect(snapshot(controller)).toMatchObject({ phase: "armed-view-once", acceptedSource: "one", summary: expect.objectContaining({ viewOnce: true }) });
    expect(controller.effects().some((effect) => effect.type === "autosave-slot-available" || effect.type === "dispatch-relative-expiration-retry")).toBe(false);
  });

  it("arms before treating a view-once settings read as an authorization probe", () => {
    const { controller } = pasteControllerFixture();
    const password = dispatch(controller, { kind: "password-set", action: "password-set", newPassword: "new", authorizationPassword: "old" });
    controller.failMutation(password.token, { status: 502 }, 1);
    const intended = controller.startMetadataReconcile(2);
    if (intended.kind !== "dispatch") throw new Error("expected intended settings read");
    controller.acceptMetadataReconcile(intended.requestToken, reconcileFailure("forbidden"), 3);
    const authorization = controller.effects().find((effect) => effect.type === "dispatch-metadata-reconcile");
    if (authorization === undefined || authorization.type !== "dispatch-metadata-reconcile") throw new Error("expected authorization settings read");

    expect(controller.acceptMetadataReconcile(authorization.requestToken, metadataSummary({ protected: true, viewOnce: true, version: "g.2", contentRevision: 1 }), 4)).toBe(true);

    expect(snapshot(controller)).toMatchObject({ phase: "armed-view-once", acceptedSource: "one", summary: expect.objectContaining({ viewOnce: true }) });
    expect(controller.effects().some((effect) => effect.type === "autosave-slot-available" || effect.type === "dispatch-relative-expiration-retry")).toBe(false);
  });

  it("uses validated settings summaries for relative rewrites and clears resource ETags", () => {
    const { controller } = pasteControllerFixture();
    const expiry = dispatch(controller, { kind: "settings-expiration", action: "settings-expiration", expiration: 60 });
    controller.failMutation(expiry.token, { status: 502 }, 1);
    const read = controller.startMetadataReconcile(2);
    if (read.kind !== "dispatch") throw new Error("expected settings read");

    expect(controller.acceptMetadataReconcile(read.requestToken, metadataSummary({ version: "g.2", contentRevision: 1 }), 3)).toBe(true);

    expect(snapshot(controller)).toMatchObject({ responseEtag: null, summary: expect.objectContaining({ version: "g.2" }) });
    expect(controller.effects()).toContainEqual(expect.objectContaining({ type: "dispatch-relative-expiration-retry", version: "g.2" }));
  });

  it.each([
    [{ status: 503, mutationMayHaveApplied: false }],
    [{ status: 403 }],
    [{ status: 409 }],
    [{ status: 422, mutationMayHaveApplied: false }],
  ] as const)("retains relative-expiration reconciliation after retry failure %o", (failure) => {
    const { controller } = pasteControllerFixture();
    const expiry = dispatch(controller, { kind: "settings-expiration", action: "settings-expiration", expiration: 60 });
    controller.failMutation(expiry.token, { status: 502 }, 1);
    const read = controller.startMetadataReconcile(2);
    if (read.kind !== "dispatch") throw new Error("expected settings read");
    controller.acceptMetadataReconcile(read.requestToken, metadataSummary({ version: "g.2", contentRevision: 1 }), 3);
    const rewrite = controller.effects().find((effect) => effect.type === "dispatch-relative-expiration-retry");
    if (rewrite === undefined || rewrite.type !== "dispatch-relative-expiration-retry") throw new Error("expected relative rewrite");

    expect(controller.failMutation(rewrite.token, failure, 4)).toBe(true);

    expect(snapshot(controller)).toMatchObject({
      mutation: { state: "metadata-reconciliation", intent: expect.objectContaining({ kind: "settings-expiration", expiration: 60 }) },
      reconciliationRequired: true,
      lastAction: { state: "failed", key: "settings-reconcile" },
    });
    expect(controller.startMetadataReconcile(5)).toMatchObject({ kind: "dispatch", type: "reconcile-settings" });
  });

  it("fails invalidated reconciliation when a terminal entry supplies no origin", () => {
    const { controller } = pasteControllerFixture();
    const save = dispatch(controller, { kind: "content", action: "autosave", content: "two", omitVersion: false });
    controller.failMutation(save.token, { status: 502 }, 1);
    const read = controller.startContentReconcile(2);
    if (read.kind !== "dispatch") throw new Error("expected content read");

    controller.enterTerminal("consumed", 3);

    expect(snapshot(controller)).toMatchObject({ phase: "consumed", terminalOrigin: null, lastAction: { state: "failed", key: "content-reconcile", attempt: read.requestToken } });
    expect(controller.settleTerminal("content-reconcile-terminal-current-kept", 4)).toBe(false);
  });
});
