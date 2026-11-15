import type { ComponentProps } from "react";
import { cn } from "@/lib/utils.ts";

// Adapted from shadcn/ui (MIT), https://ui.shadcn.com/docs/components/input
export function Input({ className, ...props }: ComponentProps<"input">) {
  return (
    <input
      className={cn(
        "flex h-10 w-full min-w-0 rounded-md border border-input bg-card px-3 text-sm placeholder:text-muted-foreground disabled:opacity-50 aria-invalid:border-danger",
        className,
      )}
      {...props}
    />
  );
}

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      className={cn(
        "flex min-h-20 w-full min-w-0 rounded-md border border-input bg-card px-3 py-2 font-mono text-sm placeholder:text-muted-foreground disabled:opacity-50 aria-invalid:border-danger",
        className,
      )}
      {...props}
    />
  );
}

export function Select({ className, ...props }: ComponentProps<"select">) {
  return (
    <select
      className={cn(
        // `min-w-0`: an option longer than the screen is cut off instead of widening the page.
        "flex h-10 w-full min-w-0 rounded-md border border-input bg-card px-3 text-sm disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}
