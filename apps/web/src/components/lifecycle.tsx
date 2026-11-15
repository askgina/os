import {
  ApiError,
  type AssetBalance,
  type ChainInfo,
  type DeletionPreflight,
  type WalletDetail,
  type WalletSummary,
  type WorkspaceDetail,
} from "@askgina/os-api";
import { useMutation } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  Ban,
  Clock,
  Landmark,
  OctagonAlert,
  PauseCircle,
  SearchX,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { ErrorState, FormError, Loading, linkClass, useNow } from "@/components/common.tsx";
import { Alert } from "@/components/ui/alert.tsx";
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
import {
  api,
  keys,
  queryClient,
  useApprovalDetails,
  useDeletionPreflight,
  usePendingApprovals,
} from "@/lib/api.ts";
import { chainName } from "@/lib/assets.ts";
import { explainLifecycleError } from "@/lib/codes.ts";
import { formatUnits, shortAddress } from "@/lib/format.ts";
import {
  blockerText,
  DEFAULT_MIN_DESTROY_DELAY_SECONDS,
  delayChoices,
  destroyAfterFor,
  destroyCountdown,
  formatDelay,
  heldBalances,
  serverClockOffset,
  waitingRequests,
  waitingRetirementOf,
  walletChangeable,
} from "@/lib/lifecycle.ts";
import { formatEndTime } from "@/lib/mandate.ts";

/**
 * Retiring a wallet and deleting a workspace. Both destroy keys after a delay the signer
 * enforces, approved on the signer's own page like any admin change, and both can be cancelled
 * until then. The signer cannot see balances: what the server reads of them is shown as advice,
 * labelled as such.
 */

/** Said wherever balances are shown before keys are destroyed. */
export const BALANCES_NOTE =
  "Read by the server; the signer cannot check balances. The server reads only each network's coin and the assets a wallet's limits name, so a wallet can hold more than this.";

/**
 * The balances that would be lost with a key, as the server reads them: null when it could not
 * read them, undefined while they load.
 */
