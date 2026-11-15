import type { ApprovalStatus, IntentStatus } from "@askgina/os-api";
import { AlertTriangle, Check, Copy, Inbox, Loader2 } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Alert } from "@/components/ui/alert.tsx";
import { Badge, type BadgeTone } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { errorMessage } from "@/lib/api.ts";
import { checksumAddress, groupedAddress } from "@/lib/format.ts";
import { cn } from "@/lib/utils.ts";

export function PageHeader({
  title,
  description,
  actions,
  back,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  back?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-col gap-3">
      {back}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight break-words">{title}</h1>
          {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </div>
    </header>
  );
}

export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground" role="status">
      <Loader2 className="size-4 animate-spin" aria-hidden />
      {label}…
    </div>
  );
}

/** A failed load, with the API's own message and a way to try again. */
export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  return (
    <Alert tone="danger" className="my-4 items-start">
      <AlertTriangle aria-hidden />
      <div className="flex flex-1 flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-medium">This could not be loaded.</p>
          <p className="text-muted-foreground">{errorMessage(error)}</p>
        </div>
        {retry ? (
          <Button variant="outline" size="sm" onClick={retry}>
            Try again
          </Button>
        ) : null}
      </div>
    </Alert>
  );
}

/**
 * The error from a write, shown next to the button that caused it. `explain` gives the words for
 * the errors a page knows better than the API's own message; null leaves it to that message.
 */
export function FormError({
  error,
  explain,
}: {
  error: unknown;
  explain?: (error: unknown) => string | null;
}) {
  if (!error) return null;
  return (
    <p role="alert" className="flex items-start gap-1.5 text-sm text-danger">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
      {explain?.(error) ?? errorMessage(error)}
    </p>
  );
}

export function EmptyState({
  icon,
  title,
  children,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-10 text-center">
      <div className="text-muted-foreground [&_svg]:size-6">{icon ?? <Inbox aria-hidden />}</div>
      <p className="font-medium">{title}</p>
      {children ? <div className="max-w-sm text-sm text-muted-foreground">{children}</div> : null}
    </div>
  );
}

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2_000);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <Button
      variant="outline"
      size="sm"
      aria-label={label}
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => setCopied(true));
      }}
    >
      {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

/** The whole checksummed address in groups of four, for reading against another screen. */
export function FullAddress({ address, className }: { address: string; className?: string }) {
  return (
    <span
      className={cn("font-mono text-sm leading-relaxed break-all", className)}
      title={checksumAddress(address)}
    >
      <span className="text-muted-foreground">0x</span>
      {groupedAddress(address).map((group, index) => (
        // Groups repeat, so the position is the stable key.
        // biome-ignore lint/suspicious/noArrayIndexKey: position is the identity here.
        <span key={index} className={index === 0 ? "" : "ml-[0.4em]"}>
          {group}
        </span>
      ))}
    </span>
  );
}

const approvalTone: Record<ApprovalStatus, BadgeTone> = {
  pending: "warning",
  approved: "accent",
  executed: "success",
  rejected: "neutral",
  expired: "neutral",
  cancelled: "neutral",
  failed: "danger",
};

const approvalLabel: Record<ApprovalStatus, string> = {
  pending: "Waiting for approval",
  approved: "Approved, applying",
  executed: "Done",
  rejected: "Rejected",
  expired: "Expired",
  cancelled: "Cancelled",
  failed: "Failed",
};

export function ApprovalStatusBadge({ status }: { status: ApprovalStatus }) {
  return <Badge tone={approvalTone[status]}>{approvalLabel[status]}</Badge>;
}

const intentTone: Record<IntentStatus, BadgeTone> = {
  proposed: "neutral",
  pending_approval: "warning",
  approved: "accent",
  signed: "accent",
  broadcast: "accent",
  submitted: "accent",
  placed: "accent",
  filled: "success",
  partially_filled: "success",
  confirmed: "success",
  reverted: "danger",
  stuck: "warning",
  rejected: "neutral",
  expired: "neutral",
  cancelled: "neutral",
  denied: "danger",
  failed: "danger",
  voided: "neutral",
};

const intentLabel: Record<IntentStatus, string> = {
  proposed: "Checking",
  pending_approval: "Waiting for approval",
  approved: "Approved",
  signed: "Signed",
  broadcast: "Sent to the network",
  submitted: "Sent to the venue",
  placed: "Resting at the venue",
  filled: "Filled",
  partially_filled: "Partly filled",
  confirmed: "Confirmed",
  reverted: "Reverted on chain",
  stuck: "Not mined yet",
  rejected: "Rejected",
  expired: "Expired",
  cancelled: "Cancelled",
  denied: "Refused by limits",
  failed: "Failed",
  voided: "Cancelled on chain",
};

export function IntentStatusBadge({ status }: { status: IntentStatus }) {
  return <Badge tone={intentTone[status]}>{intentLabel[status]}</Badge>;
}

export const backLinkClass =
  "w-fit text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline";

export const linkClass = "font-medium text-accent underline-offset-4 hover:underline";

/** A term and its value, stacked on narrow screens and side by side on wide ones. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-1 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm">{children}</dd>
    </div>
  );
}

/** A labelled hash or canonical structure in a page's technical details. */
export function TechBlock({ label, value, pre }: { label: string; value: string; pre?: boolean }) {
  return (
    <div className="grid grid-cols-1 gap-1">
      <p className="font-medium text-muted-foreground">{label}</p>
      {pre ? (
        <pre className="max-h-72 overflow-auto rounded-md bg-muted p-3 font-mono whitespace-pre-wrap break-all">
          {value}
        </pre>
      ) : (
        <code className="rounded-md bg-muted p-2 font-mono break-all">{value}</code>
      )}
    </div>
  );
}

/** One second ticks for countdowns. */
export function useNow(): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}
