import type { ComponentProps } from "react";
import { cn } from "@/lib/utils.ts";

// Adapted from shadcn/ui (MIT), https://ui.shadcn.com/docs/components/label
export function Label({ className, ...props }: ComponentProps<"label">) {
  // biome-ignore lint/a11y/noLabelWithoutControl: callers pass htmlFor or wrap the control.
  return <label className={cn("text-sm font-medium leading-none", className)} {...props} />;
}
