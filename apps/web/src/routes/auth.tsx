import type { SessionInfo } from "@askgina/os-api";
import { useMutation } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { KeyRound, UserPlus } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";
import { ErrorState, FormError, Loading } from "@/components/common.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";
import { api, keys, queryClient, useInvite, useSession } from "@/lib/api.ts";
import { createPasskey, signWithPasskey } from "@/lib/passkey.ts";
import { DEFAULT_LANDING } from "@/lib/return-path.ts";

function Centered({ children }: { children: ReactNode }) {
  return <div className="mx-auto mt-6 max-w-md sm:mt-16">{children}</div>;
}

const ROLE_WORDS = {
  owner: "an owner: you can change everything, including who approves",
  approver: "an approver: you can approve payments and changes with your passkey",
  viewer: "a viewer: you can see everything but approve nothing",
} as const;

/**
 * Everything cached was loaded as someone else (or no one), so reload it. Except an invite: it is
 * used up by joining, and asking for it again would only answer "not found" on the way out.
 */
const exceptInvites = {
  predicate: (query: { queryKey: readonly unknown[] }) => query.queryKey[0] !== keys.invite("")[0],
};

async function signedIn(session: SessionInfo) {
  queryClient.setQueryData(keys.session, session);
  await queryClient.invalidateQueries(exceptInvites);
}

export function SetupPage() {
  const navigate = useNavigate();
  const [setupToken, setSetupToken] = useState("");
  const [displayName, setDisplayName] = useState("");
  const setup = useMutation({
    mutationFn: async () => {
      const start = await api.call("startSetup", { body: { setupToken, displayName } });
      const response = await createPasskey(start.options);
      return api.call("finishSetup", { body: { ceremonyId: start.ceremonyId, response } });
    },
    onSuccess: async (session) => {
      await signedIn(session);
      await navigate({ to: "/" });
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setup.mutate();
  };

  return (
    <Centered>
      <Card>
        <CardHeader className="flex-col items-stretch">
          <CardTitle className="text-xl">Set up this server</CardTitle>
          <CardDescription>
            You become its first owner. Your passkey is how you sign in and how you approve every
            payment and change; there is no password.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="grid gap-5">
            <div className="grid gap-2">
              <Label htmlFor="setup-token">Setup token</Label>
              <Input
                id="setup-token"
                value={setupToken}
                onChange={(event) => setSetupToken(event.target.value)}
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
                required
                minLength={16}
              />
              <p className="text-xs text-muted-foreground">
                The server printed it in its log when it first started.
              </p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="display-name">Your name</Label>
              <Input
                id="display-name"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                autoComplete="name"
                required
                maxLength={64}
              />
            </div>
            <FormError error={setup.error} />
            <Button type="submit" size="lg" disabled={setup.isPending}>
              <KeyRound aria-hidden />
              {setup.isPending ? "Waiting for your passkey…" : "Create owner passkey"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </Centered>
  );
}

export function LoginPage() {
  const navigate = useNavigate();
  const session = useSession();
  // Already checked by the route: a path on this site, or absent.
  const { next } = useSearch({ from: "/login" });
  const login = useMutation({
    mutationFn: async () => {
      const start = await api.call("startLogin", { body: {} });
      const response = await signWithPasskey(start.options);
      return api.call("finishLogin", { body: { ceremonyId: start.ceremonyId, response } });
    },
    onSuccess: async (signedInSession) => {
      await signedIn(signedInSession);
      await navigate({ href: next ?? DEFAULT_LANDING, replace: true });
    },
  });
  return (
    <Centered>
      <Card>
        <CardHeader className="flex-col items-stretch">
          <CardTitle className="text-xl">Sign in to {session.data?.relyingParty.name}</CardTitle>
          <CardDescription>Use the passkey you created for this server.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <FormError error={login.error} />
          <Button size="lg" onClick={() => login.mutate()} disabled={login.isPending}>
            <KeyRound aria-hidden />
            {login.isPending ? "Waiting for your passkey…" : "Sign in with passkey"}
          </Button>
        </CardContent>
      </Card>
    </Centered>
  );
}

export function JoinPage() {
  const { token } = useParams({ from: "/join/$token" });
  const navigate = useNavigate();
  const session = useSession();
  const invite = useInvite(token);
  const [displayName, setDisplayName] = useState("");

  const register = useMutation({
    mutationFn: async () => {
      const start = await api.call("startInviteRegistration", {
        params: { token },
        body: { displayName },
      });
      const response = await createPasskey(start.options);
      return api.call("finishInviteRegistration", {
        params: { token },
        body: { ceremonyId: start.ceremonyId, response },
      });
    },
    onSuccess: async (next) => {
      await signedIn(next);
      await navigate({ to: "/" });
    },
  });
  const accept = useMutation({
    mutationFn: () => api.call("acceptInvite", { params: { token }, body: {} }),
    onSuccess: async ({ workspaceId }) => {
      await queryClient.invalidateQueries(exceptInvites);
      await navigate({ to: "/w/$workspaceId", params: { workspaceId } });
    },
  });

  if (invite.isPending) return <Loading label="Opening the invite" />;
  if (invite.isError) {
    return (
      <Centered>
        <ErrorState error={invite.error} />
        <p className="text-sm text-muted-foreground">
          Invite links work once and expire. Ask the person who invited you for a new one.
        </p>
      </Centered>
    );
  }

  const user = session.data?.user ?? null;
  return (
    <Centered>
      <Card>
        <CardHeader className="flex-col items-stretch">
          <CardTitle className="text-xl">Join {invite.data.workspaceName}</CardTitle>
          <CardDescription>
            {invite.data.invitedBy} invited you as {ROLE_WORDS[invite.data.role]}.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {user ? (
            <div className="grid gap-4">
              <p className="text-sm">
                You are signed in as <strong>{user.displayName}</strong>.
              </p>
              <FormError error={accept.error} />
              <Button size="lg" onClick={() => accept.mutate()} disabled={accept.isPending}>
                <UserPlus aria-hidden />
                {accept.isPending ? "Joining…" : "Accept invite"}
              </Button>
            </div>
          ) : (
            <form
              className="grid gap-5"
              onSubmit={(event) => {
                event.preventDefault();
                register.mutate();
              }}
            >
              <div className="grid gap-2">
                <Label htmlFor="join-name">Your name</Label>
                <Input
                  id="join-name"
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  autoComplete="name"
                  required
                  maxLength={64}
                />
              </div>
              <FormError error={register.error} />
              <Button type="submit" size="lg" disabled={register.isPending}>
                <KeyRound aria-hidden />
                {register.isPending ? "Waiting for your passkey…" : "Create passkey and join"}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </Centered>
  );
}
