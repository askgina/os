import { sql } from "drizzle-orm";
import type { Executor } from "./context.ts";
import { rateLimits } from "./db/schema.ts";

/**
 * Limits every server replica shares: token buckets in `os.rate_limits`, counted by the
 * database's clock, so N replicas allow what one does. A bucket holds at most `burst` tokens
 * (default `perMinute`) and gains `perMinute` a minute.
 */

/** The bucket's tokens now: what it held at `at`, refilled since, at most `burst`. */
const refilled = (perMinute: number, burst: number) =>
  sql`least(${burst}::float8, ${rateLimits.tokens} + greatest(0, extract(epoch FROM now() - ${rateLimits.at})) * ${perMinute}::float8 / 60)`;

/**
 * Take one token from `bucket`. False when it has none, and then nothing changes. One statement:
 * concurrent takes from any number of replicas serialize on the bucket's row.
 */
export async function takeToken(
  db: Executor,
  bucket: string,
  perMinute: number,
  burst = perMinute,
): Promise<boolean> {
  const { rows } = await db.execute(sql`
    INSERT INTO ${rateLimits} (bucket, tokens, at)
    VALUES (${bucket}, ${burst}::float8 - 1, now())
    ON CONFLICT (bucket) DO UPDATE
      SET tokens = ${refilled(perMinute, burst)} - 1, at = greatest(${rateLimits.at}, now())
      WHERE ${refilled(perMinute, burst)} >= 1
    RETURNING ${rateLimits.tokens}`);

  return rows.length > 0;
}

/** Whether `bucket` has a token now, without taking it. */
export async function hasToken(
  db: Executor,
  bucket: string,
  perMinute: number,
  burst = perMinute,
): Promise<boolean> {
  const { rows } = await db.execute<{ tokens: number }>(sql`
    SELECT ${refilled(perMinute, burst)} AS tokens FROM ${rateLimits}
    WHERE ${rateLimits.bucket} = ${bucket}`);

  return rows.length === 0 || Number(rows[0]?.tokens) >= 1;
}

/**
 * The client a request is charged to: the address `forwardedHops` entries from the end of
 * `X-Forwarded-For`, which the proxies in front of the server appended (the bundled one appends
 * the last). Fewer entries than that means a proxy was bypassed, and the first is the peer that did
 * it. A request without the header is charged to a shared bucket.
 */
export function clientOf(request: Request, forwardedHops: number): string {
  const entries = request.headers.get("x-forwarded-for")?.split(",") ?? [];

  return entries[Math.max(0, entries.length - forwardedHops)]?.trim() || "direct";
}
