import { type ReactNode, useEffect, useRef } from "react";
import { cn } from "@/lib/utils.ts";

/**
 * A modal confirmation on the native <dialog> element, which traps focus, closes on Escape
 * and needs no portal. Plays the role of shadcn/ui's AlertDialog.
 */
export function Dialog({
  open,
  onClose,
  title,
  children,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      aria-label={title}
      className={cn(
        "m-auto w-[calc(100%-2rem)] max-w-md rounded-lg border bg-card p-6 text-foreground backdrop:bg-black/50",
        className,
      )}
    >
      <h2 className="text-lg font-semibold">{title}</h2>
      {children}
    </dialog>
  );
}
