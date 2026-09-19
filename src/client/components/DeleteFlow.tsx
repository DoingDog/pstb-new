import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

export type DeletePhase = "ordinary" | "deleted-root-handoff" | "not-found" | "delete-uncertain";
export type DeleteResultState = "idle" | "pending" | "succeeded" | "credential-required" | "conflict" | "not-found" | "uncertain";

export interface DeleteFlowState {
  phase: DeletePhase;
  result: { state: DeleteResultState; message: string | null };
  mutationPending: boolean;
  versionUsable: boolean;
}

export interface DeleteFlowProps {
  state: DeleteFlowState;
  deletePaste(authorizationPassword: string | null): void;
  retry(authorizationPassword: string | null): void;
  reload(): void;
}

export function DeleteFlow({ state, deletePaste, retry, reload }: DeleteFlowProps) {
  const [open, setOpen] = React.useState(false);
  const [credential, setCredential] = React.useState("");
  const cancel = React.useRef<HTMLButtonElement>(null);
  const trigger = React.useRef<HTMLButtonElement>(null);
  if (state.phase === "deleted-root-handoff") return <output data-root-handoff="true">{state.result.message ?? "Paste deleted."}</output>;
  if (state.phase === "not-found" || state.phase === "delete-uncertain") return <section role="alert">{state.result.message}</section>;

  const pending = state.mutationPending || state.result.state === "pending";
  const retryDisabled = state.result.state === "conflict" && !state.versionUsable;
  const confirm = () => {
    setOpen(false);
    deletePaste(null);
  };
  return (
    <section aria-label="Delete" data-server-controls="true" className="flex flex-wrap items-center gap-2">
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild><Button ref={trigger} type="button" variant="destructive" disabled={pending}>Delete</Button></DialogTrigger>
        <DialogContent
          showCloseButton={false}
          onOpenAutoFocus={(event) => { event.preventDefault(); cancel.current?.focus(); }}
          onCloseAutoFocus={(event) => { event.preventDefault(); trigger.current?.focus(); }}
          onEscapeKeyDown={(event) => { event.preventDefault(); setOpen(false); trigger.current?.focus(); }}
          onPointerDownOutside={(event) => { event.preventDefault(); setOpen(false); trigger.current?.focus(); }}
        >
          <DialogHeader><DialogTitle>Delete</DialogTitle><DialogDescription>Delete this paste permanently.</DialogDescription></DialogHeader>
          <DialogFooter>
            <DialogClose asChild><Button ref={cancel} type="button" variant="outline">Cancel</Button></DialogClose>
            <Button type="button" variant="destructive" onClick={confirm}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {state.result.message !== null && state.result.state !== "idle" && <p role="alert">{state.result.message}</p>}
      {state.result.state === "credential-required" && <div className="flex items-end gap-2"><label>Current password<Input name="deleteCredential" type="password" value={credential} onInput={(event) => setCredential(event.currentTarget.value)} /></label><Button type="button" onClick={() => retry(credential === "" ? null : credential)}>Retry</Button></div>}
      {state.result.state === "conflict" && <><Button type="button" disabled={retryDisabled} onClick={() => retry(null)}>Retry</Button><Button type="button" variant="outline" onClick={reload}>Reload</Button></>}
    </section>
  );
}
