import {
  ApiError,
  type AssetBalance,
  type ChainInfo,
  type MandateAssetView,
  type MandateDraft,
  type MandateStatus,
  type MandateSummary,
  type WalletDetail,
  type WorkspaceDetail,
} from "@askgina/os-api";
import type { AgentId, Mandate } from "@askgina/os-protocol";
import { useMutation } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Ban, CalendarClock, TriangleAlert } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import {
  EmptyState,
  ErrorState,
  FormError,
  FullAddress,
  Loading,
  useNow,
} from "@/components/common.tsx";
import { Alert } from "@/components/ui/alert.tsx";
import { Badge, type BadgeTone } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.tsx";
import { Choice } from "@/components/ui/choice.tsx";
import { Dialog } from "@/components/ui/dialog.tsx";
import { Input, Select, Textarea } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";
import { Progress } from "@/components/ui/progress.tsx";
import {
  api,
  errorMessage,
  keys,
  type MandateFilter,
  queryClient,
  useMandates,
} from "@/lib/api.ts";
import {
  type AssetInfo,
  assetInfo,
  chainName,
  formatAsset,
  NATIVE_DECIMALS,
} from "@/lib/assets.ts";
import { explainCode, explainMandateRefusal } from "@/lib/codes.ts";
import { formatTime, formatUnits, percentOf } from "@/lib/format.ts";
import {
  type EndChoiceId,
  endChoices,
  endedReasonSentence,
  formatEndTime,
  formatTimeLeft,
  formatWindow,
  localDateTimeValue,
  type MandateForm,
  MandateFormError,
  mandateDraft,
  mandateSentence,
  mandateStatusLabel,
  parseLocalDateTime,
  WINDOW_CHOICES,
  worstCase,
  worstCaseSentence,
} from "@/lib/mandate.ts";
import { cn } from "@/lib/utils.ts";

/**
 * Approving payments in advance (a mandate): one person's approval, once, lets one agent pay
 * listed recipients from one wallet within stated amounts until a time; the signer enforces it.
 * These pieces show one, granted or still a draft, and let people grant, watch and revoke them.
 */

/** What a mandate allows, granted or still a draft: the fields every card reads. */
export type MandateTerms = Pick<
  Mandate,
  "assets" | "recipients" | "windowSeconds" | "maxUses" | "maxFeePerActionWei" | "notAfter"
>;

/** A long label wraps on a narrow screen or with large text, instead of widening the page. */
const wrappingButton = "h-auto min-h-10 min-w-0 py-2 text-center whitespace-normal";

/**
 * How each asset of a mandate is named and scaled, in the order of `terms.assets`: as the server
 * read it from the chain when it can, otherwise from the chain list and the wallet's balances.
 */
export function mandateAssetInfos(
  terms: Pick<MandateTerms, "assets">,
  chains: readonly ChainInfo[],
  views: readonly MandateAssetView[] = [],
  balances: readonly AssetBalance[] = [],
): AssetInfo[] {
  return terms.assets.map((limit) => {
    const view = views.find((item) => item.chainId === limit.chainId && item.asset === limit.asset);

    if (view?.symbol && view.decimals !== null) {
      return { symbol: view.symbol, decimals: view.decimals };
    }

    return assetInfo(limit.chainId, limit.asset, chains, balances);
  });
}

const UNKNOWN: AssetInfo = { symbol: "unknown asset", decimals: null };

/** The network fee is paid in the native coin of the chain the payment is on. */
function feeUnit(assets: readonly { chainId: string }[], chains: readonly ChainInfo[]): AssetInfo {
  const chainIds = new Set(assets.map((limit) => limit.chainId));
  const [only] = chainIds;

  const symbol =
    chainIds.size === 1 && only !== undefined
      ? (chains.find((chain) => chain.chainId === only)?.nativeSymbol ?? "native coin")
      : "native coin";

  return { symbol, decimals: NATIVE_DECIMALS };
}

