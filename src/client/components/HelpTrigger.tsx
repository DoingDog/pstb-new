import * as React from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

export interface HelpTriggerProps {
  label: string;
  content: string;
  descriptionId: string;
}

interface OpenHelp {
  id: string;
  pinned: boolean;
}

interface HelpContextValue {
  open: OpenHelp | null;
  openUnpinned(id: string): void;
  closeUnpinned(id: string): void;
  toggle(id: string): void;
  close(returnFocus?: boolean): void;
  registerTrigger(id: string, node: HTMLButtonElement | null): void;
  registerContent(id: string, node: HTMLElement | null): void;
}

const HelpContext = React.createContext<HelpContextValue | null>(null);

export function HelpProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState<OpenHelp | null>(null);
  const triggers = React.useRef(new Map<string, HTMLButtonElement>());
  const contents = React.useRef(new Map<string, HTMLElement>());

  const close = React.useCallback((returnFocus = false) => {
    const current = open;
    setOpen(null);
    if (returnFocus && current !== null) triggers.current.get(current.id)?.focus();
  }, [open]);

  const openUnpinned = React.useCallback((id: string) => {
    setOpen((current) => current?.id === id && current.pinned ? current : { id, pinned: false });
  }, []);

  const closeUnpinned = React.useCallback((id: string) => {
    setOpen((current) => current?.id === id && !current.pinned ? null : current);
  }, []);

  const toggle = React.useCallback((id: string) => {
    setOpen((current) => current?.id === id && current.pinned ? null : { id, pinned: true });
  }, []);

  const registerTrigger = React.useCallback((id: string, node: HTMLButtonElement | null) => {
    if (node === null) triggers.current.delete(id);
    else triggers.current.set(id, node);
  }, []);

  const registerContent = React.useCallback((id: string, node: HTMLElement | null) => {
    if (node === null) contents.current.delete(id);
    else contents.current.set(id, node);
  }, []);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close(true);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (open === null) return;
      const trigger = triggers.current.get(open.id);
      const content = contents.current.get(open.id);
      const target = event.target;
      if (target instanceof Node && (trigger?.contains(target) || content?.contains(target))) return;
      close();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [close, open]);

  const value = React.useMemo<HelpContextValue>(() => ({
    open,
    openUnpinned,
    closeUnpinned,
    toggle,
    close,
    registerTrigger,
    registerContent,
  }), [close, closeUnpinned, open, openUnpinned, registerContent, registerTrigger, toggle]);

  return (
    <TooltipProvider delayDuration={0}>
      <HelpContext.Provider value={value}>{children}</HelpContext.Provider>
    </TooltipProvider>
  );
}

function useHelpContext(): HelpContextValue {
  const value = React.useContext(HelpContext);
  if (value === null) throw new Error("HelpTrigger must be used within HelpProvider.");
  return value;
}

export function HelpTrigger({ label, content, descriptionId }: HelpTriggerProps) {
  const help = useHelpContext();
  const isOpen = help.open?.id === descriptionId;

  return (
    <Tooltip open={isOpen}>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={label}
          aria-describedby={descriptionId}
          className="size-11 shrink-0"
          onPointerOver={(event) => {
            help.registerTrigger(descriptionId, event.currentTarget);
            help.openUnpinned(descriptionId);
          }}
          onFocus={(event) => {
            help.registerTrigger(descriptionId, event.currentTarget);
            help.openUnpinned(descriptionId);
          }}
          onPointerLeave={() => help.closeUnpinned(descriptionId)}
          onBlur={() => help.closeUnpinned(descriptionId)}
          onClick={(event) => {
            help.registerTrigger(descriptionId, event.currentTarget);
            help.toggle(descriptionId);
          }}
        >
          ?
        </Button>
      </TooltipTrigger>
      <TooltipContent
        className="max-w-[min(22rem,calc(100vw-2rem))] border border-border bg-popover text-popover-foreground"
        onEscapeKeyDown={() => help.close(true)}
      >
        <span id={descriptionId} ref={(node) => help.registerContent(descriptionId, node)}>{content}</span>
      </TooltipContent>
    </Tooltip>
  );
}
