import * as React from "react";
import {
  AutosaveController,
  type AutosaveControllerApi,
  type AutosaveOptions,
  type AutosaveSnapshot,
} from "../autosave";

export interface UseAutosaveOptions extends Omit<AutosaveOptions, "content" | "version" | "onStateChange"> {
  pasteIdentity: string;
  acceptedSource: string;
  version: string;
  onStateChange?(snapshot: AutosaveSnapshot): void;
}

export interface UseAutosaveResult {
  controller: AutosaveControllerApi;
  snapshot: Readonly<AutosaveSnapshot>;
}

type ControllerEntry = {
  identity: string;
  controller: AutosaveController;
};

function initialSnapshot(acceptedSource: string, version: string): AutosaveSnapshot {
  return {
    state: "clean",
    draft: acceptedSource,
    acceptedSource,
    lastSavedContent: acceptedSource,
    version,
    lastInputAt: null,
    dueAt: null,
    inFlightContent: null,
    dirtyWhileSaving: false,
    failureStatus: null,
    requiresExplicitRetry: false,
    coalescedIntent: false,
  };
}

export function useAutosave(options: UseAutosaveOptions): UseAutosaveResult {
  const entry = React.useRef<ControllerEntry | null>(null);
  const committedOptions = React.useRef(options);
  const latestSnapshot = React.useRef(initialSnapshot(options.acceptedSource, options.version));
  const appliedProps = React.useRef<{ identity: string; acceptedSource: string; version: string } | null>(null);
  const [snapshot, setSnapshot] = React.useState<AutosaveSnapshot>(() => latestSnapshot.current);
  const publicController = React.useRef<AutosaveControllerApi | null>(null);

  if (publicController.current === null) {
    publicController.current = {
      snapshot: () => entry.current?.controller.snapshot() ?? latestSnapshot.current,
      input: (content, eventAt) => entry.current?.controller.input(content, eventAt),
      compositionStart: () => entry.current?.controller.compositionStart(),
      compositionEnd: (content, eventAt) => entry.current?.controller.compositionEnd(content, eventAt),
      retry: () => entry.current?.controller.retry(),
      overwrite: () => entry.current?.controller.overwrite(),
      acknowledgeAcceptedContent: (acceptedSource, version) => entry.current?.controller.acknowledgeAcceptedContent(acceptedSource, version) ?? false,
      applyAuthoritative: (transition) => entry.current?.controller.applyAuthoritative(transition),
      slotAvailable: () => entry.current?.controller.slotAvailable(),
      dispose: () => entry.current?.controller.dispose(),
    };
  }

  React.useLayoutEffect(() => {
    committedOptions.current = options;
  });

  React.useLayoutEffect(() => {
    let controller: AutosaveController | null = null;
    const stateChanged = (next: AutosaveSnapshot): void => {
      if (entry.current?.controller !== controller) return;
      latestSnapshot.current = next;
      setSnapshot(next);
      committedOptions.current.onStateChange?.(next);
    };
    controller = new AutosaveController({
      content: options.acceptedSource,
      version: options.version,
      now: () => committedOptions.current.now(),
      setTimer: (callback, delay) => committedOptions.current.setTimer(callback, delay),
      clearTimer: (timer) => committedOptions.current.clearTimer(timer),
      tryDispatch: (request) => committedOptions.current.tryDispatch(request),
      onCoalescedIntent: () => committedOptions.current.onCoalescedIntent(),
      getPassword: () => committedOptions.current.getPassword?.() ?? null,
      onStateChange: stateChanged,
    });
    const owner: ControllerEntry = { identity: options.pasteIdentity, controller };
    entry.current = owner;
    latestSnapshot.current = controller.snapshot();
    setSnapshot(latestSnapshot.current);

    return () => {
      if (entry.current !== owner) return;
      entry.current = null;
      controller.dispose();
    };
  }, [options.pasteIdentity]);

  React.useLayoutEffect(() => {
    const current = entry.current;
    const previous = appliedProps.current;
    appliedProps.current = {
      identity: options.pasteIdentity,
      acceptedSource: options.acceptedSource,
      version: options.version,
    };
    if (current === null || current.identity !== options.pasteIdentity || previous === null || previous.identity !== options.pasteIdentity) return;

    const sourceChanged = previous.acceptedSource !== options.acceptedSource;
    const versionChanged = previous.version !== options.version;
    if (!sourceChanged && !versionChanged) return;

    const currentSnapshot = current.controller.snapshot();
    if (sourceChanged && (currentSnapshot.acceptedSource !== options.acceptedSource || currentSnapshot.version !== options.version)) {
      current.controller.applyAuthoritative({
        kind: "replace",
        acceptedSource: options.acceptedSource,
        version: options.version,
      });
      return;
    }
    if (versionChanged && currentSnapshot.version !== options.version) {
      current.controller.applyAuthoritative({
        kind: "metadata",
        acceptedSource: options.acceptedSource,
        version: options.version,
      });
    }
  }, [options.pasteIdentity, options.acceptedSource, options.version]);

  const visibleSnapshot = entry.current?.identity === options.pasteIdentity
    ? snapshot
    : initialSnapshot(options.acceptedSource, options.version);
  return { controller: publicController.current, snapshot: visibleSnapshot };
}