/** The whole mandate in one sentence, with the end time in the viewer's own time zone. */
export function MandateSentence({
  terms,
  agent,
  infos,
  className,
}: {
  terms: MandateTerms;
  agent: string;
  infos: readonly AssetInfo[];
  className?: string;
}) {
  const sentence = mandateSentence({
    agent,
    assets: terms.assets.map((limit, index) => {
      const info = infos[index] ?? UNKNOWN;

      return {
        perAction: formatAsset(limit.maxPerAction, info),
        perWindow: formatAsset(limit.maxPerWindow, info),
        total: formatAsset(limit.maxTotal, info),
      };
    }),
    recipients: terms.recipients.length,
    windowSeconds: terms.windowSeconds,
    maxUses: terms.maxUses,
    ends: formatEndTime(terms.notAfter),
  });

  return <p className={cn("text-base font-medium wrap-anywhere", className)}>{sentence}</p>;
}

/** The most that can leave the wallet under the mandate, set apart from everything else. */
export function MandateWorstCase({
  terms,
  infos,
  chains,
}: {
  terms: MandateTerms;
  infos: readonly AssetInfo[];
  chains: readonly ChainInfo[];
}) {
  const fee = BigInt(terms.maxFeePerActionWei);
  const unit = feeUnit(terms.assets, chains);

  const sentence = worstCaseSentence({
    amounts: terms.assets.map((limit, index) =>
      formatAsset(
        worstCase(
          { maxPerAction: BigInt(limit.maxPerAction), maxTotal: BigInt(limit.maxTotal) },
          terms.maxUses,
        ).toString(),
        infos[index] ?? UNKNOWN,
      ),
    ),
    feePerPayment: formatAsset(fee.toString(), unit),
    feeTotal: formatAsset((fee * BigInt(terms.maxUses)).toString(), unit),
  });

  return (
    <section
      aria-label="Worst case"
      className="grid grid-cols-1 gap-1 rounded-lg border-2 border-warning/50 bg-warning-soft px-4 py-3"
    >
      <p className="text-xs font-medium text-muted-foreground">Worst case</p>
      <p className="text-sm font-semibold wrap-anywhere">{sentence}</p>
    </section>
  );
}

