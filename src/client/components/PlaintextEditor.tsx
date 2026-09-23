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
  const [inputValue, setInputValue] = React.useState(value);
  const [previousValue, setPreviousValue] = React.useState(value);
  if (previousValue !== value) {
    setPreviousValue(value);
    setInputValue(value);
  }
  const latest = React.useRef({ content: inputValue, autosave, onSourceEvent });
  latest.current = { content: inputValue, autosave, onSourceEvent };

  React.useEffect(() => () => {
    if (!composing.current) return;
    composing.current = false;
    const eventAt = performance.now();
    const { content, autosave: currentAutosave, onSourceEvent: currentSourceEvent } = latest.current;
    currentSourceEvent({ type: "composition-end", content, eventAt });
    currentAutosave.compositionEnd(content, eventAt);
  }, []);

  const onCompositionStart = React.useCallback((event: React.CompositionEvent<HTMLTextAreaElement>) => {
    const content = event.currentTarget.value;
    const eventAt = event.timeStamp;
    composing.current = true;
    duplicateCompositionInput.current = null;
    onSourceEvent({ type: "composition-start", content, eventAt });
    autosave.compositionStart();
  }, [autosave, onSourceEvent]);

  const finishComposition = React.useCallback((content: string, eventAt: number) => {
    composing.current = false;
    duplicateCompositionInput.current = content;
    setInputValue(content);
    onSourceEvent({ type: "composition-end", content, eventAt });
    autosave.compositionEnd(content, eventAt);
  }, [autosave, onSourceEvent]);

  const onInput = React.useCallback((event: React.FormEvent<HTMLTextAreaElement>) => {
    const content = event.currentTarget.value;
    latest.current.content = content;
    const eventAt = event.timeStamp;
    if (duplicateCompositionInput.current === content) {
      duplicateCompositionInput.current = null;
      return;
    }
    duplicateCompositionInput.current = null;
    const nativeComposing = "isComposing" in event.nativeEvent ? (event.nativeEvent as InputEvent).isComposing : null;
    if (nativeComposing === false && composing.current) {
      finishComposition(content, eventAt);
      return;
    }
    if (nativeComposing === true && !composing.current) {
      composing.current = true;
      onSourceEvent({ type: "composition-start", content, eventAt });
      autosave.compositionStart();
    }
    setInputValue(content);
    const type = composing.current ? "composition-input" : "input";
    onSourceEvent({ type, content, eventAt });
    autosave.input(content, eventAt);
  }, [autosave, finishComposition, onSourceEvent]);

  const onCompositionEnd = React.useCallback((event: React.CompositionEvent<HTMLTextAreaElement>) => {
    const content = event.currentTarget.value;
    if (!composing.current && duplicateCompositionInput.current === content) return;
    finishComposition(content, event.timeStamp);
  }, [finishComposition]);

  const onBlur = React.useCallback((event: React.FocusEvent<HTMLTextAreaElement>) => {
    if (composing.current) finishComposition(event.currentTarget.value, event.timeStamp);
  }, [finishComposition]);

  return (
    <Textarea
      aria-label={label}
      className={`min-h-80 font-mono ${wrap === "soft" ? "whitespace-pre-wrap break-words" : "whitespace-pre"}`}
      disabled={disabled}
      onBlur={onBlur}
      onCompositionEnd={onCompositionEnd}
      onCompositionStart={onCompositionStart}
      onInput={onInput}
      spellCheck={false}
      value={inputValue}
      wrap={wrap}
    />
  );
}
