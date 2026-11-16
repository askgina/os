import {
  ApiError,
  type PolicyDraft,
  type WalletDetail,
  type WorkspaceDetail,
} from "@askgina/os-api";
import {
  Address,
  type AgentId,
  AssetRef,
  type ChainId,
  type HyperliquidRules,
  VENUE_NETWORK_NAMES,
  VenueNetwork,
} from "@askgina/os-protocol";
import { useMutation } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import {
  BadgeCheck,
  CandlestickChart,
  ChevronDown,
  ChevronRight,
  Clock,
  Gauge,
  Plus,
  Trash2,
  TriangleAlert,
  Users,
  Wallet as WalletIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import {
  CopyButton,
  EmptyState,
  ErrorState,
  FormError,
  FullAddress,
  Loading,
} from "@/components/common.tsx";
import {
  RetireWalletCard,
  WaitingRetirementNotice,
  WalletLifecycleNotice,
} from "@/components/lifecycle.tsx";
import { MandatesCard } from "@/components/mandate.tsx";
import { PolicyTable } from "@/components/policy.tsx";
import { Alert } from "@/components/ui/alert.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.tsx";
import { Input, Select, Textarea } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";
import { Progress } from "@/components/ui/progress.tsx";
import { VenueAccountCard } from "@/components/venue.tsx";
import { api, keys, queryClient, useMandates, useWallet, useWorkspace } from "@/lib/api.ts";
import { assetInfo, chainName, formatAsset, NATIVE_DECIMALS } from "@/lib/assets.ts";
import {
  checksumAddress,
  formatUnits,
  parseUnits,
  percentOf,
  shortAddress,
  UnitsError,
} from "@/lib/format.ts";
import { walletChangeable } from "@/lib/lifecycle.ts";
import { sweepDestinations } from "@/lib/sweep.ts";
import { cn } from "@/lib/utils.ts";
import {
  type MarketRow,
  newMarketRow,
  timeInForceText,
  toVenueRules,
  VENUE_LOSS_BOUND,
  VenueRulesError,
  type VenueRulesState,
  venueNetworkChoices,
  venueRulesState,
} from "@/lib/venue.ts";

export function WalletPage() {
  const { workspaceId, walletId } = useParams({ from: "/w/$workspaceId/wallets/$walletId" });
  const workspace = useWorkspace(workspaceId);
  const wallet = useWallet(workspaceId, walletId);

  if (wallet.isPending || !workspace.data) return <Loading />;

  if (wallet.isError)
    return <ErrorState error={wallet.error} retry={() => void wallet.refetch()} />;

  return <WalletView wallet={wallet.data} workspace={workspace.data} />;
}

/**
 * One wallet, laid out the way a person reads it: the card (what it holds, where to send funds),
 * the one thing to do next, today's spending, and a short list that leads to each part of the
 * wallet. Every section below stays on the page; the rarely used ones sit closed under "More".
 */
function WalletView({ wallet, workspace }: { wallet: WalletDetail; workspace: WorkspaceDetail }) {
  const agent = workspace.agents.find((item) => item.id === wallet.agentId) ?? null;
  const context = { chains: workspace.chains, agents: workspace.agents, balances: wallet.balances };
  const canAdmin = workspace.role === "owner";
  // A wallet of a workspace being deleted is retiring with it, so this also covers that.
  const active = wallet.lifecycle.state === "active";
  const changeable = walletChangeable(wallet.lifecycle) && workspace.lifecycle.state === "active";
  const canEdit = canAdmin && changeable;
  // A wallet with no limits yet opens straight onto the form that sets them.
  const [editing, setEditing] = useState(!wallet.policy);
  const more = useHashOpen(MORE_SECTIONS);

  const openEditor = () => {
    setEditing(true);
    requestAnimationFrame(() =>
      document.getElementById("policy")?.scrollIntoView({ block: "start" }),
    );
  };

  return (
    // Phones: one column, the card first. Large screens: the card, the next step, today's spending
    // and the list stay in a right column that follows the scroll; the sections fill the left.
    <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
      <div className="grid grid-cols-1 gap-4 lg:col-span-2 empty:hidden">
        <WalletLifecycleNotice wallet={wallet} workspace={workspace} />
        <WaitingRetirementNotice wallet={wallet} workspace={workspace} />
      </div>

      <aside className="grid grid-cols-1 gap-6 lg:sticky lg:top-6 lg:order-2">
        <WalletCard wallet={wallet} workspace={workspace} agentName={agent?.name ?? null} />

        <NextStep
          wallet={wallet}
          workspace={workspace}
          canEdit={canEdit}
          onSetLimits={openEditor}
        />

        {wallet.policy && wallet.policy.assets.length > 0 ? (
          <SpentToday wallet={wallet} workspace={workspace} />
        ) : null}

        <div>
          <SectionLabel>Spending</SectionLabel>
          <SettingsList>
            <SettingsRow
              href="#limits"
              tone="accent"
              icon={<Gauge aria-hidden />}
              label="Spending limit"
              value={limitSummary(wallet, workspace)}
            />
            <SettingsRow
              href="#mandates"
              tone="violet"
              icon={<BadgeCheck aria-hidden />}
              label="Approved in advance"
              value={<MandateCount workspace={workspace} walletId={wallet.id} />}
            />
            <SettingsRow
              href="#limits"
              tone="success"
              icon={<Users aria-hidden />}
              label="Who it can pay"
              value={recipientSummary(wallet)}
            />
            {wallet.venue ? (
              <SettingsRow
                href="#venue"
                tone="neutral"
                icon={<CandlestickChart aria-hidden />}
                label="Trading account"
                value={VENUE_NETWORK_NAMES[wallet.venue.network]}
              />
            ) : null}
          </SettingsList>
          <p className="mt-2 px-1 text-xs text-muted-foreground">
            Every payment waits for a person unless it is approved in advance. The signer enforces
            these limits, even if the agent or this server is compromised.
          </p>
        </div>
      </aside>

      <div className="grid min-w-0 grid-cols-1 gap-8 lg:order-1">
        <section id="limits" className="grid scroll-mt-6 grid-cols-1 gap-4">
          <SectionLabel>Limits</SectionLabel>
          {wallet.policy ? (
            <div className="rounded-2xl border bg-card px-5 py-4 shadow-sm">
              <div className="mb-3 flex items-center justify-between gap-3">
                <p className="text-xs text-muted-foreground">
                  Revision {wallet.policy.revision}. The signer enforces these.
                </p>
                {canEdit && !editing ? (
                  <Button size="sm" variant="outline" onClick={openEditor}>
                    Change
                  </Button>
                ) : null}
              </div>
              <PolicyTable policy={wallet.policy} context={context} />
            </div>
          ) : !editing ? (
            <p className="px-1 text-sm text-muted-foreground">
              No limits yet: this wallet can sign nothing until its first limits are set and
              approved.
            </p>
          ) : null}
          {canEdit && editing ? <PolicyEditor wallet={wallet} workspace={workspace} /> : null}
        </section>

        <section className="grid grid-cols-1 gap-4">
          <SectionLabel>Approved in advance</SectionLabel>
          <MandatesCard
            workspace={workspace}
            filter={{ walletId: wallet.id }}
            editor={active ? { wallet } : null}
          />
        </section>

        {wallet.venue ? (
          <section id="venue" className="grid scroll-mt-6 grid-cols-1 gap-4">
            <SectionLabel>Trading account</SectionLabel>
            <VenueAccountCard account={wallet.venue} />
          </section>
        ) : null}

        {canAdmin && (active || changeable) ? (
          <details
            className="group rounded-2xl border bg-card shadow-sm"
            open={more.open}
            onToggle={(event) => more.setOpen(event.currentTarget.open)}
          >
            <summary className="flex cursor-pointer list-none items-center justify-between px-5 py-4 text-sm font-medium select-none">
              More
              <span className="text-xs text-muted-foreground">
                Empty this wallet{changeable ? ", retire it" : ""}
                <ChevronDown
                  className="ml-2 inline size-4 transition-transform group-open:rotate-180"
                  aria-hidden
                />
              </span>
            </summary>
            <div className="grid grid-cols-1 gap-6 border-t p-5">
              {active ? <SweepCard wallet={wallet} workspace={workspace} /> : null}
              {changeable ? <RetireWalletCard wallet={wallet} workspace={workspace} /> : null}
            </div>
          </details>
        ) : null}
      </div>
    </div>
  );
}

/** The sections under "More"; links elsewhere (`#sweep`) open it. */
const MORE_SECTIONS = ["sweep", "retire"] as const;

/** Open state for a closed section that a link like `#sweep` points into. */
function useHashOpen(ids: readonly string[]) {
  const [open, setOpen] = useState(() => ids.includes(window.location.hash.slice(1)));

  useEffect(() => {
    const follow = () => {
      const target = window.location.hash.slice(1);

      if (!ids.includes(target)) return;
      setOpen(true);
      requestAnimationFrame(() => document.getElementById(target)?.scrollIntoView());
    };

    follow();
    window.addEventListener("hashchange", follow);

    return () => window.removeEventListener("hashchange", follow);
  }, [ids]);

  return { open, setOpen };
}

/** The wallet as a card: whose it is, what it holds, and the address to fund it. */
function WalletCard({
  wallet,
  workspace,
  agentName,
}: {
  wallet: WalletDetail;
  workspace: WorkspaceDetail;
  agentName: string | null;
}) {
  const [first, ...others] = wallet.balances;
  const gone = wallet.lifecycle.state === "retiring" || wallet.lifecycle.state === "destroyed";

  return (
    <div>
      <div className="relative flex min-h-44 flex-col overflow-hidden rounded-2xl bg-[radial-gradient(120%_140%_at_100%_0%,oklch(0.42_0.07_255)_0%,transparent_55%),linear-gradient(135deg,oklch(0.32_0.04_265),oklch(0.24_0.03_280))] p-6 text-[oklch(0.97_0.01_270)] shadow-lg">
        <div className="flex min-w-0 items-start gap-2 text-sm font-semibold">
          <WalletIcon className="mt-0.5 size-4 shrink-0 opacity-80" aria-hidden />
          <div className="min-w-0">
            <h1 className="truncate">{wallet.label}</h1>
            {agentName && wallet.agentId ? (
              <Link
                to="/w/$workspaceId/agents/$agentId"
                params={{ workspaceId: workspace.id, agentId: wallet.agentId }}
                className="block truncate text-xs font-medium opacity-75 hover:underline hover:opacity-100"
              >
                Agent {agentName}
              </Link>
            ) : (
              <p className="text-xs font-medium opacity-75">Treasury</p>
            )}
          </div>
        </div>
        <div className="mt-auto pt-6">
          <p className="text-4xl font-semibold tracking-tight tabular-nums">
            {first ? formatUnits(first.amount, first.decimals) : "0"}
            <span className="ml-1.5 text-xl font-medium opacity-75">
              {first ? first.symbol : ""}
            </span>
          </p>
          {first ? (
            <p className="mt-0.5 text-xs opacity-70">
              {chainName(first.chainId, workspace.chains)}
              {others.length > 0
                ? ` · ${others
                    .map(
                      (balance) =>
                        `${formatUnits(balance.amount, balance.decimals)} ${balance.symbol}`,
                    )
                    .join(" · ")}`
                : ""}
            </p>
          ) : (
            <p className="mt-0.5 text-xs opacity-70">No balances yet</p>
          )}
        </div>
        <div className="mt-4 flex items-center justify-between gap-3">
          <span className="font-mono text-xs opacity-80" title={checksumAddress(wallet.address)}>
            {shortAddress(wallet.address)}
          </span>
          <CopyButton
            value={checksumAddress(wallet.address)}
            label="Copy wallet address"
            className="border-white/25 bg-white/10 text-white hover:bg-white/20"
          />
        </div>
      </div>
      <details className="mt-2 px-1 text-xs text-muted-foreground">
        <summary className="cursor-pointer select-none">
          {gone
            ? "Do not send anything here: this wallet's key is destroyed or soon will be."
            : "Send funds to this address to let the wallet pay. Show the full address"}
        </summary>
        <FullAddress address={wallet.address} className="mt-2 text-sm text-foreground" />
        <p className="mt-1">Check every group before sending.</p>
      </details>
    </div>
  );
}

/** The single most useful thing to do now, if there is one. */
function NextStep({
  wallet,
  workspace,
  canEdit,
  onSetLimits,
}: {
  wallet: WalletDetail;
  workspace: WorkspaceDetail;
  canEdit: boolean;
  onSetLimits: () => void;
}) {
  if (wallet.pendingPolicyApprovalId) {
    return (
      <Callout
        tone="warning"
        icon={<Clock aria-hidden />}
        title="A change to these limits is waiting for approval"
        body="It takes effect once it is approved with a passkey."
        action={
          <Link
            to="/w/$workspaceId/approvals/$approvalId"
            params={{ workspaceId: workspace.id, approvalId: wallet.pendingPolicyApprovalId }}
            className={cn(buttonVariants({ size: "sm" }))}
          >
            Open it
          </Link>
        }
      />
    );
  }

  if (!wallet.policy && wallet.lifecycle.state === "active") {
    return (
      <Callout
        tone="accent"
        icon={<Gauge aria-hidden />}
        title={`${wallet.label} can't pay yet`}
        body={
          canEdit
            ? "Choose how much it may spend. You approve that once, with your passkey."
            : "An owner needs to set its limits first."
        }
        action={
          canEdit ? (
            <Button size="sm" onClick={onSetLimits}>
              Set limits
            </Button>
          ) : null
        }
      />
    );
  }

  return null;
}

function Callout({
  tone,
  icon,
  title,
  body,
  action,
}: {
  tone: "accent" | "warning";
  icon: ReactNode;
  title: string;
  body: string;
  action: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-4 rounded-2xl border px-5 py-4 shadow-sm",
        tone === "warning" ? "border-warning/40 bg-warning-soft" : "bg-card",
      )}
    >
      <span
        className={cn(
          "grid size-9 shrink-0 place-items-center rounded-lg [&_svg]:size-4",
          tone === "warning" ? "bg-warning/15 text-warning" : "bg-accent-soft text-accent",
        )}
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">{title}</p>
        <p className="text-sm text-muted-foreground">{body}</p>
      </div>
      {action}
    </div>
  );
}

