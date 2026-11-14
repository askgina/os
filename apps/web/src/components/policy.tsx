import type { AgentSummary, AssetBalance, ChainInfo } from "@askgina/os-api";
import type { WalletPolicy } from "@askgina/os-protocol";
import { assetInfo, chainName, formatAsset } from "@/lib/assets.ts";
import { checksumAddress, formatDuration, formatUnits } from "@/lib/format.ts";
import { cn } from "@/lib/utils.ts";

export interface PolicyContext {
  chains: readonly ChainInfo[];
  agents: readonly AgentSummary[];
  balances?: readonly AssetBalance[];
}

interface Row {
  label: string;
  value: string;
}

/** A policy as labelled lines a person can read. Labels are stable so two policies can be compared. */
export function policyRows(policy: WalletPolicy | null, context: PolicyContext): Row[] {
  if (!policy) return [];
  const agentName = (id: string) => context.agents.find((agent) => agent.id === id)?.name ?? id;
  const rows: Row[] = [
    {
      label: "Networks",
      value: policy.chains.map((id) => chainName(id, context.chains)).join(", ") || "None",
    },
    {
      label: "Agents that may use it",
      value: policy.requesters.map(agentName).join(", ") || "None",
    },
  ];
  for (const limit of policy.assets) {
    const info = assetInfo(limit.chainId, limit.asset, context.chains, context.balances);
    const where = `${info.symbol} on ${chainName(limit.chainId, context.chains)}`;
    rows.push({ label: `${where}: per transaction`, value: formatAsset(limit.maxPerTx, info) });
    rows.push({ label: `${where}: per 24 hours`, value: formatAsset(limit.maxPerDay, info) });
  }
  if (policy.assets.length === 0) rows.push({ label: "Assets it may send", value: "None" });
  rows.push({
    label: "Recipients",
    value:
      policy.recipients.mode === "any"
        ? "Anyone"
        : `Only: ${policy.recipients.addresses.map(checksumAddress).join(", ") || "nobody"}`,
  });
  rows.push({
    label: "Contract calls",
    value:
      policy.contractCalls.mode === "deny"
        ? "Not allowed"
        : `Only to: ${policy.contractCalls.targets.map(checksumAddress).join(", ") || "none"}`,
  });
  rows.push({
    label: "Network fee ceiling",
    value: `${formatUnits(policy.fees.maxPerTxWei, 18)} per transaction (native coin)`,
  });
  rows.push({
    label: "Approvals needed",
    value: `${policy.approvals.threshold} ${policy.approvals.threshold === 1 ? "person" : "people"}`,
  });
  rows.push({ label: "Approval valid for", value: formatDuration(policy.approvals.ttlSeconds) });
  return rows;
}

export function PolicyTable({ policy, context }: { policy: WalletPolicy; context: PolicyContext }) {
  return (
    <dl className="grid gap-3">
      {policyRows(policy, context).map((row) => (
        <div key={row.label} className="grid gap-1 sm:grid-cols-[14rem_1fr] sm:gap-4">
          <dt className="text-sm text-muted-foreground">{row.label}</dt>
          <dd className="text-sm break-words">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Field-by-field before and after. Unchanged fields are listed last and dimmed. */
export function PolicyDiff({
  current,
  proposed,
  context,
}: {
  current: WalletPolicy | null;
  proposed: WalletPolicy;
  context: PolicyContext;
}) {
  const before = new Map(policyRows(current, context).map((row) => [row.label, row.value]));
  const after = new Map(policyRows(proposed, context).map((row) => [row.label, row.value]));
  const labels = [...new Set([...after.keys(), ...before.keys()])];
  const changed = labels.filter((label) => before.get(label) !== after.get(label));
  const same = labels.filter((label) => before.get(label) === after.get(label));
  return (
    <div className="grid gap-3">
      {current === null ? (
        <p className="text-sm text-muted-foreground">
          This is the wallet's first policy. Until it is approved, the wallet can sign nothing.
        </p>
      ) : null}
      <ul className="divide-y rounded-md border">
        {[...changed, ...same].map((label) => {
          const isChanged = changed.includes(label);
          return (
            <li key={label} className={cn("grid gap-1 px-4 py-3", !isChanged && "opacity-60")}>
              <p className="flex items-center gap-2 text-sm font-medium">
                {label}
                {isChanged ? null : (
                  <span className="text-xs font-normal text-muted-foreground">unchanged</span>
                )}
              </p>
              {isChanged ? (
                <div className="grid gap-1 text-sm sm:grid-cols-2 sm:gap-4">
                  <p className="break-words">
                    <span className="text-muted-foreground">Before: </span>
                    {before.get(label) ?? <span className="text-muted-foreground">not set</span>}
                  </p>
                  <p className="break-words font-medium">
                    <span className="font-normal text-muted-foreground">After: </span>
                    {after.get(label) ?? <span className="text-muted-foreground">removed</span>}
                  </p>
                </div>
              ) : (
                <p className="text-sm break-words">{after.get(label)}</p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
