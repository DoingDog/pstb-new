import * as React from "react";
import { Check } from "lucide-react";
import { cn } from "cn";

export function Checkbox({ className, ...props }: Omit<React.ComponentProps<"input">, "type">) {
  return (
    <span className="relative inline-flex size-5 shrink-0 items-center">
      <input
        {...props}
        type="checkbox"
        className={cn("peer size-5 cursor-pointer appearance-none rounded border border-input bg-background outline-none checked:border-primary checked:bg-primary focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive forced-colors:appearance-auto", className)}
      />
      <Check aria-hidden="true" className="pointer-events-none absolute inset-0 size-5 p-0.5 text-primary-foreground opacity-0 peer-checked:opacity-100 forced-colors:hidden" />
    </span>
  );
}