/** Every recipient in full, in groups of four, as a payment card shows its one recipient. */
export function MandateRecipients({ recipients }: { recipients: readonly string[] }) {
  return (
    <div className="grid grid-cols-1 gap-1.5">
      <p className="text-xs text-muted-foreground">
        May pay only{" "}
        {recipients.length === 1 ? "this address" : `these ${recipients.length} addresses`} (check
        every group)
      </p>
      <ul className="grid grid-cols-1 gap-1.5" aria-label="Recipients">
        {recipients.map((address) => (
          <li key={address} className="min-w-0 rounded-md border px-3 py-1.5">
            <FullAddress address={address} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function Term({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm tabular-nums wrap-anywhere">{children}</dd>
    </div>
  );
}

/**
 * Each asset's caps, its worst case and, when the server read them, the wallet's own limits for
 * it, which still apply to every payment and count the payments made under the mandate.
 */
export function MandateLimits({
  terms,
  infos,
  chains,
  views,
}: {
  terms: MandateTerms;
  infos: readonly AssetInfo[];
  chains: readonly ChainInfo[];
  /** The server's view of each asset, with the wallet's limits; omitted for a draft. */
  views?: readonly MandateAssetView[];
}) {
  const window = formatWindow(terms.windowSeconds);

  return (
    <div className="grid grid-cols-1 gap-2">
      {terms.assets.map((limit, index) => {
        const info = infos[index] ?? UNKNOWN;

        const policy = views?.find(
          (view) => view.chainId === limit.chainId && view.asset === limit.asset,
        )?.policy;

        return (
          <div
            key={`${limit.chainId}|${limit.asset}`}
            className="grid grid-cols-1 gap-2 rounded-md border p-3"
          >
            <p className="text-sm font-medium wrap-anywhere">
              {info.symbol} on {chainName(limit.chainId, chains)}
            </p>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
              <Term label="Per payment">{formatAsset(limit.maxPerAction, info)}</Term>
              <Term label={`In any ${window}`}>{formatAsset(limit.maxPerWindow, info)}</Term>
              <Term label="In total">{formatAsset(limit.maxTotal, info)}</Term>
              <Term label="Most that can leave">
                {formatAsset(
                  worstCase(
                    { maxPerAction: BigInt(limit.maxPerAction), maxTotal: BigInt(limit.maxTotal) },
                    terms.maxUses,
                  ).toString(),
                  info,
                )}
              </Term>
            </dl>
            {views ? (
              <p className="text-xs text-muted-foreground wrap-anywhere">
                {policy
                  ? `The wallet's limits: ${formatAsset(policy.maxPerTx, info)} per transaction, ${formatAsset(policy.maxPerDay, info)} per 24 hours.`
                  : "The wallet's limits have no cap for this asset, so the signer sends none of it."}
              </p>
            ) : null}
          </div>
        );
      })}
      {views ? (
        <p className="text-sm">The wallet's limits still apply and count these payments.</p>
      ) : null}
    </div>
  );
}

const statusTone: Record<MandateStatus, BadgeTone> = {
  active: "success",
  not_yet_valid: "accent",
  expired: "neutral",
  exhausted: "neutral",
  revoked: "neutral",
};

export function MandateStatusBadge({ status }: { status: MandateStatus }) {
  return <Badge tone={statusTone[status]}>{mandateStatusLabel[status]}</Badge>;
}

/** When it ends and how long that is from now, or when and why it ended. */
export function MandateTime({ summary, now }: { summary: MandateSummary; now: number }) {
  const { mandate } = summary;

  if (summary.endedReason !== null) {
    const at = summary.revokedAt ?? Math.min(mandate.notAfter, now);

    return (
      <span>
        Ended {summary.endedReason === "expired" ? formatEndTime(mandate.notAfter) : formatTime(at)}
        . {endedReasonSentence[summary.endedReason]}
      </span>
    );
  }

  if (summary.status === "not_yet_valid") {
    return (
      <span>
        Starts {formatEndTime(mandate.notBefore)}, in {formatTimeLeft(mandate.notBefore - now)}
      </span>
    );
  }

  return (
    <span>
      Ends {formatEndTime(mandate.notAfter)}, in {formatTimeLeft(mandate.notAfter - now)}
    </span>
  );
}

/**
 * What the signer counted: payments used and left, and per asset the total and the window
 * against their caps. `compact` shows only the payments and the totals, for lists.
 */
export function MandateUsage({
  summary,
  infos,
  compact,
}: {
  summary: MandateSummary;
  infos: readonly AssetInfo[];
  compact?: boolean;
}) {
  const { usage, mandate } = summary;

  if (!usage) {
    return (
      <p className="text-sm text-warning">
        The signer no longer holds this approval, so nothing more can be signed under it.
      </p>
    );
  }

  const window = formatWindow(mandate.windowSeconds);

  return (
    <div className="grid grid-cols-1 gap-3">
      <p className="text-sm">
        <span className="font-medium">
          {usage.uses} of {mandate.maxUses} {mandate.maxUses === 1 ? "payment" : "payments"} used
        </span>
        <span className="text-muted-foreground"> · {usage.usesLeft} left</span>
      </p>
      {mandate.assets.map((limit, index) => {
        const info = infos[index] ?? UNKNOWN;

        const used = usage.assets.find(
          (entry) => entry.chainId === limit.chainId && entry.asset === limit.asset,
        );

        const bars = [
          {
            label: `${info.symbol} in total`,
            used: used?.usedTotal ?? "0",
            cap: limit.maxTotal,
          },
          ...(compact
            ? []
            : [
                {
                  label: `${info.symbol} in the last ${window}`,
                  used: used?.usedInWindow ?? "0",
                  cap: limit.maxPerWindow,
                },
              ]),
        ];

        return bars.map((bar) => {
          const share = percentOf(bar.used, bar.cap);

          return (
            <div key={`${limit.chainId}|${limit.asset}|${bar.label}`} className="grid gap-1">
              <div className="flex flex-wrap justify-between gap-x-2 text-xs">
                <span className="min-w-0 text-muted-foreground">{bar.label}</span>
                <span className="min-w-0 tabular-nums wrap-anywhere">
                  {formatAsset(bar.used, info)} of {formatAsset(bar.cap, info)}
                </span>
              </div>
              <Progress
                value={share}
                label={`${bar.label}, used of its cap`}
                tone={share >= 90 ? "danger" : share >= 70 ? "warning" : "accent"}
              />
            </div>
          );
        });
      })}
      {compact ? null : (
        <p className="text-xs text-muted-foreground">
          Every payment the signer signed counts, also one the network never included. Counted
          payments are never given back.
        </p>
      )}
    </div>
  );
}

/** Stopping a mandate needs no passkey: it only takes authority away, at once and for good. */
export function RevokeMandateButton({
  summary,
  className,
}: {
  summary: MandateSummary;
  className?: string;
}) {
  const [open, setOpen] = useState(false);

  const revoke = useMutation({
    mutationFn: () =>
      api.call("revokeMandate", {
        params: { workspaceId: summary.workspaceId, mandateId: summary.id },
        body: {},
      }),
    onSuccess: async () => {
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: keys.mandates(summary.workspaceId) });
    },
  });

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className={cn("w-fit", className)}
        onClick={() => setOpen(true)}
        disabled={revoke.isPending}
      >
        <Ban aria-hidden />
        Revoke
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Revoke this approval in advance?">
        <p className="mt-2 text-sm text-muted-foreground">
          {summary.agent.name} can no longer pay without asking under it, from now on. Payments
          already signed stay. It cannot be resumed: to allow such payments again, someone asks for
          a new approval. No passkey is needed to revoke.
        </p>
        <FormError error={revoke.error} />
        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={() => setOpen(false)}>
            Keep it
          </Button>
          <Button variant="destructive" onClick={() => revoke.mutate()} disabled={revoke.isPending}>
            {revoke.isPending ? "Revoking…" : "Revoke"}
          </Button>
        </div>
      </Dialog>
    </>
  );
}

/** Mandates as a list, each linking to its own page, with its usage and, while live, Revoke. */
export function MandateList({
  items,
  workspace,
  now,
}: {
  items: readonly MandateSummary[];
  workspace: WorkspaceDetail;
  now: number;
}) {
  const canRevoke = workspace.role !== "viewer";

  return (
    <ul className="divide-y rounded-md border">
      {items.map((item) => {
        const infos = mandateAssetInfos(item.mandate, workspace.chains, item.assets);
        const wallet = workspace.wallets.find((candidate) => candidate.id === item.walletId);

        const caps = item.mandate.assets
          .map(
            (limit, index) =>
              `up to ${formatAsset(limit.maxPerAction, infos[index] ?? UNKNOWN)} per payment`,
          )
          .join(", ");

        return (
          <li key={item.id} className="grid grid-cols-1 gap-2 px-4 py-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <Link
                to="/w/$workspaceId/mandates/$mandateId"
                params={{ workspaceId: workspace.id, mandateId: item.id }}
                className="min-w-0 font-medium underline-offset-4 wrap-anywhere hover:underline"
              >
                {item.agent.name}: {caps}
              </Link>
              <MandateStatusBadge status={item.status} />
            </div>
            <p className="text-xs text-muted-foreground wrap-anywhere">
              From {wallet?.label ?? "a wallet"} to{" "}
              {item.mandate.recipients.length === 1
                ? "1 listed recipient"
                : `${item.mandate.recipients.length} listed recipients`}
              . <MandateTime summary={item} now={now} />
            </p>
            {item.endedReason === null ? (
              <MandateUsage summary={item} infos={infos} compact />
            ) : null}
            {canRevoke && item.endedReason === null ? <RevokeMandateButton summary={item} /> : null}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The "Approved in advance" card of a wallet or an agent: live mandates with their usage, the
 * ones that ended with their reason, and, for owners, the editor that asks for a new one.
 */
export function MandatesCard({
  workspace,
  filter,
  editor,
}: {
  workspace: WorkspaceDetail;
  filter: MandateFilter;
  /** The wallet a new mandate pays from, and the agent when it is fixed; null offers none. */
  editor: { wallet: WalletDetail; agentId?: AgentId } | null;
}) {
  const now = useNow();
  const active = useMandates(workspace.id, filter, "active");
  const ended = useMandates(workspace.id, filter, "ended");
  const [editing, setEditing] = useState(false);
  const live = active.data?.pages.flatMap((page) => page.items) ?? [];
  const past = ended.data?.pages.flatMap((page) => page.items) ?? [];
  const canGrant = workspace.role === "owner" && editor !== null;

  return (
    <Card id="mandates">
      <CardHeader>
        <div className="min-w-0">
          <CardTitle>Approved in advance</CardTitle>
          <CardDescription>
            Payments an agent may make without asking anyone, within limits people approved once.
            Anyone who can approve can revoke one at any time.
          </CardDescription>
        </div>
        {canGrant && !editing ? (
          <Button
            variant="outline"
            size="sm"
            className={wrappingButton}
            onClick={() => setEditing(true)}
          >
            <CalendarClock aria-hidden />
            Approve in advance…
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-5">
        {editing && editor ? (
          <MandateEditor
            workspace={workspace}
            wallet={editor.wallet}
            agentId={editor.agentId}
            onCancel={() => setEditing(false)}
          />
        ) : null}
        {active.isPending ? <Loading /> : null}
        {active.isError ? (
          <ErrorState error={active.error} retry={() => void active.refetch()} />
        ) : null}
        {active.data && live.length === 0 ? (
          <EmptyState icon={<CalendarClock aria-hidden />} title="Nothing is approved in advance.">
            Every payment waits for a person's approval.
          </EmptyState>
        ) : null}
        {live.length > 0 ? <MandateList items={live} workspace={workspace} now={now} /> : null}
        {active.hasNextPage ? (
          <Button
            variant="outline"
            className="w-fit"
            onClick={() => void active.fetchNextPage()}
            disabled={active.isFetchingNextPage}
          >
            {active.isFetchingNextPage ? "Loading…" : "Show more"}
          </Button>
        ) : null}
        {ended.isError ? (
          <ErrorState error={ended.error} retry={() => void ended.refetch()} />
        ) : null}
        {past.length > 0 ? (
          <section className="grid grid-cols-1 gap-2" aria-labelledby={`${workspace.id}-ended`}>
            <h3 id={`${workspace.id}-ended`} className="text-sm font-semibold">
              Ended
            </h3>
            <MandateList items={past} workspace={workspace} now={now} />
            {ended.hasNextPage ? (
              <Button
                variant="outline"
                className="w-fit"
                onClick={() => void ended.fetchNextPage()}
                disabled={ended.isFetchingNextPage}
              >
                {ended.isFetchingNextPage ? "Loading…" : "Show older"}
              </Button>
            ) : null}
          </section>
        ) : null}
      </CardContent>
    </Card>
  );
}

// --- the editor ---------------------------------------------------------------------------------

interface AssetRow {
  chainId: string;
  asset: string;
  info: AssetInfo;
  label: string;
  maxPerTx: string;
  maxPerDay: string;
  maxPerAction: string;
  maxPerWindow: string;
  maxTotal: string;
}

interface EditorState {
  agentId: string;
  recipients: string;
  rows: AssetRow[];
  windowSeconds: number;
  maxUses: string;
  fee: string;
  end: EndChoiceId | "custom" | null;
  custom: string;
  purpose: string;
}

/**
 * Why the server refused a draft, in words: the reason it gives as `detail` for a draft the
 * wallet's limits or the signer's longest life refuse, the missing policy, a disabled agent.
 */
function refusalText(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "invalid_request" && error.detail)
      return explainMandateRefusal(error.detail);

    if (error.code === "policy_denied") return explainCode(error.detail ?? "policy_denied");

    if (error.code === "conflict") return explainMandateRefusal("agent_disabled");
  }

  return errorMessage(error);
}

/**
 * Asks for a new mandate on `wallet`: the agent, the recipients, each asset's three caps in whole
 * units, the window, the number of payments, the fee per payment (the wallet's fee ceiling to
 * start with), the end and a purpose. It shows the sentence and the worst case before submitting.
 * Submitting opens a request that people approve on the signer's page.
 */
export function MandateEditor({
  workspace,
  wallet,
  agentId,
  onCancel,
}: {
  workspace: WorkspaceDetail;
  wallet: WalletDetail;
  agentId?: AgentId;
  onCancel: () => void;
}) {
  const id = useId();
  const navigate = useNavigate();
  const policy = wallet.policy;

  // The server takes a mandate only for an active agent proposing from its own wallet or from a
  // treasury, and the signer only for one the wallet's limits name.
  const agents = workspace.agents.filter(
    (agent) =>
      agent.status === "active" &&
      (agentId === undefined || agent.id === agentId) &&
      (agent.walletId === wallet.id || wallet.kind === "treasury") &&
      (policy?.requesters.includes(agent.id) ?? false),
  );

  const [state, setState] = useState<EditorState>(() => ({
    agentId: agents.length === 1 ? (agents[0]?.id ?? "") : "",
    recipients: "",
    rows: (policy?.assets ?? []).map((limit) => {
      const info = assetInfo(limit.chainId, limit.asset, workspace.chains, wallet.balances);

      return {
        chainId: limit.chainId,
        asset: limit.asset,
        info,
        label: `${info.symbol} on ${chainName(limit.chainId, workspace.chains)}`,
        maxPerTx: limit.maxPerTx,
        maxPerDay: limit.maxPerDay,
        maxPerAction: "",
        maxPerWindow: "",
        maxTotal: "",
      };
    }),
    windowSeconds: 86_400,
    maxUses: "",
    fee: policy ? formatUnits(policy.fees.maxPerTxWei, NATIVE_DECIMALS).replaceAll(",", "") : "",
    end: null,
    custom: "",
    purpose: "",
  }));

  const [formError, setFormError] = useState<string | null>(null);
  const update = (patch: Partial<EditorState>) => setState((current) => ({ ...current, ...patch }));

  const updateRow = (index: number, patch: Partial<AssetRow>) =>
    update({ rows: state.rows.map((row, at) => (at === index ? { ...row, ...patch } : row)) });

  const submit = useMutation({
    mutationFn: (draft: MandateDraft) =>
      api.call("proposeMandate", {
        params: { workspaceId: workspace.id, walletId: wallet.id },
        body: draft,
      }),
    onSuccess: async (approval) => {
      await queryClient.invalidateQueries({ queryKey: keys.workspace(workspace.id) });
      await navigate({
        to: "/w/$workspaceId/approvals/$approvalId",
        params: { workspaceId: workspace.id, approvalId: approval.id },
      });
    },
  });

  if (!policy) {
    return (
      <Alert tone="warning">
        <TriangleAlert aria-hidden />
        <p>This wallet has no limits yet. An approval in advance needs them: set them first.</p>
      </Alert>
    );
  }

  if (agents.length === 0) {
    return (
      <Alert tone="warning">
        <TriangleAlert aria-hidden />
        <p>
          No active agent may pay from this wallet under its limits. Add the agent to the wallet's
          limits first.
        </p>
      </Alert>
    );
  }

  const nowDate = new Date();
  const nowSeconds = Math.floor(nowDate.getTime() / 1000);
  const choices = endChoices(nowDate);

  const notAfter =
    state.end === "custom"
      ? parseLocalDateTime(state.custom)
      : (choices.find((choice) => choice.id === state.end)?.notAfter ?? null);

  const form: MandateForm = {
    agentId: state.agentId,
    recipients: state.recipients,
    assets: state.rows.map((row) => ({
      chainId: row.chainId,
      asset: row.asset,
      decimals: row.info.decimals,
      label: row.label,
      maxPerAction: row.maxPerAction,
      maxPerWindow: row.maxPerWindow,
      maxTotal: row.maxTotal,
    })),
    windowSeconds: state.windowSeconds,
    maxUses: state.maxUses,
    feePerPayment: state.fee,
    notAfter,
    purpose: state.purpose,
  };

  let preview: MandateDraft | null = null;

  try {
    preview = mandateDraft(form, nowSeconds);
  } catch (error) {
    if (!(error instanceof MandateFormError)) throw error;
  }

  const previewInfos = preview
    ? mandateAssetInfos(preview, workspace.chains, [], wallet.balances)
    : [];

  const agentName = agents.find((agent) => agent.id === state.agentId)?.name ?? "the agent";
  const window = formatWindow(state.windowSeconds);

  const approvals =
    workspace.adminThreshold === 1
      ? "an approver approves"
      : `${workspace.adminThreshold} people approve`;

  return (
    <form
      aria-label="New approval in advance"
      className="grid grid-cols-1 gap-6 rounded-lg border p-4"
      onSubmit={(event) => {
        event.preventDefault();

        try {
          const draft = mandateDraft(form, Math.floor(Date.now() / 1000));
          setFormError(null);
          submit.mutate(draft);
        } catch (error) {
          if (!(error instanceof MandateFormError)) throw error;
          setFormError(error.message);
        }
      }}
    >
      <div className="grid grid-cols-1 gap-1">
        <h3 className="text-base font-semibold">New approval in advance</h3>
        <p className="text-sm text-muted-foreground">
          From {wallet.label}. It takes effect only when {approvals} it on the signer's page, as an
          admin change. The signer checks every payment against it and against the wallet's limits.
        </p>
      </div>

      <Labelled id={`${id}-agent`} label="Agent that may pay">
        <Select
          id={`${id}-agent`}
          value={state.agentId}
          onChange={(event) => update({ agentId: event.target.value })}
        >
          {agents.length > 1 ? <option value="">Choose an agent</option> : null}
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </Select>
      </Labelled>

      <Labelled id={`${id}-recipients`} label="Recipients, one address per line">
        <Textarea
          id={`${id}-recipients`}
          value={state.recipients}
          spellCheck={false}
          placeholder="0x…"
          onChange={(event) => update({ recipients: event.target.value })}
        />
        <p className="text-xs text-muted-foreground">
          It pays nobody else. Check each address with whoever gave it to you.
        </p>
      </Labelled>

      <Labelled id={`${id}-window`} label="Window for the middle limit">
        <Select
          id={`${id}-window`}
          value={String(state.windowSeconds)}
          onChange={(event) => update({ windowSeconds: Number(event.target.value) })}
        >
          {WINDOW_CHOICES.map((seconds) => (
            <option key={seconds} value={seconds}>
              Any {formatWindow(seconds)}
              {seconds === 86_400 ? ", as the wallet's limits" : ""}
            </option>
          ))}
        </Select>
      </Labelled>

      {state.rows.map((row, index) => (
        <fieldset
          key={`${row.chainId}|${row.asset}`}
          className="grid grid-cols-1 gap-3 rounded-md border p-3 sm:grid-cols-3"
        >
          <legend className="px-1 text-sm font-semibold wrap-anywhere">{row.label}</legend>
          <p className="text-xs text-muted-foreground wrap-anywhere sm:col-span-3">
            In {row.info.decimals === null ? "base units" : "whole units, such as 0.5"}. The
            wallet's limits: {formatAsset(row.maxPerTx, row.info)} per transaction,{" "}
            {formatAsset(row.maxPerDay, row.info)} per 24 hours. Leave all three empty to leave this
            asset out.
          </p>
          <Labelled id={`${id}-action-${index}`} label="Most per payment">
            <Input
              id={`${id}-action-${index}`}
              inputMode="decimal"
              value={row.maxPerAction}
              onChange={(event) => updateRow(index, { maxPerAction: event.target.value })}
            />
          </Labelled>
          <Labelled id={`${id}-window-${index}`} label={`Most in any ${window}`}>
            <Input
              id={`${id}-window-${index}`}
              inputMode="decimal"
              value={row.maxPerWindow}
              onChange={(event) => updateRow(index, { maxPerWindow: event.target.value })}
            />
          </Labelled>
          <Labelled id={`${id}-total-${index}`} label="Most in total">
            <Input
              id={`${id}-total-${index}`}
              inputMode="decimal"
              value={row.maxTotal}
              onChange={(event) => updateRow(index, { maxTotal: event.target.value })}
            />
          </Labelled>
        </fieldset>
      ))}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Labelled id={`${id}-uses`} label="Payments, at most">
          <Input
            id={`${id}-uses`}
            inputMode="numeric"
            value={state.maxUses}
            onChange={(event) => update({ maxUses: event.target.value })}
          />
        </Labelled>
        <Labelled
          id={`${id}-fee`}
          label={`Network fee per payment, at most (${feeUnit(policy.assets, workspace.chains).symbol})`}
        >
          <Input
            id={`${id}-fee`}
            inputMode="decimal"
            value={state.fee}
            onChange={(event) => update({ fee: event.target.value })}
          />
        </Labelled>
      </div>

      <fieldset className="grid grid-cols-1 gap-2">
        <legend className="mb-1 text-sm font-semibold">Ends</legend>
        {choices.map((choice) => (
          <Choice
            key={choice.id}
            name={`${id}-end`}
            label={choice.label}
            detail={formatEndTime(choice.notAfter)}
            checked={state.end === choice.id}
            onChange={() => update({ end: choice.id })}
          />
        ))}
        <Choice
          name={`${id}-end`}
          label="Another time"
          checked={state.end === "custom"}
          onChange={() =>
            update({
              end: "custom",
              custom: state.custom || localDateTimeValue(nowSeconds + 86_400),
            })
          }
        />
        {state.end === "custom" ? (
          <Labelled id={`${id}-custom`} label="Ends at, your time">
            <Input
              id={`${id}-custom`}
              type="datetime-local"
              value={state.custom}
              min={localDateTimeValue(nowSeconds)}
              onChange={(event) => update({ custom: event.target.value })}
            />
          </Labelled>
        ) : null}
      </fieldset>

      <Labelled id={`${id}-purpose`} label="Purpose, shown to everyone who approves">
        <Input
          id={`${id}-purpose`}
          value={state.purpose}
          maxLength={280}
          placeholder="Pay supplier invoices this week"
          onChange={(event) => update({ purpose: event.target.value })}
        />
      </Labelled>

      <section aria-label="What you ask for" className="grid grid-cols-1 gap-3">
        {preview ? (
          <>
            <MandateSentence terms={preview} agent={agentName} infos={previewInfos} />
            <MandateWorstCase terms={preview} infos={previewInfos} chains={workspace.chains} />
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            Fill in the form to see, before you submit, what it allows and the most that can leave
            this wallet under it.
          </p>
        )}
      </section>

      {formError ? (
        <p role="alert" className="text-sm text-danger">
          {formError}
        </p>
      ) : null}
      {submit.error ? (
        <p role="alert" className="flex items-start gap-1.5 text-sm text-danger">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span className="min-w-0">{refusalText(submit.error)}</span>
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" className={wrappingButton} disabled={submit.isPending}>
          {submit.isPending ? "Submitting…" : "Ask for approval"}
        </Button>
        <Button variant="outline" className={wrappingButton} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function Labelled({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 grid-cols-1 gap-1.5">
      <Label htmlFor={id} className="leading-snug">
        {label}
      </Label>
      {children}
    </div>
  );
}
