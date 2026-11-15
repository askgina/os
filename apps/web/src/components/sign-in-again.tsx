import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { KeyRound, LogIn } from "lucide-react";
import type { ReactNode } from "react";
import { FormError } from "@/components/common.tsx";
import { Alert } from "@/components/ui/alert.tsx";
import { Button } from "@/components/ui/button.tsx";
import { api, queryClient } from "@/lib/api.ts";
import { signInHref } from "@/lib/return-path.ts";

/**
 * For what the server allows only after a recent passkey sign-in (`sign_in_again`): signs out,
 * then sends the person through the sign-in page and back to `returnTo`.
 */
export function SignInAgain({ returnTo, children }: { returnTo: string; children: ReactNode }) {
  const navigate = useNavigate();
  const signInAgain = useMutation({
    mutationFn: () => api.call("logout", { body: {} }),
    onSuccess: async () => {
      queryClient.clear();
      await navigate({ href: signInHref(returnTo) });
    },
  });
  return (
    <Alert tone="warning" className="items-start">
      <LogIn aria-hidden />
      <div className="grid min-w-0 grid-cols-1 gap-2">
        <p>{children}</p>
        <FormError error={signInAgain.error} />
        <div>
          <Button onClick={() => signInAgain.mutate()} disabled={signInAgain.isPending}>
            <KeyRound aria-hidden />
            {signInAgain.isPending ? "Signing out…" : "Sign in again"}
          </Button>
        </div>
      </div>
    </Alert>
  );
}
