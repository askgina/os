import type { ErasureResult } from "@askgina/os-api";
import { useMutation } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { UserX } from "lucide-react";
import { useState } from "react";
import { FormError, linkClass } from "@/components/common.tsx";
import { SignInAgain } from "@/components/sign-in-again.tsx";
import { Alert } from "@/components/ui/alert.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.tsx";
import { Dialog } from "@/components/ui/dialog.tsx";
import { api, queryClient } from "@/lib/api.ts";
import { needsFreshSignIn } from "@/lib/export.ts";

/**
 * A person erases themselves from this server. While their passkeys still approve somewhere, the
 * server first opens a request per passkey and workspace for the signer to stop accepting it, and
 * erases nothing yet; once those are approved, asking again erases them and signs them out.
 */
export function EraseCard() {
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  const [waiting, setWaiting] = useState<ErasureResult["approvals"]>([]);

  const erase = useMutation({
    mutationFn: () => api.call("eraseMe", { body: {} }),
    onSuccess: async (result) => {
      setConfirming(false);

      if (result.status === "waiting") {
        setWaiting(result.approvals);

        return;
      }

      // The server ended the session with the person; nothing loaded as them may stay.
      queryClient.clear();
      await navigate({ to: "/erased", replace: true });
    },
    onError: () => setConfirming(false),
  });

  return (
    <Card id="erase">
      <CardHeader>
        <div className="min-w-0">
          <CardTitle>Erase me from this server</CardTitle>
          <CardDescription>
            Your name, passkeys, sign-ins, notification devices and settings are deleted, and you
            leave every workspace. Your id stays where history needs it: in each workspace's
            activity log and approvals, and at the signer, where your name now reads "Erased
            person". This cannot be undone.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-4">
        <ul className="grid list-disc grid-cols-1 gap-1 pl-5 text-sm text-muted-foreground">
          <li>
            The only owner of a workspace must first make someone else an owner, or delete it.
          </li>
          <li>
            Where your passkeys approve, the workspace first approves that they stop, on the
            signer's page, as for any approver change. Ask again once that is done.
          </li>
        </ul>
        {waiting.length > 0 ? (
          <Alert tone="accent" className="items-start">
            <div className="grid min-w-0 grid-cols-1 gap-1">
              <p className="font-medium">
                Nothing is erased yet. These workspaces must first approve that your passkeys stop
                approving there:
              </p>
              <ul aria-label="Waiting before erasure">
                {waiting.map((approval) => (
                  <li key={approval.id}>
                    <Link
                      to="/w/$workspaceId/approvals/$approvalId"
                      params={{ workspaceId: approval.workspaceId, approvalId: approval.id }}
                      className={`${linkClass} wrap-anywhere`}
                    >
                      {approval.title}
                    </Link>
                  </li>
                ))}
              </ul>
              <p>You may approve your own. Once all are approved, erase yourself again.</p>
            </div>
          </Alert>
        ) : null}
        {needsFreshSignIn(erase.error) ? (
          <SignInAgain returnTo="/settings#erase">
            Sign in again with your passkey to erase yourself: your sign-in is more than 5 minutes
            old. You come back here afterwards.
          </SignInAgain>
        ) : (
          <FormError error={erase.error} />
        )}
        <div>
          <Button variant="outline" onClick={() => setConfirming(true)} disabled={erase.isPending}>
            <UserX aria-hidden />
            {erase.isPending ? "Erasing…" : "Erase me…"}
          </Button>
        </div>
        <Dialog open={confirming} onClose={() => setConfirming(false)} title="Erase yourself?">
          <p className="mt-2 text-sm text-muted-foreground">
            You leave every workspace and can no longer sign in. Your name and passkeys are deleted
            for good; your id stays in the history of the workspaces you were in.
          </p>
          <div className="mt-6 flex flex-wrap justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirming(false)}>
              Keep my account
            </Button>
            <Button onClick={() => erase.mutate()} disabled={erase.isPending}>
              {erase.isPending ? "Erasing…" : "Erase me"}
            </Button>
          </div>
        </Dialog>
      </CardContent>
    </Card>
  );
}

/** Where an erased person lands, signed out. */
export function ErasedNotice() {
  return (
    <div className="mx-auto mt-6 grid max-w-md grid-cols-1 gap-4 sm:mt-16">
      <Alert className="items-start">
        <UserX aria-hidden />
        <div className="grid min-w-0 grid-cols-1 gap-1">
          <h1 className="text-lg font-semibold">You were erased from this server</h1>
          <p className="text-muted-foreground">
            Your name, passkeys and sign-ins are gone, and you left every workspace. Your passkey
            may still be listed on your device; it no longer signs in here, and you can remove it
            there.
          </p>
        </div>
      </Alert>
    </div>
  );
}
