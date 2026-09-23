import * as React from "react";
import { dictionaries, errorMessage, labels, type Locale } from "../../i18n";
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
  onActivity?(eventAt: number, kind?: "recovery-credential"): void;
  locale?: Locale;
}

function resultMessage(state: DeleteFlowState, locale: Locale): string {
  if (state.result.message !== null) return state.result.message;
  if (state.result.state === "pending") return dictionaries[locale].actions.delete.pending;
  if (state.result.state === "succeeded") return dictionaries[locale].actions.delete.succeeded;
  if (state.result.state === "credential-required") return errorMessage(locale, "FORBIDDEN");
  if (state.result.state === "conflict") return errorMessage(locale, "VERSION_CONFLICT");
  if (state.result.state === "not-found" || state.phase === "not-found") return errorMessage(locale, "PASTE_NOT_FOUND");
  if (state.result.state === "uncertain" || state.phase === "delete-uncertain") return labels(locale).deleteUncertain;
  return dictionaries[locale].status.lastAction.failed;
}

export function DeleteFlow({ state, deletePaste, retry, reload, onActivity, locale = "en" }: DeleteFlowProps) {
  const [open, setOpen] = React.useState(false);
  const [credential, setCredential] = React.useState("");
  const cancel = React.useRef<HTMLButtonElement>(null);
  const trigger = React.useRef<HTMLButtonElement>(null);
  const copy = labels(locale);
  const pending = state.mutationPending || state.result.state === "pending";
  const blocked = pending || !state.versionUsable;

  React.useEffect(() => {
    if (blocked && open) setOpen(false);
  }, [blocked, open]);

  if (state.phase === "deleted-root-handoff") return <output role="status" data-root-handoff="true">{resultMessage(state, locale)}</output>;
  if (state.phase === "not-found" || state.phase === "delete-uncertain") return <section role="alert">{resultMessage(state, locale)}</section>;

  const confirm = () => {
    if (blocked) {
      setOpen(false);
      return;
    }
    setOpen(false);
    deletePaste(null);
  };
  const retryDelete = (authorizationPassword: string | null) => {
    if (blocked) return;
    retry(authorizationPassword);
  };
  const resultRole = state.result.state === "pending" || state.result.state === "succeeded" ? "status" : "alert";
  return (
    <section aria-label={copy.delete} data-server-controls="true" className="flex flex-wrap items-center gap-2 [&_button]:min-h-11 [&_button]:min-w-11 [&_input]:min-h-11">
      <Dialog open={open} onOpenChange={(next) => setOpen(next && !blocked)}>
        <DialogTrigger asChild><Button ref={trigger} type="button" variant="destructive" disabled={blocked}>{copy.delete}</Button></DialogTrigger>
        <DialogContent
          showCloseButton={false}
          onOpenAutoFocus={(event) => { event.preventDefault(); cancel.current?.focus(); }}
          onCloseAutoFocus={(event) => { event.preventDefault(); trigger.current?.focus(); }}
          onEscapeKeyDown={(event) => { event.preventDefault(); setOpen(false); trigger.current?.focus(); }}
          onPointerDownOutside={(event) => { event.preventDefault(); setOpen(false); trigger.current?.focus(); }}
        >
          <DialogHeader><DialogTitle>{copy.delete}</DialogTitle><DialogDescription>{dictionaries[locale].validation.deleteDescription}</DialogDescription></DialogHeader>
          <DialogFooter>
            <DialogClose asChild><Button ref={cancel} type="button" variant="outline" className="min-h-11 min-w-11">{copy.cancel}</Button></DialogClose>
            <Button type="button" variant="destructive" className="min-h-11 min-w-11" disabled={blocked} onClick={confirm}>{copy.delete}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {state.result.state !== "idle" && <p role={resultRole}>{resultMessage(state, locale)}</p>}
      {state.result.state === "credential-required" && <div className="flex items-end gap-2"><label>{copy.currentPassword}<Input name="deleteCredential" type="password" value={credential} onInput={(event) => { setCredential(event.currentTarget.value); onActivity?.(event.timeStamp, "recovery-credential"); }} /></label><Button type="button" disabled={blocked} onClick={() => retryDelete(credential === "" ? null : credential)}>{copy.retry}</Button></div>}
      {state.result.state === "conflict" && (state.versionUsable ? <><Button type="button" disabled={blocked} onClick={() => retryDelete(null)}>{copy.retry}</Button><Button type="button" variant="outline" onClick={reload}>{copy.reload}</Button></> : <Button type="button" variant="outline" onClick={reload}>{copy.reload}</Button>)}
    </section>
  );
}
