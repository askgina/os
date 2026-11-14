import { cn } from "@/lib/utils.ts";

/** A horizontal bar with its value also given as text, so colour is never the only signal. */
export function Progress({
  value,
  label,
  tone = "accent",
  className,
}: {
  value: number;
  label: string;
  tone?: "accent" | "warning" | "danger";
  className?: string;
}) {
  const fill = { accent: "bg-accent", warning: "bg-warning", danger: "bg-danger" }[tone];
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value)}
      className={cn("h-2 w-full overflow-hidden rounded-full bg-muted", className)}
    >
      <div className={cn("h-full rounded-full", fill)} style={{ width: `${value}%` }} />
    </div>
  );
}