/** What is left of each daily limit, as it stands now. */
function SpentToday({ wallet, workspace }: { wallet: WalletDetail; workspace: WorkspaceDetail }) {
  return (
    <div className="grid grid-cols-1 gap-4 rounded-2xl border bg-card px-5 py-4 shadow-sm">
      {wallet.policy?.assets.map((limit) => {
        const info = assetInfo(limit.chainId, limit.asset, workspace.chains, wallet.balances);

        const spent =
          wallet.spent.find((item) => item.chainId === limit.chainId && item.asset === limit.asset)
            ?.amount ?? "0";

        const left =
          BigInt(limit.maxPerDay) > BigInt(spent) ? BigInt(limit.maxPerDay) - BigInt(spent) : 0n;

        const share = percentOf(spent, limit.maxPerDay);

        return (
          <div key={`${limit.chainId}|${limit.asset}`} className="grid grid-cols-1 gap-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-sm text-muted-foreground">Left to spend, last 24 hours</span>
              <span className="text-xs text-muted-foreground">
                At most {formatAsset(limit.maxPerTx, info)} per payment
              </span>
            </div>
            <p className="text-2xl font-semibold tracking-tight tabular-nums">
              {formatAsset(left.toString(), info)}
              <span className="ml-1.5 text-sm font-medium text-muted-foreground">
                of {formatAsset(limit.maxPerDay, info)}
              </span>
            </p>
            <Progress
              value={share}
              label={`${info.symbol} spent of the 24-hour limit`}
              tone={share >= 90 ? "danger" : share >= 70 ? "warning" : "accent"}
            />
            <p className="text-xs text-muted-foreground">
              {info.symbol} spent in the last 24 hours: {formatAsset(spent, info)}
            </p>
          </div>
        );
      })}
    </div>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <h2 className="mb-2 px-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
      {children}
    </h2>
  );
}

