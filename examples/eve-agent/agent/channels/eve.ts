import { httpBasic } from "eve/channels/auth";
import { defaultEveAuth, eveChannel } from "eve/channels/eve";

/**
 * Who may talk to the agent. HTTP Basic behind the operator's TLS is enough for one operator;
 * eve also ships `jwtHmac`, `jwtEcdsa` and `oidc` verifiers for a real identity provider. The
 * Vercel OIDC verifier is not used: it needs Vercel.
 *
 * The password is read when the first request arrives, not at import: `eve build` evaluates
 * this file too, and the image it produces must not contain the password.
 */
let verifier: ReturnType<typeof httpBasic> | undefined;

function basic(): ReturnType<typeof httpBasic> {
  if (verifier) return verifier;
  const password = process.env.EVE_CHAT_PASSWORD;
  if (!password || password.length < 16) {
    throw new Error("EVE_CHAT_PASSWORD must be set to at least 16 characters");
  }
  verifier = httpBasic({ username: process.env.EVE_CHAT_USERNAME || "operator", password });
  return verifier;
}

export default eveChannel({
  auth: [(request: Request) => basic()(request)],
  // eve stores the session title as a plaintext run attribute, and by default the title is the
  // first user message; a fixed title keeps the conversation out of it (askgina/os#17).
  onMessage: (ctx) => ({ auth: defaultEveAuth(ctx), title: "Agent session" }),
});
