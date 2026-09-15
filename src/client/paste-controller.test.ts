import { describe, expect, it, vi } from "vitest";
import type { MutationResult, PasteSummary } from "../types";
import {
  createPasteController,
  type PasteController,
  type PasteControllerSnapshot,
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

describe("PasteController mutation slot", () => {
  it("serializes autosave and settings while retaining one latest source intent", () => {
    const { controller } = pasteControllerFixture();
    const save = dispatch(controller, { kind: "content", action: "autosave", content: "one", omitVersion: false });

    expect(controller.startMutation({ kind: "settings-title", action: "settings-title", title: "T" }, 1).kind).toBe("blocked");
    controller.sourceEvent({ type: "input", content: "two", eventAt: 10 });
    controller.sourceEvent({ type: "input", content: "three", eventAt: 11 });
    expect(snapshot(controller).coalescedSource).toBe("three");

    expect(controller.acceptContentMutation(save.token, mutationResult(), 12)).toBe(true);
    expect(controller.effects().filter((effect) => effect.type === "dispatch-content")).toHaveLength(1);
    expect(controller.effects().at(-1)).toMatchObject({ type: "dispatch-content", content: "three" });
  });

  it("retains only one autosave when settings owns the slot", () => {
    const { controller } = pasteControllerFixture();
    const title = dispatch(controller, { kind: "settings-title", action: "settings-title", title: "T" });

    controller.sourceEvent({ type: "input", content: "two", eventAt: 1 });
    controller.sourceEvent({ type: "input", content: "three", eventAt: 2 });
    expect(snapshot(controller).coalescedSource).toBe("three");
    expect(controller.acceptMetadataMutation(title.token, mutationResult(), 3)).toBe(true);

    expect(controller.effects().filter((effect) => effect.type === "dispatch-content")).toEqual([
      expect.objectContaining({ content: "three", intent: expect.objectContaining({ action: "autosave" }) }),
    ]);
  });

  it("retires an occupied token before a remote apply can settle it", () => {
    const { controller } = pasteControllerFixture();
    const save = dispatch(controller, { kind: "content", action: "autosave", content: "new", omitVersion: false });

    controller.retireForRemoteApply();

    expect(controller.acceptContentMutation(save.token, mutationResult({ paste: summary({ version: "g.2" }) }), 1)).toBe(false);
    expect(snapshot(controller).mutation.state).toBe("idle");
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
      responseEtag: '"sha256-three"',
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
      responseEtag: '"sha256-two"',
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
    expect(controller.acceptContentReconcile(reconcile.requestToken, { status: 200, content: "two", paste: summary({ version: "g.2", contentRevision: 2 }), etag: '"sha256-two"' }, 4)).toBe(true);

    expect(snapshot(controller)).toMatchObject({ mutation: { state: "in-flight", intent: { kind: "content", content: "later" } }, acceptedSource: "two", lastSavedContent: "two", draft: "later" });
    expect(controller.effects()).toContainEqual(expect.objectContaining({ type: "apply-authoritative", kind: "reconciled-applied" }));
    expect(controller.effects()).toContainEqual(expect.objectContaining({ type: "autosave-slot-available" }));
  });

  it("requires explicit retry when reconciliation proves the write was not applied", () => {
    const { controller } = pasteControllerFixture();
    const save = dispatch(controller, { kind: "content", action: "manual-save", content: "two", omitVersion: false });
    controller.failMutation(save.token, { status: null }, 1);
    const reconcile = controller.startContentReconcile(2);
    if (reconcile.kind !== "dispatch") throw new Error("expected reconcile GET");

    controller.acceptContentReconcile(reconcile.requestToken, { status: 200, content: "one", paste: summary(), etag: '"sha256-one"' }, 3);

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

    controller.acceptContentReconcile(reconcile.requestToken, { status: 200, content: "one", paste: summary({ version: "g.2", updatedAt: "2026-09-15T00:00:01.000Z" }) }, 3);

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
    controller.acceptContentReconcile(first.requestToken, { status: 403 }, 3);
    expect(snapshot(controller).mutation.state).toBe("content-reconciliation");

    const second = controller.startContentReconcile(4);
    if (second.kind !== "dispatch") throw new Error("expected reconcile GET");
    controller.acceptContentReconcile(second.requestToken, { status: 503 }, 5);
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

    controller.acceptContentReconcile(reconcile.requestToken, { status: 200, content: "two", paste: summary({ viewOnce: true }) }, 3);

    expect(snapshot(controller)).toMatchObject({ phase: "consumed", mutation: { state: "idle" }, acceptedSource: "one", draft: "one", terminalResponseSource: "two" });
    expect(controller.effects()).toContainEqual(expect.objectContaining({ type: "terminal-settled", key: "content-reconcile-terminal-current-kept" }));
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

    controller.acceptMetadataReconcile(intended.requestToken, { status: 403 }, 3);

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

    controller.acceptMetadataReconcile(intended.requestToken, { status: 403 }, 3);

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

    expect(controller.acceptMetadataReconcile(intended.requestToken, { status: 304 }, 3)).toBe(true);
    expect(snapshot(controller).credential).toEqual({ committed: "intended value", pending: null });
  });

  it("settles failed reconciliation reads without releasing an autosave slot", () => {
    const { controller } = pasteControllerFixture();
    const save = dispatch(controller, { kind: "content", action: "autosave", content: "two", omitVersion: false });
    controller.failMutation(save.token, { status: 503 }, 1);
    const reconcile = controller.startContentReconcile(2);
    if (reconcile.kind !== "dispatch") throw new Error("expected reconcile GET");

    expect(controller.acceptContentReconcile(reconcile.requestToken, { status: 304 }, 3)).toBe(true);
    expect(snapshot(controller)).toMatchObject({ mutation: { state: "content-reconciliation" }, lastAction: { state: "failed", key: "content-reconcile" } });
    expect(controller.effects().some((effect) => effect.type === "autosave-slot-available")).toBe(false);
  });

  it("pauses before terminal disposal when a content reconcile read reports not found", () => {
    const { controller } = pasteControllerFixture();
    const save = dispatch(controller, { kind: "content", action: "autosave", content: "two", omitVersion: false });
    controller.failMutation(save.token, { status: 500 }, 1);
    const reconcile = controller.startContentReconcile(2);
    if (reconcile.kind !== "dispatch") throw new Error("expected reconcile GET");

    controller.acceptContentReconcile(reconcile.requestToken, { status: 404 }, 3);

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

    expect(reconcile).toMatchObject({ kind: "dispatch", type: "dispatch-relative-expiration-retry", now: 2 });
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
    expect(snapshot(controller).versionUsable).toBe(status === 409 ? false : true);
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
});
