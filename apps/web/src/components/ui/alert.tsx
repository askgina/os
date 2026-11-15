import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils.ts";

// Adapted from shadcn/ui (MIT), https://ui.shadcn.com/docs/components/alert
// `[&>*]:min-w-0`: the text beside the icon may shrink below its longest word and wrap there,
// instead of widening the page.
const alertVariants = cva(
  "flex gap-3 rounded-lg border px-4 py-3 text-sm [&>*]:min-w-0 [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0",
  {
    variants: {
      tone: {
        neutral: "bg-muted",
        accent: "border-accent/30 bg-accent-soft",
        warning: "border-warning/40 bg-warning-soft",
        danger: "border-danger/40 bg-danger-soft",
        success: "border-success/40 bg-success-soft",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export function Alert({
  className,
  tone,
  ...props
}: ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={cn(alertVariants({ tone }), className)}
      {...props}
    />
  );
}
