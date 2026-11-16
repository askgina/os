/**
 * The gates of a split deployment only (`E2E_SPLIT=1 e2e/run.sh`): the signer and its
 * confirmation page run as a second Compose project from `deploy/split/signer.compose.yaml`, as
 * on a host of their own, and the control plane from `deploy/split/control.compose.yaml`. The two
 * share nothing but one network that only the server and the signer join.
 *
 * Each gate stands alone and leaves the stack as it found it; `release-gates.spec.ts` runs on the
 * same stack afterwards.
 */
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { z } from "zod";
import { docker, exec, HELPER_IMAGE, signerProject, stack } from "../src/stack.ts";

const run = promisify(execFile);

const ROOT = join(import.meta.dirname, "..", "..");

/** What `e2e/run.sh` made for the split: the peer certificates, and the network both share. */
const split = {
  /** The six files of `deploy/split/make-peer-certs.sh`, and a stranger's set beside them. */
  dir: process.env.E2E_SPLIT_DIR ?? "",
  wire: process.env.E2E_WIRE_NETWORK ?? "",
  /** The signer's name on the wire, in its certificate and in the server's SIGNER_URL. */
  signerHost: process.env.SIGNER_HOSTNAME ?? "",
};

test.beforeAll(() => {
  if (!split.dir || !split.wire || !split.signerHost) {
    throw new Error("run these gates through `E2E_SPLIT=1 e2e/run.sh`");
  }
});

/** The services of one Compose project, from the labels of its containers, running or not. */
async function servicesOf(project: string): Promise<string[]> {
  const output = await docker(
    "ps",
    "--all",
    "--filter",
    `label=com.docker.compose.project=${project}`,
    "--format",
    '{{.Label "com.docker.compose.service"}}',
  );

  return [...new Set(output.split("\n").filter((line) => line.length > 0))].sort();
}

/** Every file and directory name in each volume of one Compose project, by volume. */
async function volumeContents(project: string): Promise<Record<string, string[]>> {
  const volumes = (
    await docker(
      "volume",
      "ls",
      "--filter",
      `label=com.docker.compose.project=${project}`,
      "--format",
      "{{.Name}}",
    )
  )
    .split("\n")
    .filter((line) => line.length > 0);

  const contents: Record<string, string[]> = {};

  for (const volume of volumes) {
    const listing = await docker(
      "run",
      "--rm",
      "--network",
      "none",
      "-v",
      `${volume}:/v:ro`,
      HELPER_IMAGE,
      "find",
      "/v",
      "-mindepth",
      "1",
      "-printf",
      "%f\\n",
    );

    contents[volume.slice(`${project}_`.length)] = listing.split("\n").filter((l) => l.length > 0);
  }

  return contents;
}

/**
 * From a throwaway container on the wire network, as another machine there would, ask the
 * signer's TLS listener for `/healthz` with each client identity: a status code when a response
 * came back, the error code otherwise. The container trusts exactly the signer's certificate,
 * so a refusal is about the client, never the server.
 */
async function fromWire(): Promise<Record<string, number | string>> {
  const script = `
    const https = require("node:https");
    const fs = require("node:fs");
    const read = (file) => fs.readFileSync(file);
    const attempt = (client) => {
      const { promise, resolve } = Promise.withResolvers();
      const request = https.request({
        host: ${JSON.stringify(split.signerHost)},
        servername: ${JSON.stringify(split.signerHost)},
        port: 8787,
        path: "/healthz",
        ca: read("/certs/signer.crt"),
        minVersion: "TLSv1.3",
        timeout: 8000,
        ...client,
      }, (response) => { response.resume(); resolve(response.statusCode); });
      request.on("timeout", () => request.destroy(Object.assign(new Error("timeout"), { code: "timeout" })));
      request.on("error", (error) => resolve(error.code ?? error.message));
      request.end();
      return promise;
    };
    (async () => {
      const seen = {
        control: await attempt({ cert: read("/certs/control.crt"), key: read("/certs/control.key") }),
        none: await attempt({}),
        stranger: await attempt({ cert: read("/stranger/control.crt"), key: read("/stranger/control.key") }),
      };
      process.stdout.write(JSON.stringify(seen) + "\\n");
    })();`;

  const output = await docker(
    "run",
    "--rm",
    "--network",
    split.wire,
    "-v",
    `${join(split.dir, "certs")}:/certs:ro`,
    "-v",
    `${join(split.dir, "stranger")}:/stranger:ro`,
    HELPER_IMAGE,
    "node",
    "-e",
    script,
  );

  // Each attempt printed its status, or its error's code or message.
  return z
    .record(z.string(), z.union([z.number(), z.string()]))
    .parse(JSON.parse(output.trim().split("\n").at(-1) ?? "{}"));
}

