import type * as React from "react";

import { cn } from "@/lib/utils";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "border-input placeholder:text-muted-foreground flex field-sizing-content min-h-16 w-full rounded-md border bg-transparent px-3 py-2 text-sm shadow-xs transition-colors outline-none disabled:cursor-not-allowed disabled:opacity-50",
        "focus-visible:border-ring focus-visible:ring-ring/40 focus-visible:ring-[3px]",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
