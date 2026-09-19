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

export function useAutosave(options: UseAutosaveOptions): UseAutosaveResult {
  const latest = React.useRef(options);
  latest.current = options;
  const stateListener = React.useRef<(snapshot: AutosaveSnapshot) => void>(() => undefined);
  const entry = React.useRef<ControllerEntry | null>(null);
  let changedIdentity = false;

  if (entry.current === null || entry.current.identity !== options.pasteIdentity) {
    entry.current?.controller.dispose();
    const controller = new AutosaveController({
      content: options.acceptedSource,
      version: options.version,
      now: () => latest.current.now(),
      setTimer: (callback, delay) => latest.current.setTimer(callback, delay),
      clearTimer: (timer) => latest.current.clearTimer(timer),
      tryDispatch: (request) => latest.current.tryDispatch(request),
      onCoalescedIntent: () => latest.current.onCoalescedIntent(),
      getPassword: () => latest.current.getPassword?.() ?? null,
      onStateChange: (snapshot) => stateListener.current(snapshot),
    });
    entry.current = { identity: options.pasteIdentity, controller };
    changedIdentity = true;
  }

  const controller = entry.current.controller;
  const [snapshot, setSnapshot] = React.useState<AutosaveSnapshot>(() => controller.snapshot());
  const propState = React.useRef({ controller, acceptedSource: options.acceptedSource, version: options.version });

  stateListener.current = (next) => {
    setSnapshot(next);
    latest.current.onStateChange?.(next);
  };

  React.useEffect(() => () => controller.dispose(), [controller]);

  React.useEffect(() => {
    const previous = propState.current;
    const sourceChanged = previous.acceptedSource !== options.acceptedSource;
    const versionChanged = previous.version !== options.version;
    propState.current = { controller, acceptedSource: options.acceptedSource, version: options.version };
    if (previous.controller !== controller || (!sourceChanged && !versionChanged)) return;

    const current = controller.snapshot();
    if (sourceChanged && (current.acceptedSource !== options.acceptedSource || current.version !== options.version)) {
      controller.applyAuthoritative({
        kind: "replace",
        acceptedSource: options.acceptedSource,
        version: options.version,
      });
      return;
    }
    if (versionChanged && current.version !== options.version) {
      controller.applyAuthoritative({
        kind: "metadata",
        acceptedSource: options.acceptedSource,
        version: options.version,
      });
    }
  }, [controller, options.acceptedSource, options.version]);

  return { controller, snapshot: changedIdentity ? controller.snapshot() : snapshot };
}
