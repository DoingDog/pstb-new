import * as React from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "cn";

export function NativeSelect({ className, ...props }: React.ComponentProps<"select">) {
  return (
    <span className="relative block min-w-0">
      <select
        {...props}
        className={cn("h-11 w-full min-w-0 appearance-none rounded-md border border-input bg-background py-1 pr-9 pl-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive dark:bg-input/30 forced-colors:appearance-auto", className)}
      />
      <ChevronDown aria-hidden="true" className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground forced-colors:hidden" />
    </span>
  );
}
