import { useParams } from "@tanstack/react-router";
import { useState } from "react";
import { CloneResultGone, CloneResultView } from "@/components/export.tsx";
import { takeCloneResult } from "@/lib/reveal.ts";

/**
 * Right after a workspace was copied or imported: its new agents' tokens and invite links, shown
 * this once. A reload or a return finds them gone.
 */
export function CreatedPage() {
  const { workspaceId } = useParams({ from: "/w/$workspaceId/created" });
  const [result] = useState(() => takeCloneResult(workspaceId));

  return result ? (
    <CloneResultView result={result} />
  ) : (
    <CloneResultGone workspaceId={workspaceId} />
  );
}
