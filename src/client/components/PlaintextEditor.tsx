import * as React from "react";
import type { AutosaveControllerApi } from "../autosave";
import type { SourceEvent } from "../contracts";
import { Textarea } from "./ui/textarea";

export type EditorWrap = "off" | "soft";

export interface PlaintextEditorProps {
  value: string;
  wrap: EditorWrap;
  autosave: Pick<AutosaveControllerApi, "input" | "compositionStart" | "compositionEnd">;
  onSourceEvent(event: SourceEvent): void;
  disabled?: boolean;
  label?: string;
}

export function PlaintextEditor({
  value,
  wrap,
  autosave,
  onSourceEvent,
  disabled = false,
  label = "Content",
}: PlaintextEditorProps) {
  const composing = React.useRef(false);
  const duplicateCompositionInput = React.useRef<string | null>(null);

  const onInput = React.useCallback((event: React.FormEvent<HTMLTextAreaElement>) => {
    const content = event.currentTarget.value;
    const eventAt = event.timeStamp;
    if (duplicateCompositionInput.current === content) {
      duplicateCompositionInput.current = null;
      return;
    }
    duplicateCompositionInput.current = null;
    const type = composing.current ? "composition-input" : "input";
    onSourceEvent({ type, content, eventAt });
    autosave.input(content, eventAt);
  }, [autosave, onSourceEvent]);

  const onCompositionStart = React.useCallback((event: React.CompositionEvent<HTMLTextAreaElement>) => {
    const content = event.currentTarget.value;
    const eventAt = event.timeStamp;
    composing.current = true;
    duplicateCompositionInput.current = null;
    onSourceEvent({ type: "composition-start", content, eventAt });
    autosave.compositionStart();
  }, [autosave, onSourceEvent]);

  const onCompositionEnd = React.useCallback((event: React.CompositionEvent<HTMLTextAreaElement>) => {
    const content = event.currentTarget.value;
    const eventAt = event.timeStamp;
    composing.current = false;
    duplicateCompositionInput.current = content;
    onSourceEvent({ type: "composition-end", content, eventAt });
    autosave.compositionEnd(content, eventAt);
  }, [autosave, onSourceEvent]);

  return (
    <Textarea
      aria-label={label}
      className={`min-h-80 font-mono ${wrap === "soft" ? "whitespace-pre-wrap break-words" : "whitespace-pre"}`}
      disabled={disabled}
      onCompositionEnd={onCompositionEnd}
      onCompositionStart={onCompositionStart}
      onInput={onInput}
      spellCheck={false}
      value={value}
      wrap={wrap}
    />
  );
}
