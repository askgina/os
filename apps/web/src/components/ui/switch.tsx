import type { ComponentProps } from "react";
import { cn } from "@/lib/utils.ts";

// Adapted from shadcn/ui (MIT), https://ui.shadcn.com/docs/components/switch, without Radix:
// a native button with role="switch" gives the same keyboard and screen reader behaviour.
export function Switch({
  checked,
  onCheckedChange,
  tone = "danger",
  className,
  ...props
}: Omit<ComponentProps<"button">, "onChange"> & {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** The colour when on: `danger` for a switch that stops things (pausing), `accent` otherwise. */
  tone?: "danger" | "accent";
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "inline-flex h-6 w-11 shrink-0 items-center rounded-full border-2 border-transparent transition-colors disabled:opacity-50",
        checked ? (tone === "danger" ? "bg-danger" : "bg-accent") : "bg-input",
        className,
      )}
      {...props}
    >
      <span
        className={cn(
          "block size-5 rounded-full bg-white shadow transition-transform",
          checked ? "translate-x-5" : "translate-x-0",
        )}
      />
    </button>
  );
}
