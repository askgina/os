import { type ErrorComponentProps, Link, Outlet, useRouter } from "@tanstack/react-router";
import { Settings, ShieldCheck } from "lucide-react";
import { type ReactNode, useEffect } from "react";
import { EmptyState, ErrorState } from "@/components/common.tsx";
import { useSession } from "@/lib/api.ts";

/** The frame around every page. The root route has loaded the session before this renders. */
export function AppShell() {
  const session = useSession();
  const productName = session.data?.relyingParty.name ?? null;
  useEffect(() => {
    if (productName) document.title = productName;
  }, [productName]);

  return (
    <Frame productName={productName} signedIn={Boolean(session.data?.user)}>
      <Outlet />
    </Frame>
  );
}

/** Shown when the session itself could not be loaded, for example while the server is down. */
export function ShellError({ error }: ErrorComponentProps) {
  const router = useRouter();

  return (
    <Frame productName={null} signedIn={false}>
      <ErrorState
        error={error instanceof Error ? error : null}
        retry={() => void router.invalidate()}
      />
    </Frame>
  );
}

function Frame({
  productName,
  signedIn,
  children,
}: {
  productName: string | null;
  signedIn: boolean;
  children: ReactNode;
}) {
  return (
    <div className="min-h-dvh">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:rounded-md focus:bg-card focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <header className="border-b bg-card">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-4 px-4">
          <Link to="/" className="flex items-center gap-2 font-semibold">
            <ShieldCheck className="size-5 text-accent" aria-hidden />
            {productName ?? ""}
          </Link>
          {signedIn ? (
            <Link
              to="/settings"
              className="flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <Settings className="size-4" aria-hidden />
              Settings
            </Link>
          ) : null}
        </div>
      </header>
      <main id="main" className="mx-auto max-w-5xl px-4 pt-6 pb-16">
        {children}
      </main>
    </div>
  );
}

export function NotFound() {
  return (
    <EmptyState title="This page does not exist.">
      <Link to="/" className="text-accent underline-offset-4 hover:underline">
        Go to your workspaces
      </Link>
    </EmptyState>
  );
}
