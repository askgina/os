import {
  ApiError,
  type PolicyDraft,
  type WalletDetail,
  type WorkspaceDetail,
} from "@askgina/os-api";
import { useMutation } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { Clock, Plus, Trash2 } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import {
  CopyButton,
  EmptyState,
  ErrorState,
  FormError,
  FullAddress,
  Loading,
  linkClass,
  PageHeader,
} from "@/components/common.tsx";
import { MandatesCard } from "@/components/mandate.tsx";
import { PolicyTable } from "@/components/policy.tsx";
import { Alert } from "@/components/ui/alert.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
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
import { api, keys, queryClient, useWallet, useWorkspace } from "@/lib/api.ts";
import { assetInfo, chainName, formatAsset, NATIVE_DECIMALS } from "@/lib/assets.ts";
import {
  checksumAddress,
  formatUnits,
  parseUnits,
  percentOf,
  shortAddress,
  UnitsError,
} from "@/lib/format.ts";
import { sweepDestinations } from "@/lib/sweep.ts";

export function WalletPage() {
  const { workspaceId, walletId } = useParams({ from: "/w/$workspaceId/wallets/$walletId" });
  const workspace = useWorkspace(workspaceId);
  const wallet = useWallet(workspaceId, walletId);
  if (wallet.isPending || !workspace.data) return <Loading />;
  if (wallet.isError)
    return <ErrorState error={wallet.error} retry={() => void wallet.refetch()} />;
  return <WalletView wallet={wallet.data} workspace={workspace.data} />;
}