/** From inside the signer container: the status of https://example.com/, or "unreachable". */
async function signerReachesInternet(): Promise<number | string> {
  const script = `fetch("https://example.com/", { signal: AbortSignal.timeout(6000) })
    .then((r) => r.status, () => "unreachable")
    .then((seen) => process.stdout.write(JSON.stringify({ seen }) + "\\n"));`;

  const output = await exec("signer", "node", "-e", script);
  // The script's last line, which it always prints.
  const line: { seen: number | string } = JSON.parse(output.trim().split("\n").at(-1) ?? "{}");

  return line.seen;
}

test("the control project holds no signer secret, no confirm secret and no vault, and runs no signer or confirmation page", async () => {
  const control = await servicesOf(stack.project);
  expect(control).toContain("server");
  expect(control).not.toContain("signer");
  expect(control).not.toContain("approve");
  // The confirmation page and the signer run in the other project, as on their own host.
  expect(await servicesOf(signerProject())).toEqual(expect.arrayContaining(["signer", "approve"]));

  const signerOnly = [
    "token-key",
    "vault-passphrase",
    "confirm-request-secret",
    "signer.sqlite",
    "vault",
    "signer.key",
    "approve.key",
  ];

  const held = await volumeContents(stack.project);
  // The server's volume holds what it needs to reach the signer, so the listing sees files.
  expect(held["server-secrets"]).toEqual(
    expect.arrayContaining(["signer-request-secret", "control.crt", "control.key", "signer.crt"]),
  );

  for (const [volume, names] of Object.entries(held)) {
    expect(
      names.filter((name) => signerOnly.includes(name)),
      volume,
    ).toEqual([]);
  }

  // The same listing finds them on the signer's side.
  const signerSide = await volumeContents(signerProject());
  expect(signerSide["signer-secrets"]).toEqual(
    expect.arrayContaining(["token-key", "vault-passphrase", "confirm-request-secret"]),
  );
  expect(signerSide["signer-data"]).toEqual(expect.arrayContaining(["signer.sqlite", "vault"]));
});

test("a container on the wire without the control plane's key cannot complete a handshake with the signer", async () => {
  const seen = await fromWire();
  // The control plane's certificate gets an answer: the signer is there to be reached.
  expect(seen.control).toBe(200);

  // No certificate, or one the signer does not trust: no HTTP response at all.
  for (const client of ["none", "stranger"]) {
    expect(seen[client], `${client}: ${seen[client]}`).toEqual(expect.any(String));
    expect(seen[client], client).not.toBe("timeout");
  }
});

test("the signer cannot reach https://example.com/ with the example nftables rules applied", async () => {
  // Without the rules its network has a route out, which is what the rules are for.
  expect(await signerReachesInternet()).toEqual(expect.any(Number));
  const rules = join(ROOT, "deploy", "split", "nftables-signer.conf");
  await run("sudo", ["-n", "nft", "-f", rules]);

  try {
    expect(await signerReachesInternet()).toBe("unreachable");
    // Connections to the signer still work: answers are not connections out.
    expect((await fromWire()).control).toBe(200);
  } finally {
    await run("sudo", ["-n", "nft", "delete", "table", "inet", "os_signer_host"]);
  }
});