export function ServerBalances({
  balances,
  chains,
}: {
  balances: readonly AssetBalance[] | null | undefined;
  chains: readonly ChainInfo[];
}) {
  if (balances === undefined) {
    return <p className="text-sm text-muted-foreground">Reading balances…</p>;
  }
  if (balances === null) {
    return <p className="text-sm text-danger">The server could not read this wallet's balances.</p>;
  }
  const held = heldBalances(balances);
  if (held.length === 0) {
    return <p className="text-sm text-muted-foreground">Nothing the server can see.</p>;
  }
  return (
    <ul className="grid grid-cols-1 gap-1">
      {held.map((balance) => (
        <li
          key={`${balance.chainId}|${balance.asset}`}
          className="flex flex-wrap justify-between gap-x-3 text-sm"
        >
          <span className="text-muted-foreground">{chainName(balance.chainId, chains)}</span>
          <span className="font-medium tabular-nums wrap-anywhere">
            {formatUnits(balance.amount, balance.decimals)} {balance.symbol}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** One wallet whose key would be destroyed: its name, address and balances. */
export function WalletAtRisk({
  wallet,
  balances,
  chains,
}: {
  wallet: Pick<WalletSummary, "label" | "address">;
  balances: readonly AssetBalance[] | null | undefined;
  chains: readonly ChainInfo[];
}) {
  return (
    <li className="grid grid-cols-1 gap-1.5 px-4 py-3">
      <p className="flex min-w-0 flex-wrap items-baseline gap-x-2">
        <Landmark className="size-4 shrink-0 self-center text-muted-foreground" aria-hidden />
        <span className="min-w-0 font-medium wrap-anywhere">{wallet.label}</span>
        <span className="font-mono text-xs text-muted-foreground">
          {shortAddress(wallet.address)}
        </span>
      </p>
      <ServerBalances balances={balances} chains={chains} />
    </li>
  );
}

/**
 * The delay before the keys are destroyed, and the request it makes. The shortest the signer
 * allows comes first and is chosen; each choice names the date it lands on. `blocked` says why
 * the request cannot be made yet.
 */
function DestroyForm({
  preflight,
  readAt,
  name,
  submitLabel,
  blocked,
  children,
  submit,
}: {
  preflight: DeletionPreflight;
  /** When the preflight was read, in this browser's seconds: it sets the server's clock. */
  readAt: number;
  name: string;
  submitLabel: string;
  blocked: ReactNode;
  children: ReactNode;
  submit: {
    mutate: (destroyAfter: number) => void;
    isPending: boolean;
    error: unknown;
  };
}) {
  const now = useNow();
  const offset = serverClockOffset(preflight, readAt);
  const choices = delayChoices(preflight.minDestroyDelaySeconds);
  const [delay, setDelay] = useState(choices[0] ?? DEFAULT_MIN_DESTROY_DELAY_SECONDS);
  return (
    <form
      className="grid grid-cols-1 gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit.mutate(destroyAfterFor(delay, Math.floor(Date.now() / 1000), offset));
      }}
    >
      {children}
      <fieldset className="grid min-w-0 grid-cols-1 gap-2">
        <legend className="mb-1 text-sm font-medium">
          Time to cancel before keys are destroyed
        </legend>
        {choices.map((choice) => (
          <Choice
            key={choice}
            name={name}
            label={`In ${formatDelay(choice)}${
              choice === preflight.minDestroyDelaySeconds ? ", the shortest the signer allows" : ""
            }`}
            detail={`Destroyed after ${formatEndTime(destroyAfterFor(choice, now, offset))}`}
            checked={delay === choice}
            onChange={() => setDelay(choice)}
          />
        ))}
      </fieldset>
      {blocked}
      <FormError error={submit.error} explain={explainLifecycleError} />
      <div>
        <Button
          type="submit"
          variant="destructive"
          disabled={blocked !== null || submit.isPending}
          className="h-auto min-h-9 whitespace-normal"
        >
          {submit.isPending ? "Submitting…" : submitLabel}
        </Button>
      </div>
    </form>
  );
}

/** Loads the preflight for a form, with the moment it was read. */
function WithPreflight({
  workspaceId,
  children,
}: {
  workspaceId: string;
  children: (preflight: DeletionPreflight, readAt: number) => ReactNode;
}) {
  const preflight = useDeletionPreflight(workspaceId);
  if (preflight.isPending) return <Loading label="Reading balances" />;
  if (preflight.isError) {
    return <ErrorState error={preflight.error} retry={() => void preflight.refetch()} />;
  }
  return <>{children(preflight.data, Math.floor(preflight.dataUpdatedAt / 1000))}</>;
}

/** Owners retire a wallet: it signs nothing once approved, and its key goes after the delay. */
export function RetireWalletCard({
  wallet,
  workspace,
}: {
  wallet: WalletDetail;
  workspace: WorkspaceDetail;
}) {
  const navigate = useNavigate();
  const name = useId();
  const [open, setOpen] = useState(false);
  const retire = useMutation({
    mutationFn: (destroyAfter: number) =>
      api.call("requestRetireWallet", {
        params: { workspaceId: workspace.id, walletId: wallet.id },
        body: { destroyAfter },
      }),
    onSuccess: async (approval) => {
      await queryClient.invalidateQueries({ queryKey: keys.workspace(workspace.id) });
      await queryClient.invalidateQueries({ queryKey: ["approvals", workspace.id] });
      await navigate({
        to: "/w/$workspaceId/approvals/$approvalId",
        params: { workspaceId: workspace.id, approvalId: approval.id },
      });
    },
  });
  const held = heldBalances(wallet.balances);
  return (
    <Card id="retire">
      <CardHeader>
        <div className="min-w-0">
          <CardTitle>Retire this wallet</CardTitle>
          <CardDescription>
            Once approved it signs nothing more and its approvals in advance end. After a delay the
            signer destroys its key, and whatever is still in it is lost for good. Until then an
            owner or approver can cancel. Needs {workspace.adminThreshold}{" "}
            {workspace.adminThreshold === 1 ? "approval" : "approvals"}, as an admin change does.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        {open ? (
          <WithPreflight workspaceId={workspace.id}>
            {(preflight, readAt) => (
              <DestroyForm
                preflight={preflight}
                readAt={readAt}
                name={name}
                submitLabel="Ask for approval to retire"
                blocked={null}
                submit={retire}
              >
                <section className="grid grid-cols-1 gap-2" aria-label="Still in this wallet">
                  <p className="text-sm font-medium">Still in this wallet</p>
                  <ul className="rounded-md border">
                    <WalletAtRisk
                      wallet={wallet}
                      balances={wallet.balances}
                      chains={workspace.chains}
                    />
                  </ul>
                  <p className="text-xs text-muted-foreground">{BALANCES_NOTE}</p>
                  {held.length > 0 && wallet.lifecycle.state === "active" ? (
                    <a href="#sweep" className={linkClass}>
                      Empty it first
                    </a>
                  ) : null}
                </section>
              </DestroyForm>
            )}
          </WithPreflight>
        ) : (
          <Button variant="outline" onClick={() => setOpen(true)}>
            <Ban aria-hidden />
            Retire this wallet…
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Owners delete the workspace, once it is paused: every wallet's key is destroyed after the
 * delay and its data made unreadable. Shows what the server reads would be lost first.
 */
export function DeleteWorkspaceCard({ workspace }: { workspace: WorkspaceDetail }) {
  const navigate = useNavigate();
  const name = useId();
  const [open, setOpen] = useState(false);
  const remove = useMutation({
    mutationFn: (destroyAfter: number) =>
      api.call("requestDeleteWorkspace", {
        params: { workspaceId: workspace.id },
        body: { destroyAfter },
      }),
    onSuccess: async (approval) => {
      await queryClient.invalidateQueries({ queryKey: keys.workspace(workspace.id) });
      await queryClient.invalidateQueries({ queryKey: ["approvals", workspace.id] });
      await navigate({
        to: "/w/$workspaceId/approvals/$approvalId",
        params: { workspaceId: workspace.id, approvalId: approval.id },
      });
    },
  });
  return (
    <Card id="delete">
      <CardHeader>
        <div className="min-w-0">
          <CardTitle>Delete this workspace</CardTitle>
          <CardDescription>
            Once approved its wallets sign nothing more. After a delay the signer destroys every
            wallet's key and the workspace's data is made unreadable; whatever is still in the
            wallets then is lost for good. Until then any member can cancel. Needs{" "}
            {workspace.adminThreshold} {workspace.adminThreshold === 1 ? "approval" : "approvals"},
            as an admin change does.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        {open ? (
          <WithPreflight workspaceId={workspace.id}>
            {(preflight, readAt) => (
              <DestroyForm
                preflight={preflight}
                readAt={readAt}
                name={name}
                submitLabel="Ask for approval to delete"
                blocked={
                  workspace.paused ? null : (
                    <Alert tone="warning">
                      <PauseCircle aria-hidden />
                      <p>
                        Pause the workspace first, above. A workspace is deleted only while paused,
                        so nothing signs while people decide.
                      </p>
                    </Alert>
                  )
                }
                submit={remove}
              >
                <section className="grid grid-cols-1 gap-2" aria-label="What would be lost">
                  <p className="text-sm font-medium">What would be lost</p>
                  {preflight.wallets.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      No wallet keys: nothing is lost but the workspace's data.
                    </p>
                  ) : (
                    <ul className="divide-y rounded-md border">
                      {preflight.wallets.map((item) => (
                        <WalletAtRisk
                          key={item.wallet.id}
                          wallet={item.wallet}
                          balances={item.balances}
                          chains={workspace.chains}
                        />
                      ))}
                    </ul>
                  )}
                  <p className="text-xs text-muted-foreground">{BALANCES_NOTE}</p>
                </section>
                {preflight.blockers.length > 0 ? (
                  <Alert tone="warning" className="items-start">
                    <TriangleAlert aria-hidden />
                    <ul className="grid grid-cols-1 gap-1.5">
                      {preflight.blockers.map((blocker) => (
                        <li key={blocker}>{blockerText[blocker]}</li>
                      ))}
                    </ul>
                  </Alert>
                ) : null}
              </DestroyForm>
            )}
          </WithPreflight>
        ) : (
          <Button variant="outline" onClick={() => setOpen(true)}>
            <Trash2 aria-hidden />
            Delete this workspace…
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * While the workspace is being deleted: when its keys go, the time left, and a cancel any member
 * can make without a passkey.
 */
export function DeletingNotice({ workspace }: { workspace: WorkspaceDetail }) {
  const now = useNow();
  const destroyAfter = workspace.lifecycle.destroyAfter ?? now;
  return (
    <Alert tone="danger" className="items-start">
      <Trash2 aria-hidden />
      <div className="grid min-w-0 grid-cols-1 gap-2">
        <p className="font-medium">This workspace is being deleted</p>
        <p>
          Its wallets sign nothing. After {formatEndTime(destroyAfter)} the signer destroys their
          keys and the workspace's data is made unreadable; whatever is still in the wallets then is
          lost. Until then any member can cancel.
        </p>
        <p className="font-medium tabular-nums">{destroyCountdown(destroyAfter, now)}</p>
        <CancelButton
          label="Cancel deletion"
          title="Cancel the deletion?"
          keep="Keep deleting"
          what="The keys are kept and nothing is destroyed. The workspace stays paused until resuming it is approved, and approvals in advance that ended stay ended. No passkey is needed."
          cancel={() =>
            api.call("cancelDeleteWorkspace", { params: { workspaceId: workspace.id }, body: {} })
          }
          onDone={async (next) => {
            queryClient.setQueryData(keys.workspace(workspace.id), next);
            await queryClient.invalidateQueries({ queryKey: keys.workspaces });
            await queryClient.invalidateQueries({ queryKey: ["wallet", workspace.id] });
          }}
        />
      </div>
    </Alert>
  );
}

/**
 * Shown in place of a workspace that was deleted while its page was open: the server no longer
 * lets its former members read it.
 */
export function DeletedWorkspace({ name }: { name: string }) {
  return (
    <div className="grid grid-cols-1 gap-4">
      <Link to="/" className={linkClass}>
        ← All workspaces
      </Link>
      <Alert className="items-start">
        <Trash2 aria-hidden />
        <div className="grid min-w-0 grid-cols-1 gap-1">
          <h1 className="text-lg font-semibold wrap-anywhere">{name} was deleted</h1>
          <p className="text-muted-foreground">
            The signer destroyed its wallet keys and its data was made unreadable. Its members no
            longer have access. Only a record of ids, times and hashes remains on the server.
          </p>
        </div>
      </Alert>
    </div>
  );
}

/**
 * Shown for a workspace the server will not show this person: one that never existed, one they
 * are not a member of, or one whose deletion finished before this page was opened (a reload after
 * it, say). The server answers the same for each, so this page does not guess which.
 */
export function MissingWorkspace() {
  return (
    <div className="grid grid-cols-1 gap-4">
      <Link to="/" className={linkClass}>
        ← All workspaces
      </Link>
      <Alert className="items-start">
        <SearchX aria-hidden />
        <div className="grid min-w-0 grid-cols-1 gap-1">
          <h1 className="text-lg font-semibold">This workspace does not exist or was deleted</h1>
          <p className="text-muted-foreground">
            Or you are not one of its members. If someone sent you a link to it, ask them for an
            invite.
          </p>
        </div>
      </Alert>
    </div>
  );
}

/**
 * Links the waiting request to delete the workspace, where people look for it besides the inbox:
 * on the overview. Shown to every member, as the inbox is.
 */
export function WaitingDeletionNotice({ workspace }: { workspace: WorkspaceDetail }) {
  const watch = workspace.lifecycle.state === "active" && workspace.pendingApprovals > 0;
  const pending = usePendingApprovals(workspace.id, watch);
  const request = watch
    ? waitingRequests(pending.data?.items ?? [], "delete-workspace")[0]
    : undefined;
  if (!request) return null;
  return (
    <WaitingNotice workspaceId={workspace.id} approvalId={request.id}>
      Deleting this workspace is waiting for approval.
    </WaitingNotice>
  );
}

/** Links the waiting request to retire this wallet, from the wallet's page. */
export function WaitingRetirementNotice({
  wallet,
  workspace,
}: {
  wallet: WalletDetail;
  workspace: WorkspaceDetail;
}) {
  const watch =
    workspace.lifecycle.state === "active" &&
    walletChangeable(wallet.lifecycle) &&
    workspace.pendingApprovals > 0;
  const pending = usePendingApprovals(workspace.id, watch);
  // A summary does not name its wallet, so each waiting retirement is read in full.
  const candidates = watch ? waitingRequests(pending.data?.items ?? [], "retire-wallet") : [];
  const details = useApprovalDetails(candidates.map((item) => item.id));
  const request = waitingRetirementOf(details, wallet.id);
  if (!request) return null;
  return (
    <WaitingNotice workspaceId={workspace.id} approvalId={request.id}>
      Retiring this wallet is waiting for approval.
    </WaitingNotice>
  );
}

function WaitingNotice({
  workspaceId,
  approvalId,
  children,
}: {
  workspaceId: string;
  approvalId: string;
  children: ReactNode;
}) {
  return (
    <Alert tone="warning">
      <Clock aria-hidden />
      <p>
        {children}{" "}
        <Link
          to="/w/$workspaceId/approvals/$approvalId"
          params={{ workspaceId, approvalId }}
          className={linkClass}
        >
          Open the request
        </Link>
      </p>
    </Alert>
  );
}

/** Whether a failed read of a workspace means it was deleted while its page was open. */
export function deletedWhileOpen(
  error: unknown,
  last: WorkspaceDetail | undefined,
): last is WorkspaceDetail {
  return (
    last !== undefined &&
    last.lifecycle.state !== "active" &&
    error instanceof ApiError &&
    error.code === "not_found"
  );
}

/**
 * A wallet that is retiring, stopped after a cancelled retirement, or whose key is gone: what it
 * can still do, and the cancel while there is time.
 */
export function WalletLifecycleNotice({
  wallet,
  workspace,
}: {
  wallet: WalletDetail;
  workspace: WorkspaceDetail;
}) {
  const now = useNow();
  const { lifecycle } = wallet;
  switch (lifecycle.state) {
    case "active":
      return null;
    case "retiring": {
      const destroyAfter = lifecycle.destroyAfter ?? now;
      const withWorkspace = workspace.lifecycle.state === "deleting";
      return (
        <Alert tone="danger" className="items-start">
          <OctagonAlert aria-hidden />
          <div className="grid min-w-0 grid-cols-1 gap-2">
            <p className="font-medium">This wallet is being retired</p>
            <p>
              It signs nothing. After {formatEndTime(destroyAfter)} the signer destroys its key;
              whatever is still in it then is lost. Do not send anything to it.
            </p>
            <p className="font-medium tabular-nums">{destroyCountdown(destroyAfter, now)}</p>
            {withWorkspace ? (
              <p>It goes with the workspace, which is being deleted: cancel that instead.</p>
            ) : workspace.role !== "viewer" ? (
              <CancelButton
                label="Cancel retirement"
                title="Cancel the retirement?"
                keep="Keep retiring"
                what="The key is kept. The wallet stays stopped and signs nothing until new limits are approved for it, and approvals in advance that ended stay ended. No passkey is needed."
                cancel={() =>
                  api.call("cancelRetireWallet", {
                    params: { workspaceId: workspace.id, walletId: wallet.id },
                    body: {},
                  })
                }
                onDone={async () => {
                  await queryClient.invalidateQueries({
                    queryKey: keys.wallet(workspace.id, wallet.id),
                  });
                  await queryClient.invalidateQueries({ queryKey: keys.workspace(workspace.id) });
                }}
              />
            ) : (
              <p>An owner or approver can cancel it until then.</p>
            )}
          </div>
        </Alert>
      );
    }
    case "held":
      return (
        <Alert tone="warning" className="items-start">
          <PauseCircle aria-hidden />
          <div className="grid min-w-0 grid-cols-1 gap-1">
            <p className="font-medium">Stopped: its retirement was cancelled</p>
            <p>
              Its key is kept, but it signs nothing until new limits are approved for it.
              {workspace.role === "owner" ? (
                <>
                  {" "}
                  <a href="#policy" className={linkClass}>
                    Set new limits
                  </a>
                </>
              ) : null}
            </p>
          </div>
        </Alert>
      );
    case "destroyed":
      return (
        <Alert className="items-start">
          <Trash2 aria-hidden />
          <div className="grid min-w-0 grid-cols-1 gap-1">
            <p className="font-medium">Its key was destroyed</p>
            <p className="text-muted-foreground">
              The signer destroyed this wallet's key, which was due after{" "}
              {formatEndTime(lifecycle.destroyAfter ?? now)}. It can never sign again, and anything
              sent to its address is lost.
            </p>
          </div>
        </Alert>
      );
  }
}

/** A cancel that needs no passkey, behind a confirmation. */
function CancelButton<T>({
  label,
  title,
  keep,
  what,
  cancel,
  onDone,
}: {
  label: string;
  title: string;
  keep: string;
  what: string;
  cancel: () => Promise<T>;
  onDone: (result: T) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const mutation = useMutation({
    mutationFn: cancel,
    onSuccess: async (result) => {
      setOpen(false);
      await onDone(result);
    },
  });
  return (
    <>
      <div>
        <Button variant="outline" onClick={() => setOpen(true)} disabled={mutation.isPending}>
          {label}
        </Button>
      </div>
      <Dialog open={open} onClose={() => setOpen(false)} title={title}>
        <p className="mt-2 text-sm text-muted-foreground">{what}</p>
        <FormError error={mutation.error} />
        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={() => setOpen(false)}>
            {keep}
          </Button>
          <Button onClick={() => mutation.mutate()} disabled={mutation.isPending}>
            {mutation.isPending ? "Cancelling…" : label}
          </Button>
        </div>
      </Dialog>
    </>
  );
}