function WalletView({ wallet, workspace }: { wallet: WalletDetail; workspace: WorkspaceDetail }) {
  const agent = workspace.agents.find((item) => item.id === wallet.agentId) ?? null;
  const context = { chains: workspace.chains, agents: workspace.agents, balances: wallet.balances };
  const canAdmin = workspace.role === "owner";
  return (
    <div className="grid grid-cols-1 gap-6">
      <PageHeader
        title={wallet.label}
        description={
          agent ? (
            <>
              The wallet of agent{" "}
              <Link
                to="/w/$workspaceId/agents/$agentId"
                params={{ workspaceId: workspace.id, agentId: agent.id }}
                className={linkClass}
              >
                {agent.name}
              </Link>
            </>
          ) : (
            "The workspace's shared treasury"
          )
        }
      />
      <Card>
        <CardHeader>
          <CardTitle>Address</CardTitle>
          <CopyButton value={checksumAddress(wallet.address)} label="Copy wallet address" />
        </CardHeader>
        <CardContent>
          <FullAddress address={wallet.address} className="text-base" />
          <p className="mt-2 text-xs text-muted-foreground">
            Send funds here to let this wallet pay. Check every group before sending.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Balances and limits</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-5">
          {wallet.balances.length === 0 ? (
            <p className="text-sm text-muted-foreground">No balances yet.</p>
          ) : (
            <ul className="grid grid-cols-1 gap-2">
              {wallet.balances.map((balance) => (
                <li
                  key={`${balance.chainId}|${balance.asset}`}
                  className="flex justify-between gap-3"
                >
                  <span className="text-sm text-muted-foreground">
                    {chainName(balance.chainId, workspace.chains)}
                  </span>
                  <span className="font-medium tabular-nums">
                    {formatUnits(balance.amount, balance.decimals)} {balance.symbol}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {wallet.policy?.assets.map((limit) => {
            const info = assetInfo(limit.chainId, limit.asset, workspace.chains, wallet.balances);
            const spent =
              wallet.spent.find(
                (item) => item.chainId === limit.chainId && item.asset === limit.asset,
              )?.amount ?? "0";
            const share = percentOf(spent, limit.maxPerDay);
            return (
              <div key={`${limit.chainId}|${limit.asset}`} className="grid grid-cols-1 gap-1.5">
                <div className="flex flex-wrap justify-between gap-2 text-sm">
                  <span>{info.symbol} spent in the last 24 hours</span>
                  <span className="tabular-nums">
                    {formatAsset(spent, info)} of {formatAsset(limit.maxPerDay, info)}
                  </span>
                </div>
                <Progress
                  value={share}
                  label={`${info.symbol} spent of the 24-hour limit`}
                  tone={share >= 90 ? "danger" : share >= 70 ? "warning" : "accent"}
                />
                <p className="text-xs text-muted-foreground">
                  At most {formatAsset(limit.maxPerTx, info)} per transaction
                </p>
              </div>
            );
          })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Current limits</CardTitle>
            {wallet.policy ? (
              <CardDescription>
                Revision {wallet.policy.revision}. The signer enforces these.
              </CardDescription>
            ) : null}
          </div>
        </CardHeader>
        <CardContent>
          {wallet.policy ? (
            <PolicyTable policy={wallet.policy} context={context} />
          ) : (
            <EmptyState title="No limits yet">
              This wallet can sign nothing until its first limits are set and approved.
            </EmptyState>
          )}
        </CardContent>
      </Card>

      {wallet.pendingPolicyApprovalId ? (
        <Alert tone="warning">
          <Clock aria-hidden />
          <p>
            A change to these limits is waiting for approval.{" "}
            <Link
              to="/w/$workspaceId/approvals/$approvalId"
              params={{ workspaceId: workspace.id, approvalId: wallet.pendingPolicyApprovalId }}
              className={linkClass}
            >
              Open it
            </Link>
          </p>
        </Alert>
      ) : null}

      <MandatesCard workspace={workspace} filter={{ walletId: wallet.id }} editor={{ wallet }} />

      {canAdmin ? <SweepCard wallet={wallet} workspace={workspace} /> : null}
      {canAdmin ? <PolicyEditor wallet={wallet} workspace={workspace} /> : null}
    </div>
  );
}

/**
 * Empty one asset of the wallet without an agent: the way out for a wallet whose agent was
 * disabled, and for a paused workspace. Only destinations the signer accepts are offered.
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
  chains: string[];
  requesters: string[];
  assets: AssetRow[];
  recipientsMode: "any" | "allowlist";
  recipients: string;
  callsMode: "deny" | "allowlist";
  targets: string;
  feeCeiling: string;
  threshold: string;
  ttlMinutes: string;
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
  };
}

class DraftError extends Error {
  override readonly name = "DraftError";
}

function parseAddresses(text: string, what: string): `0x${string}`[] {
  const lines = text.split(/[\s,]+/).filter((line) => line !== "");
  return lines.map((line) => {
    const lower = line.toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(lower))
      throw new DraftError(`${what}: "${line}" is not an address.`);
    return lower as `0x${string}`;
  });
}

function toDraft(state: EditorState): PolicyDraft {
  if (state.chains.length === 0) throw new DraftError("Choose at least one network.");
  const assets = state.assets.map((row, index) => {
    const label = `Asset ${index + 1}`;
    const asset = row.asset.trim().toLowerCase();
    if (asset !== "native" && !/^0x[0-9a-f]{40}$/.test(asset)) {
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
      if (!state.chains.includes(row.chainId)) {
        throw new DraftError(`${label}: its network is not one of the wallet's networks.`);
      }
      return {
        chainId: row.chainId as `eip155:${number}`,
        asset: asset as "native" | `0x${string}`,
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
  return {
    chains: state.chains as `eip155:${number}`[],
    requesters: state.requesters as PolicyDraft["requesters"],
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
}

function PolicyEditor({ wallet, workspace }: { wallet: WalletDetail; workspace: WorkspaceDetail }) {
  const navigate = useNavigate();
  const id = useId();
  const [state, setState] = useState(() => initialState(wallet, workspace));
  const [draftError, setDraftError] = useState<string | null>(null);
  const update = (patch: Partial<EditorState>) => setState((current) => ({ ...current, ...patch }));
  const updateRow = (key: number, patch: Partial<AssetRow>) =>
    update({ assets: state.assets.map((row) => (row.key === key ? { ...row, ...patch } : row)) });
  const toggle = (list: string[], value: string) =>
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
                        updateRow(row.key, {
                          asset,
                          ...(known.decimals === null ? {} : { decimals: String(known.decimals) }),
                        });
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

function Group({ legend, hint, children }: { legend: string; hint?: string; children: ReactNode }) {
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
