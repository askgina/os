import type { UserId } from "@askgina/os-protocol";
import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { AppContext, Executor } from "../context.ts";
import { ceremonies, credentials } from "../db/schema.ts";
import { HttpError } from "../http/errors.ts";
import { randomToken } from "./secrets.ts";

/** A browser has five minutes to finish what it started. */
const CEREMONY_TTL_SECONDS = 300;

type Kind = (typeof ceremonies.$inferSelect)["kind"];

type Deps = Pick<AppContext, "db" | "config" | "now">;

async function insertCeremony(
  ctx: Deps,
  input: { kind: Kind; challenge: string; userId: UserId | null; context: Record<string, string> },
): Promise<string> {
  const id = randomToken(24);
  await ctx.db.insert(ceremonies).values({
    id,
    kind: input.kind,
    challenge: input.challenge,
    userId: input.userId,
    context: input.context,
    expiresAt: new Date((ctx.now() + CEREMONY_TTL_SECONDS) * 1000),
  });

  return id;
}

/**
 * Mark a ceremony used and return it. The update is conditional, so of two requests racing with
 * the same ceremony id only one gets a row back; the other is told it is gone.
 */
async function consumeCeremony(ctx: Deps, id: string, kind: Kind) {
  const [row] = await ctx.db
    .update(ceremonies)
    .set({ consumedAt: new Date(ctx.now() * 1000) })
    .where(
      and(
        eq(ceremonies.id, id),
        eq(ceremonies.kind, kind),
        isNull(ceremonies.consumedAt),
        gt(ceremonies.expiresAt, new Date(ctx.now() * 1000)),
      ),
    )
    .returning();

  if (!row) throw new HttpError("not_found", "this sign-in step expired; start again");

  return row;
}

/**
 * Options for creating a discoverable passkey with user verification. Attestation is not
 * requested: this installation does not restrict which authenticators people use.
 */
export async function startRegistration(
  ctx: Deps,
  input: {
    kind: Exclude<Kind, "login">;
    userId: UserId;
    displayName: string;
    context: Record<string, string>;
    exclude?: { id: string; transports: string[] }[];
  },
): Promise<{ ceremonyId: string; options: Record<string, unknown> }> {
  const options = await generateRegistrationOptions({
    rpName: ctx.config.relyingParty.name,
    rpID: ctx.config.relyingParty.id,
    userName: input.displayName,
    userDisplayName: input.displayName,
    userID: new TextEncoder().encode(input.userId),
    attestationType: "none",
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
    excludeCredentials: input.exclude ?? [],
  });

  const ceremonyId = await insertCeremony(ctx, {
    kind: input.kind,
    challenge: options.challenge,
    userId: input.userId,
    context: input.context,
  });

  return { ceremonyId, options: { ...options } };
}

export interface NewPasskey {
  id: string;
  publicKey: Buffer;
  counter: number;
  transports: string[];
  deviceType: "singleDevice" | "multiDevice";
  backedUp: boolean;
}

/**
 * Finish a registration: the ceremony is consumed whether or not the response verifies, so a
 * failed attempt cannot be retried against the same challenge.
 */
export async function finishRegistration(
  ctx: Deps,
  input: { ceremonyId: string; kind: Exclude<Kind, "login">; response: unknown },
): Promise<{ ceremony: typeof ceremonies.$inferSelect; passkey: NewPasskey }> {
  const ceremony = await consumeCeremony(ctx, input.ceremonyId, input.kind);

  const verified = await verifyRegistrationResponse({
    response: input.response as RegistrationResponseJSON,
    expectedChallenge: ceremony.challenge,
    expectedOrigin: ctx.config.relyingParty.origins,
    expectedRPID: ctx.config.relyingParty.id,
    requireUserVerification: true,
  }).catch(() => ({ verified: false as const }));

  if (!verified.verified) throw new HttpError("forbidden", "the passkey could not be verified");
  const info = verified.registrationInfo;

  return {
    ceremony,
    passkey: {
      id: info.credential.id,
      publicKey: Buffer.from(info.credential.publicKey),
      counter: info.credential.counter,
      transports: info.credential.transports ?? [],
      deviceType: info.credentialDeviceType,
      backedUp: info.credentialBackedUp,
    },
  };
}

/** Store a verified passkey for a person. */
export async function insertPasskey(
  executor: Executor,
  userId: UserId,
  passkey: NewPasskey,
  label: string,
): Promise<void> {
  await executor.insert(credentials).values({
    id: passkey.id,
    userId,
    publicKey: passkey.publicKey,
    counter: passkey.counter,
    transports: passkey.transports,
    deviceType: passkey.deviceType,
    backedUp: passkey.backedUp,
    label,
  });
}

/** Options for signing in with any passkey of this site the browser holds. */
export async function startLogin(
  ctx: Deps,
): Promise<{ ceremonyId: string; options: Record<string, unknown> }> {
  const options = await generateAuthenticationOptions({
    rpID: ctx.config.relyingParty.id,
    userVerification: "required",
    allowCredentials: [],
  });

  const ceremonyId = await insertCeremony(ctx, {
    kind: "login",
    challenge: options.challenge,
    userId: null,
    context: {},
  });

  return { ceremonyId, options: { ...options } };
}

/** Verify a sign-in and return whose passkey it was. Revoked passkeys are refused. */
export async function finishLogin(
  ctx: Deps,
  input: { ceremonyId: string; response: AuthenticationResponseJSON },
): Promise<{ userId: UserId; credentialId: string }> {
  const ceremony = await consumeCeremony(ctx, input.ceremonyId, "login");

  const [credential] = await ctx.db
    .select()
    .from(credentials)
    .where(and(eq(credentials.id, input.response.id), isNull(credentials.revokedAt)));

  const refused = new HttpError("unauthenticated", "this passkey is not registered here");

  if (!credential) throw refused;

  const verified = await verifyAuthenticationResponse({
    response: input.response,
    expectedChallenge: ceremony.challenge,
    expectedOrigin: ctx.config.relyingParty.origins,
    expectedRPID: ctx.config.relyingParty.id,
    credential: {
      id: credential.id,
      publicKey: new Uint8Array(credential.publicKey),
      counter: credential.counter,
      transports: credential.transports,
    },
    requireUserVerification: true,
  }).catch(() => ({ verified: false, authenticationInfo: undefined }));

  if (!verified.verified || verified.authenticationInfo === undefined) throw refused;
  await ctx.db
    .update(credentials)
    .set({
      counter: verified.authenticationInfo.newCounter,
      lastUsedAt: new Date(ctx.now() * 1000),
    })
    .where(eq(credentials.id, credential.id));

  return { userId: credential.userId, credentialId: credential.id };
}
