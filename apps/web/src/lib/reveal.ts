/**
 * An agent's token is shown exactly once, right after it was created or rotated. It is handed
 * from the page that created it to the agent page through this in-memory map, never through the
 * URL, history state or storage, so reloading or going back cannot show it again.
 */
export interface RevealedToken {
  token: string;
  /** Only known at creation; the agent page falls back to this server's `/mcp`. */
  mcpUrl: string | null;
}

const pending = new Map<string, RevealedToken>();

export function revealToken(agentId: string, value: RevealedToken): void {
  pending.set(agentId, value);
}

/**
 * Returns the token and forgets it. Forgetting waits one task so that the render that reads it
 * can run twice (React's development checks do that) and both renders see the same value.
 */
export function takeRevealedToken(agentId: string): RevealedToken | null {
  const value = pending.get(agentId) ?? null;
  if (value) setTimeout(() => pending.delete(agentId), 0);
  return value;
}