function SettingsList({ children }: { children: ReactNode }) {
  return (
    <div className="divide-y overflow-hidden rounded-2xl border bg-card shadow-sm [&>*]:border-border">
      {children}
    </div>
  );
}

const ROW_TONES = {
  accent: "bg-accent",
  violet: "bg-[oklch(0.6_0.13_300)]",
  success: "bg-success",
  neutral: "bg-muted-foreground",
} as const;

function SettingsRow({
  href,
  tone,
  icon,
  label,
  value,
}: {
  href: string;
  tone: keyof typeof ROW_TONES;
  icon: ReactNode;
  label: string;
  value: ReactNode;
}) {
  return (
    <a href={href} className="flex items-center gap-3 px-5 py-3.5 text-sm hover:bg-muted">
      <span
        className={cn(
          "grid size-7 shrink-0 place-items-center rounded-md text-white [&_svg]:size-4",
          ROW_TONES[tone],
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block">{label}</span>
        <span className="block truncate text-xs text-muted-foreground">{value}</span>
      </span>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
    </a>
  );
}

function limitSummary(wallet: WalletDetail, workspace: WorkspaceDetail): string {
  const [limit, ...rest] = wallet.policy?.assets ?? [];

  if (!limit) return "Not set";
  const info = assetInfo(limit.chainId, limit.asset, workspace.chains, wallet.balances);
  const summary = `${formatAsset(limit.maxPerTx, info)} each, ${formatAsset(limit.maxPerDay, info)} a day`;

  return rest.length > 0 ? `${summary}, +${rest.length} more` : summary;
}

function recipientSummary(wallet: WalletDetail): string {
  const recipients = wallet.policy?.recipients;

  if (!recipients) return "Not set";

  return recipients.mode === "any"
    ? "Anyone you approve"
    : `${recipients.addresses.length} listed ${recipients.addresses.length === 1 ? "address" : "addresses"}`;
}

/** How many mandates of this wallet are live; the same list the section below shows. */
function MandateCount({
  workspace,
  walletId,
}: {
  workspace: WorkspaceDetail;
  walletId: WalletDetail["id"];
}) {
  const live = useMandates(workspace.id, { walletId }, "active");
  const count = live.data?.pages.reduce((total, page) => total + page.items.length, 0);

  if (count === undefined) return "…";
  const more = live.hasNextPage ? "+" : "";

  return count === 0 ? "None" : `${count}${more} live`;
}

/**
 * Empty one asset of the wallet without an agent: the way out for a wallet whose agent was
 * removed, and for a paused workspace. Only destinations the signer accepts are offered.
 */
function SweepCard({ wallet, workspace }: { wallet: WalletDetail; workspace: WorkspaceDetail }) {
  const navigate = useNavigate();
  const id = useId();
  const destinations = sweepDestinations(wallet, workspace);
  const held = wallet.balances.filter((balance) => balance.amount !== "0");

  const [assetKey, setAssetKey] = useState(() =>
    held[0] ? `${held[0].chainId}|${held[0].asset}` : "",
  );

  const [to, setTo] = useState(() => destinations[0]?.address ?? "");

  const submit = useMutation({
    mutationFn: () => {
      const balance = held.find((item) => `${item.chainId}|${item.asset}` === assetKey);
      const destination = destinations.find((item) => item.address === to);

      if (!balance || !destination) throw new Error("Choose an asset and a destination.");

      return api.call("requestSweep", {
        params: { workspaceId: workspace.id, walletId: wallet.id },
        body: { chainId: balance.chainId, asset: balance.asset, to: destination.address },
      });
    },
    onSuccess: async (approval) => {
      await queryClient.invalidateQueries({ queryKey: keys.workspace(workspace.id) });
      await navigate({
        to: "/w/$workspaceId/approvals/$approvalId",
        params: { workspaceId: workspace.id, approvalId: approval.id },
      });
    },
  });

  const approvals =
    workspace.adminThreshold === 1 ? "1 approval" : `${workspace.adminThreshold} approvals`;

  return (
    <Card id="sweep">
      <CardHeader>
        <div>
          <CardTitle>Empty this wallet</CardTitle>
          <CardDescription>
            Move all of one asset to the treasury or to an address its limits already allow. No
            agent is involved and the limits above do not apply, so it needs {approvals}, as an
            admin change does. Works while the workspace is paused.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        {destinations.length === 0 ? (
          <EmptyState title="Nowhere to send it yet">
            Create a treasury, or set limits that allow only listed recipients, first. The signer
            sends a sweep nowhere else.
          </EmptyState>
        ) : held.length === 0 ? (
          <p className="text-sm text-muted-foreground">This wallet holds nothing to move.</p>
        ) : (
          <form
            className="grid grid-cols-1 gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              submit.mutate();
            }}
          >
            <Labelled id={`${id}-asset`} label="Asset">
              <Select
                id={`${id}-asset`}
                value={assetKey}
                onChange={(event) => setAssetKey(event.target.value)}
              >
                {held.map((balance) => (
                  <option
                    key={`${balance.chainId}|${balance.asset}`}
                    value={`${balance.chainId}|${balance.asset}`}
                  >
                    {formatUnits(balance.amount, balance.decimals)} {balance.symbol} on{" "}
                    {chainName(balance.chainId, workspace.chains)}
                  </option>
                ))}
              </Select>
            </Labelled>
            <Labelled id={`${id}-to`} label="Send it to">
              <Select id={`${id}-to`} value={to} onChange={(event) => setTo(event.target.value)}>
                {destinations.map((destination) => (
                  <option key={destination.address} value={destination.address}>
                    {destination.label} · {shortAddress(destination.address)}
                  </option>
                ))}
              </Select>
            </Labelled>
            <p className="text-xs text-muted-foreground">
              The server reads the balance now and fixes the amount in the request: all of a token,
              or the network coin less the most the network fee can be. Whatever arrives later
              stays.
            </p>
            <FormError error={submit.error} />
            <div>
              <Button type="submit" disabled={submit.isPending}>
                {submit.isPending ? "Submitting…" : "Ask for approval"}
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

interface AssetRow {
  key: number;
  chainId: string;
  /** "native" or a token contract address as typed. */
  asset: string;
  decimals: string;
  maxPerTx: string;
  maxPerDay: string;
}

interface EditorState {
  chains: ChainId[];
  requesters: AgentId[];
  assets: AssetRow[];
  recipientsMode: "any" | "allowlist";
  recipients: string;
  callsMode: "deny" | "allowlist";
  targets: string;
  feeCeiling: string;
  threshold: string;
  ttlMinutes: string;
  venue: VenueRulesState;
}

let nextRowKey = 1;

function initialState(wallet: WalletDetail, workspace: WorkspaceDetail): EditorState {
  const policy = wallet.policy;
  const firstChain = workspace.chains[0]?.chainId ?? "";

  if (!policy) {
    return {
      chains: firstChain ? [firstChain] : [],
      requesters: wallet.agentId ? [wallet.agentId] : [],
      assets: [
        {
          key: nextRowKey++,
          chainId: firstChain,
          asset: "native",
          decimals: "18",
          maxPerTx: "",
          maxPerDay: "",
        },
      ],
      recipientsMode: "any",
      recipients: "",
      callsMode: "deny",
      targets: "",
      feeCeiling: "0.01",
      threshold: "1",
      ttlMinutes: "15",
      venue: venueRulesState(undefined, workspace.venueNetworks),
    };
  }

  return {
    chains: [...policy.chains],
    requesters: [...policy.requesters],
    assets: policy.assets.map((limit) => {
      const decimals =
        assetInfo(limit.chainId, limit.asset, workspace.chains, wallet.balances).decimals ?? 0;

      return {
        key: nextRowKey++,
        chainId: limit.chainId,
        asset: limit.asset,
        decimals: String(decimals),
        maxPerTx: formatUnits(limit.maxPerTx, decimals).replaceAll(",", ""),
        maxPerDay: formatUnits(limit.maxPerDay, decimals).replaceAll(",", ""),
      };
    }),
    recipientsMode: policy.recipients.mode,
    recipients:
      policy.recipients.mode === "allowlist" ? policy.recipients.addresses.join("\n") : "",
    callsMode: policy.contractCalls.mode,
    targets:
      policy.contractCalls.mode === "allowlist" ? policy.contractCalls.targets.join("\n") : "",
    feeCeiling: formatUnits(policy.fees.maxPerTxWei, NATIVE_DECIMALS).replaceAll(",", ""),
    threshold: String(policy.approvals.threshold),
    ttlMinutes: String(Math.round(policy.approvals.ttlSeconds / 60)),
    venue: venueRulesState(policy.venues?.hyperliquid, workspace.venueNetworks),
  };
}

class DraftError extends Error {
  override readonly name = "DraftError";
}

function parseAddresses(text: string, what: string): `0x${string}`[] {
  const lines = text.split(/[\s,]+/).filter((line) => line !== "");

  return lines.map((line) => {
    const address = Address.safeParse(line.toLowerCase());

    if (!address.success) throw new DraftError(`${what}: "${line}" is not an address.`);

    return address.data;
  });
}

function toDraft(state: EditorState): PolicyDraft {
  if (state.chains.length === 0) throw new DraftError("Choose at least one network.");

  const assets = state.assets.map((row, index) => {
    const label = `Asset ${index + 1}`;
    const asset = AssetRef.safeParse(row.asset.trim().toLowerCase());

    if (!asset.success) {
      throw new DraftError(`${label}: enter "native" or a token contract address.`);
    }

    const decimals = Number(row.decimals);

    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
      throw new DraftError(`${label}: decimals must be a whole number from 0 to 36.`);
    }

    try {
      const maxPerTx = parseUnits(row.maxPerTx, decimals);
      const maxPerDay = parseUnits(row.maxPerDay, decimals);

      if (maxPerTx === 0n || maxPerDay === 0n)
        throw new DraftError(`${label}: limits must be above zero.`);

      if (maxPerTx > maxPerDay) {
        throw new DraftError(
          `${label}: the per-transaction limit cannot exceed the 24-hour limit.`,
        );
      }

      const chainId = state.chains.find((chain) => chain === row.chainId);

      if (chainId === undefined) {
        throw new DraftError(`${label}: its network is not one of the wallet's networks.`);
      }

      return {
        chainId,
        asset: asset.data,
        maxPerTx: maxPerTx.toString(),
        maxPerDay: maxPerDay.toString(),
      };
    } catch (error) {
      if (error instanceof UnitsError) throw new DraftError(`${label}: ${error.message}`);
      throw error;
    }
  });

  let fee: bigint;

  try {
    fee = parseUnits(state.feeCeiling, NATIVE_DECIMALS);
  } catch (error) {
    if (error instanceof UnitsError) throw new DraftError(`Network fee ceiling: ${error.message}`);
    throw error;
  }

  if (fee === 0n) throw new DraftError("Network fee ceiling must be above zero.");
  const threshold = Number(state.threshold);
  const ttlSeconds = Number(state.ttlMinutes) * 60;

  if (!Number.isInteger(threshold) || threshold < 1 || threshold > 16) {
    throw new DraftError("Approvals needed must be from 1 to 16.");
  }

  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 86_400) {
    throw new DraftError("An approval can stay valid from 1 to 1440 minutes.");
  }

  let hyperliquid: HyperliquidRules | undefined;

  try {
    hyperliquid = toVenueRules(state.venue);
  } catch (error) {
    if (error instanceof VenueRulesError) throw new DraftError(error.message);
    throw error;
  }

  const draft: PolicyDraft = {
    chains: state.chains,
    requesters: state.requesters,
    assets,
    recipients:
      state.recipientsMode === "any"
        ? { mode: "any" }
        : { mode: "allowlist", addresses: parseAddresses(state.recipients, "Recipients") },
    contractCalls:
      state.callsMode === "deny"
        ? { mode: "deny" }
        : { mode: "allowlist", targets: parseAddresses(state.targets, "Contracts") },
    fees: { maxPerTxWei: fee.toString() },
    approvals: { threshold, ttlSeconds },
  };

  if (hyperliquid) draft.venues = { hyperliquid };

  return draft;
}

function PolicyEditor({ wallet, workspace }: { wallet: WalletDetail; workspace: WorkspaceDetail }) {
  const navigate = useNavigate();
  const id = useId();
  const [state, setState] = useState(() => initialState(wallet, workspace));
  const [draftError, setDraftError] = useState<string | null>(null);
  const update = (patch: Partial<EditorState>) => setState((current) => ({ ...current, ...patch }));

  const updateRow = (key: number, patch: Partial<AssetRow>) =>
    update({ assets: state.assets.map((row) => (row.key === key ? { ...row, ...patch } : row)) });

  const toggle = <Item extends string>(list: Item[], value: Item) =>
    list.includes(value) ? list.filter((item) => item !== value) : [...list, value];

  const submit = useMutation({
    mutationFn: (draft: PolicyDraft) =>
      api.call("requestPolicy", {
        params: { workspaceId: workspace.id, walletId: wallet.id },
        body: { draft },
      }),
    onSuccess: async (approval) => {
      await queryClient.invalidateQueries({ queryKey: keys.wallet(workspace.id, wallet.id) });
      await queryClient.invalidateQueries({ queryKey: keys.workspace(workspace.id) });
      await navigate({
        to: "/w/$workspaceId/approvals/$approvalId",
        params: { workspaceId: workspace.id, approvalId: approval.id },
      });
    },
  });

  // The server refuses a payment threshold above the admin threshold with `invalid_request`;
  // its message belongs next to the field that caused it, not at the bottom of a long form.
  const thresholdRefused =
    submit.error instanceof ApiError &&
    submit.error.code === "invalid_request" &&
    Number(state.threshold) > workspace.adminThreshold;

  return (
    <Card id="policy">
      <CardHeader>
        <div>
          <CardTitle>{wallet.policy ? "Change limits" : "Set this wallet's limits"}</CardTitle>
          <CardDescription>
            Submitting creates a request. The limits change only when{" "}
            {workspace.adminThreshold === 1
              ? "an approver approves"
              : `${workspace.adminThreshold} people approve`}{" "}
            it with their passkey.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        <form
          className="grid grid-cols-1 gap-7"
          onSubmit={(event) => {
            event.preventDefault();

            try {
              const draft = toDraft(state);
              setDraftError(null);
              submit.mutate(draft);
            } catch (error) {
              if (!(error instanceof DraftError)) throw error;
              setDraftError(error.message);
            }
          }}
        >
          <Group legend="Networks" hint="The wallet can act only on these.">
            {workspace.chains.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                This server has no networks configured.
              </p>
            ) : null}
            {workspace.chains.map((chain) => (
              <Check
                key={chain.chainId}
                label={chain.name}
                checked={state.chains.includes(chain.chainId)}
                onChange={() => update({ chains: toggle(state.chains, chain.chainId) })}
              />
            ))}
          </Group>

          <Group
            legend="Agents that may use it"
            hint="Only these agents can propose payments from this wallet."
          >
            {workspace.agents.length === 0 ? (
              <p className="text-sm text-muted-foreground">There are no agents yet.</p>
            ) : null}
            {workspace.agents.map((agent) => (
              <Check
                key={agent.id}
                label={agent.name}
                checked={state.requesters.includes(agent.id)}
                onChange={() => update({ requesters: toggle(state.requesters, agent.id) })}
              />
            ))}
          </Group>

          <Group
            legend="Assets and limits"
            hint="Amounts in whole units, such as 0.5. An asset with no row cannot leave the wallet."
          >
            {state.assets.map((row, index) => {
              const native = row.asset.trim().toLowerCase() === "native";

              const symbol = native
                ? (workspace.chains.find((chain) => chain.chainId === row.chainId)?.nativeSymbol ??
                  "")
                : "";

              return (
                <div
                  key={row.key}
                  className="grid grid-cols-1 gap-3 rounded-md border p-3 sm:grid-cols-2"
                >
                  <div className="flex items-center justify-between sm:col-span-2">
                    <p className="text-sm font-medium">Asset {index + 1}</p>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        update({ assets: state.assets.filter((item) => item.key !== row.key) })
                      }
                      aria-label={`Remove asset ${index + 1}`}
                    >
                      <Trash2 aria-hidden />
                      Remove
                    </Button>
                  </div>
                  <Labelled id={`${id}-chain-${row.key}`} label="Network">
                    <Select
                      id={`${id}-chain-${row.key}`}
                      value={row.chainId}
                      onChange={(event) => updateRow(row.key, { chainId: event.target.value })}
                    >
                      {workspace.chains.map((chain) => (
                        <option key={chain.chainId} value={chain.chainId}>
                          {chain.name}
                        </option>
                      ))}
                    </Select>
                  </Labelled>
                  <Labelled
                    id={`${id}-asset-${row.key}`}
                    label="Asset: native, or a token contract"
                  >
                    <Input
                      id={`${id}-asset-${row.key}`}
                      value={row.asset}
                      className="font-mono"
                      spellCheck={false}
                      onChange={(event) => {
                        const asset = event.target.value;

                        const known = assetInfo(
                          row.chainId,
                          asset.trim().toLowerCase(),
                          workspace.chains,
                          wallet.balances,
                        );

                        const patch: Partial<AssetRow> = { asset };

                        if (known.decimals !== null) patch.decimals = String(known.decimals);

                        updateRow(row.key, patch);
                      }}
                    />
                  </Labelled>
                  {native ? null : (
                    <Labelled id={`${id}-decimals-${row.key}`} label="Token decimals">
                      <Input
                        id={`${id}-decimals-${row.key}`}
                        inputMode="numeric"
                        value={row.decimals}
                        onChange={(event) => updateRow(row.key, { decimals: event.target.value })}
                      />
                    </Labelled>
                  )}
                  <Labelled
                    id={`${id}-tx-${row.key}`}
                    label={`Most per transaction ${symbol}`.trim()}
                  >
                    <Input
                      id={`${id}-tx-${row.key}`}
                      inputMode="decimal"
                      placeholder="0.05"
                      value={row.maxPerTx}
                      onChange={(event) => updateRow(row.key, { maxPerTx: event.target.value })}
                    />
                  </Labelled>
                  <Labelled
                    id={`${id}-day-${row.key}`}
                    label={`Most per 24 hours ${symbol}`.trim()}
                  >
                    <Input
                      id={`${id}-day-${row.key}`}
                      inputMode="decimal"
                      placeholder="0.2"
                      value={row.maxPerDay}
                      onChange={(event) => updateRow(row.key, { maxPerDay: event.target.value })}
                    />
                  </Labelled>
                </div>
              );
            })}
            <Button
              variant="outline"
              size="sm"
              className="w-fit"
              onClick={() =>
                update({
                  assets: [
                    ...state.assets,
                    {
                      key: nextRowKey++,
                      chainId: state.chains[0] ?? workspace.chains[0]?.chainId ?? "",
                      asset: "native",
                      decimals: "18",
                      maxPerTx: "",
                      maxPerDay: "",
                    },
                  ],
                })
              }
            >
              <Plus aria-hidden />
              Add an asset
            </Button>
          </Group>

          <Group legend="Recipients">
            <Radio
              name={`${id}-rcpt`}
              label="Anyone"
              checked={state.recipientsMode === "any"}
              onChange={() => update({ recipientsMode: "any" })}
            />
            <Radio
              name={`${id}-rcpt`}
              label="Only these addresses"
              checked={state.recipientsMode === "allowlist"}
              onChange={() => update({ recipientsMode: "allowlist" })}
            />
            {state.recipientsMode === "allowlist" ? (
              <Labelled id={`${id}-recipients`} label="Allowed recipients, one per line">
                <Textarea
                  id={`${id}-recipients`}
                  value={state.recipients}
                  spellCheck={false}
                  onChange={(event) => update({ recipients: event.target.value })}
                />
              </Labelled>
            ) : null}
          </Group>

          <Group
            legend="Contract calls"
            hint="A contract call can do things the limits above cannot measure."
          >
            <Radio
              name={`${id}-calls`}
              label="Not allowed"
              checked={state.callsMode === "deny"}
              onChange={() => update({ callsMode: "deny" })}
            />
            <Radio
              name={`${id}-calls`}
              label="Only to these contracts"
              checked={state.callsMode === "allowlist"}
              onChange={() => update({ callsMode: "allowlist" })}
            />
            {state.callsMode === "allowlist" ? (
              <Labelled id={`${id}-targets`} label="Allowed contracts, one per line">
                <Textarea
                  id={`${id}-targets`}
                  value={state.targets}
                  spellCheck={false}
                  onChange={(event) => update({ targets: event.target.value })}
                />
              </Labelled>
            ) : null}
          </Group>

          <VenueRulesFields
            configured={workspace.venueNetworks}
            state={state.venue}
            onChange={(patch) => update({ venue: { ...state.venue, ...patch } })}
          />

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Labelled id={`${id}-fee`} label="Network fee ceiling per transaction (native coin)">
              <Input
                id={`${id}-fee`}
                inputMode="decimal"
                value={state.feeCeiling}
                onChange={(event) => update({ feeCeiling: event.target.value })}
              />
            </Labelled>
            <Labelled id={`${id}-threshold`} label="Approvals needed per payment">
              <Input
                id={`${id}-threshold`}
                type="number"
                min={1}
                max={16}
                value={state.threshold}
                aria-describedby={`${id}-threshold-rule`}
                onChange={(event) => update({ threshold: event.target.value })}
              />
              <p id={`${id}-threshold-rule`} className="text-xs text-muted-foreground">
                At most {workspace.adminThreshold}, the number needed for admin changes. Otherwise
                whoever can change the limits could simply lower this number again.
              </p>
              {thresholdRefused ? <FormError error={submit.error} /> : null}
            </Labelled>
            <Labelled id={`${id}-ttl`} label="A request stays open for (minutes)">
              <Input
                id={`${id}-ttl`}
                type="number"
                min={1}
                max={1440}
                value={state.ttlMinutes}
                onChange={(event) => update({ ttlMinutes: event.target.value })}
              />
            </Labelled>
          </div>

          {draftError ? (
            <p role="alert" className="text-sm text-danger">
              {draftError}
            </p>
          ) : null}
          {thresholdRefused ? null : <FormError error={submit.error} />}
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={submit.isPending}>
              {submit.isPending ? "Submitting…" : "Submit for approval"}
            </Button>
            {wallet.policy === null ? (
              <Badge tone="warning">The wallet signs nothing until this is approved</Badge>
            ) : null}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/**
 * What the wallet may do on Hyperliquid: on which network, which perpetuals, each with its own
 * cap per order, a cap per 24 hours, which times in force, how long a signed order stays valid,
 * and withdrawals. Off by default, and offered only on the networks this server has set up
 * (`configured`); the caps are said up front to limit new orders, never losses.
 */
function VenueRulesFields({
  configured,
  state,
  onChange,
}: {
  configured: readonly VenueNetwork[];
  state: VenueRulesState;
  onChange: (patch: Partial<VenueRulesState>) => void;
}) {
  const id = useId();

  const updateMarket = (key: number, patch: Partial<MarketRow>) =>
    onChange({
      markets: state.markets.map((row) => (row.key === key ? { ...row, ...patch } : row)),
    });

  const choices = venueNetworkChoices(configured, state);

  if (choices.length === 0) {
    return <Group legend="Hyperliquid" hint="This server is not set up for Hyperliquid." />;
  }

  const mainnet = state.network === "hyperliquid:mainnet";

  return (
    <Group
      legend="Hyperliquid"
      hint="Limit orders on Hyperliquid perpetuals. Every order still needs approval with a passkey."
    >
      <Check
        label={`Allow orders on ${VENUE_NETWORK_NAMES[state.network]}`}
        checked={state.enabled}
        onChange={() => onChange({ enabled: !state.enabled })}
      />
      {state.enabled ? (
        <>
          {choices.length > 1 ? (
            <Labelled id={`${id}-network`} label="Hyperliquid network">
              <Select
                id={`${id}-network`}
                value={state.network}
                aria-describedby={mainnet ? `${id}-network-funds` : undefined}
                onChange={(event) => onChange({ network: VenueNetwork.parse(event.target.value) })}
              >
                {choices.map((network) => (
                  <option key={network} value={network}>
                    {VENUE_NETWORK_NAMES[network]}
                  </option>
                ))}
              </Select>
              {mainnet ? (
                <p id={`${id}-network-funds`} className="text-sm font-medium">
                  Mainnet orders use real funds.
                </p>
              ) : null}
            </Labelled>
          ) : mainnet ? (
            <p className="text-sm font-medium">Mainnet orders use real funds.</p>
          ) : null}
          <Alert tone="warning">
            <TriangleAlert aria-hidden />
            <p>{VENUE_LOSS_BOUND}</p>
          </Alert>
          {state.markets.map((row, index) => (
            <div
              key={row.key}
              className="grid grid-cols-1 gap-3 rounded-md border p-3 sm:grid-cols-3"
            >
              <div className="flex items-center justify-between sm:col-span-3">
                <p className="text-sm font-medium">Market {index + 1}</p>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    onChange({ markets: state.markets.filter((item) => item.key !== row.key) })
                  }
                  aria-label={`Remove market ${index + 1}`}
                >
                  <Trash2 aria-hidden />
                  Remove
                </Button>
              </div>
              <Labelled id={`${id}-coin-${row.key}`} label="Coin, as Hyperliquid names it">
                <Input
                  id={`${id}-coin-${row.key}`}
                  value={row.coin}
                  placeholder="BTC"
                  autoCapitalize="characters"
                  spellCheck={false}
                  onChange={(event) => updateMarket(row.key, { coin: event.target.value })}
                />
              </Labelled>
              <Labelled id={`${id}-index-${row.key}`} label="Market index at Hyperliquid">
                <Input
                  id={`${id}-index-${row.key}`}
                  inputMode="numeric"
                  value={row.asset}
                  placeholder="0"
                  onChange={(event) => updateMarket(row.key, { asset: event.target.value })}
                />
              </Labelled>
              <Labelled id={`${id}-order-${row.key}`} label="Most notional per order (USD)">
                <Input
                  id={`${id}-order-${row.key}`}
                  inputMode="decimal"
                  value={row.maxPerOrder}
                  placeholder="50"
                  onChange={(event) => updateMarket(row.key, { maxPerOrder: event.target.value })}
                />
              </Labelled>
            </div>
          ))}
          <p className="text-xs text-muted-foreground">
            The index is what the signer signs; the coin is how people and agents name it. Check the
            pair against Hyperliquid's own list of perpetuals.
          </p>
          <Button
            variant="outline"
            size="sm"
            className="w-fit"
            onClick={() => onChange({ markets: [...state.markets, newMarketRow()] })}
          >
            <Plus aria-hidden />
            Add a market
          </Button>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Labelled id={`${id}-day`} label="Most notional per 24 hours (USD)">
              <Input
                id={`${id}-day`}
                inputMode="decimal"
                value={state.maxPerDay}
                placeholder="100"
                aria-describedby={`${id}-day-rule`}
                onChange={(event) => onChange({ maxPerDay: event.target.value })}
              />
              <p id={`${id}-day-rule`} className="text-xs text-muted-foreground">
                Counted when the signer signs. Orders that can only make a position smaller do not
                count, so a position can still be closed when this is used up.
              </p>
            </Labelled>
            <Labelled id={`${id}-window`} label="Submit window (seconds)">
              <Input
                id={`${id}-window`}
                type="number"
                min={5}
                max={300}
                value={state.submitWindowSeconds}
                aria-describedby={`${id}-window-rule`}
                onChange={(event) => onChange({ submitWindowSeconds: event.target.value })}
              />
              <p id={`${id}-window-rule`} className="text-xs text-muted-foreground">
                How long after signing Hyperliquid still accepts the order, from 5 to 300.
              </p>
            </Labelled>
          </div>
          <fieldset className="grid grid-cols-1 gap-2">
            <legend className="mb-1 text-sm font-medium">Time in force</legend>
            {(["Ioc", "Gtc", "Alo"] as const).map((tif) => (
              <Check
                key={tif}
                label={`${timeInForceText[tif].name}: ${timeInForceText[tif].effect}`}
                checked={state.timeInForce.includes(tif)}
                onChange={() =>
                  onChange({
                    timeInForce: state.timeInForce.includes(tif)
                      ? state.timeInForce.filter((item) => item !== tif)
                      : [...state.timeInForce, tif],
                  })
                }
              />
            ))}
            <p className="text-xs text-muted-foreground">
              An order that rests on the book can be left behind if the signer is restored from a
              backup, because the restored signer cannot cancel it.
            </p>
          </fieldset>
          <Check
            label="Allow withdrawing USDC from Hyperliquid, to this wallet's own address only"
            checked={state.withdrawals}
            onChange={() => onChange({ withdrawals: !state.withdrawals })}
          />
        </>
      ) : null}
    </Group>
  );
}

function Group({
  legend,
  hint,
  children,
}: {
  legend: string;
  hint?: string;
  children?: ReactNode;
}) {
  return (
    <fieldset className="grid grid-cols-1 gap-3">
      <legend className="mb-1 text-sm font-semibold">{legend}</legend>
      {hint ? <p className="-mt-2 text-xs text-muted-foreground">{hint}</p> : null}
      {children}
    </fieldset>
  );
}

function Labelled({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}

function Check({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <label className="flex w-fit items-center gap-2 text-sm">
      <input
        type="checkbox"
        className="size-4 accent-(--accent)"
        checked={checked}
        onChange={onChange}
      />
      {label}
    </label>
  );
}

function Radio({
  name,
  label,
  checked,
  onChange,
}: {
  name: string;
  label: string;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <label className="flex w-fit items-center gap-2 text-sm">
      <input
        type="radio"
        name={name}
        className="size-4 accent-(--accent)"
        checked={checked}
        onChange={onChange}
      />
      {label}
    </label>
  );
}
