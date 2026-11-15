# ntfy sidecar

Forwards the control plane's notification webhook to a topic on an [ntfy](https://ntfy.sh)
server, so a phone with the ntfy app shows "Approval waiting" when a request waits. The control
plane holds no credential of ntfy's: the sidecar holds the webhook's signing secret and, for a
protected topic, an ntfy token. Any other channel (a chat bot, a pager) can be built the same way:
a small service next to the stack that verifies the webhook and talks to the outside service with
its own credential. The webhook's format is in
[`deploy/README.md`](../../deploy/README.md#notifications).

It needs nothing but Node: `node:http`, `node:crypto` and `fetch`.

## What a notification says

The whole text is fixed per event. Nothing from the delivery is published: no identifier, no
kind, no time.

| Event               | Text                                |
| ------------------- | ----------------------------------- |
| `approval.opened`   | `Approval waiting`                  |
| `approval.reminder` | `Approval expiring soon`            |
| `mandate.used`      | `Paid under an approval in advance` |

An event it does not know is answered 204 and not published.

With `NTFY_INCLUDE_LINK=1`, tapping the notification opens the delivery's link (ntfy's `Click`
header): the request's page in the control plane, or for `mandate.used` the mandate's page. The
link carries no token; opening it needs a passkey sign-in, and approving still happens only on the
signer's confirmation page. The sidecar passes on a link only when it is on `PUBLIC_ORIGIN`; a link
anywhere else is left out and the text published without it. Chat and mail apps often open links
in a browser of their own, where the person has no session and may have no passkey: open links in
the system browser, or leave them out (the default).

## What it checks

In this order, the way the deploy guide tells any receiver to
([`src/bridge.ts`](src/bridge.ts)):

1. A `POST` with a body of at most 16 KiB.
2. `x-os-timestamp` within 300 seconds of its own clock, before or after.
3. `x-os-signature` is `v1=` and the hex HMAC-SHA-256, under the secret, of the timestamp, a dot
   and the exact bytes of the body, compared in constant time.
4. The body is a JSON object with `"v": 1` and a `deliveryId` equal to `x-os-delivery` (that
   header is not signed; the body is).
5. A delivery id it published in the last 24 hours is answered 204 again and not published twice.
   Two attempts that arrive together are published once.

| Answer | When                                                                 | The control plane then |
| ------ | -------------------------------------------------------------------- | ---------------------- |
| 204    | Published, published before, or an event it does not know            | Marks it delivered     |
| 401    | No valid signature, or a timestamp more than 300 seconds away        | Gives up               |
| 400    | A signed body that is not a version 1 delivery under the header's id | Gives up               |
| 502    | ntfy refused it or did not answer within 5 seconds                   | Tries again later      |

The sidecar never retries on its own: answering 502 hands that to the control plane, which tries
again after 10, 20, 40 and so on up to 600 seconds, eight times. It logs one JSON line per
request other than a health check: the answer and a code, and once the signature verified the
delivery id and the event; never a body or a link.

## Run it next to the stack

From the repository root, with the stack's own `compose.yaml`:

    NTFY_URL=https://ntfy.example.com NTFY_TOPIC=approvals-<something long and random> \
      docker compose -f compose.yaml -f examples/ntfy-sidecar/compose.yaml up -d --build

The overlay ([`compose.yaml`](compose.yaml)) adds two services and points the server's
`NOTIFY_WEBHOOK_URL` at the sidecar. `ntfy-sidecar-init` runs on every start with no network: it
copies `notify-webhook-secret` from the server's secrets volume, and the token file if you name
one, into the sidecar's own volume, readable only by the sidecar's user. The sidecar never mounts
the server's volume. `ntfy-sidecar` runs read-only on the `control` network, where the server
reaches it and from which it reaches the ntfy server.

| Setting             | Meaning                                                                                                                                                     |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NTFY_URL`          | The ntfy server, `https://ntfy.sh` or your own; a path prefix is kept.                                                                                      |
| `NTFY_TOPIC`        | The topic, 1 to 64 letters, digits, `-` or `_`. On a server without access control anyone who knows the name can read it: make it long and random.          |
| `NTFY_TOKEN_FILE`   | A file on this host holding an ntfy access token (`tk_…`) for a protected topic; unset for none. Mode 0600 is fine: the init copies it as root.             |
| `NTFY_INCLUDE_LINK` | `1` to open the request's page when a notification is tapped; `0` or unset for no link.                                                                     |
| `PUBLIC_ORIGIN`     | The control plane's origin, the only one a link may point to. The overlay takes it from `.env`; with `compose.tls.yaml`, set it to `https://<OS_HOSTNAME>`. |

Inside the container the same names are read, with `NOTIFY_WEBHOOK_SECRET_FILE` and
`NTFY_TOKEN_FILE` naming files (an empty token file means no token) and `PORT` (default 8080). A
missing or wrong setting stops it at start with the setting's name.

To run it on another machine instead, build the image
(`docker build -f examples/ntfy-sidecar/Dockerfile -t os-ntfy-sidecar .`), give it a copy of the
secret (`docker compose exec server cat /run/secrets/server/notify-webhook-secret`), and set
`NOTIFY_WEBHOOK_URL` in the stack's `.env` to its address, over `https` when it crosses a network
you do not control.

## Who sees what

- **The ntfy server** you publish to sees the fixed text, the topic, the time and, with links on,
  the link, which holds the workspace's and the request's identifiers. If that is `ntfy.sh`, it is
  a third party.
- **iOS.** ntfy's iOS app is notified at once for a self-hosted server only when that server sets
  `upstream-base-url` (normally `https://ntfy.sh`). Then, for every message, the server also sends
  a `poll_request` carrying only the message's id to that upstream, which reaches the phone through
  Firebase and Apple's push service; the phone fetches the text from your server. The upstream,
  Google and Apple learn when a message arrives, not what it says (ntfy's
  [`server.yml`](https://github.com/binwiederhier/ntfy/blob/main/server/server.yml),
  `upstream-base-url`).
- **The sidecar's host** holds the webhook secret. Whoever has it can make the sidecar publish the
  fixed texts as often as they like, and nothing more.

A compromised control plane holds the secret too, so it can do the same: claim that something
waits, or stay silent. It cannot make the sidecar publish other text, or a link to another site.

## Limits

- Delivery ids are remembered in memory. After a restart, a retry of a delivery it had already
  published is published again.
- It shares the `control` network with Postgres, which asks for a password, and with Caddy.

## Files

| Path                         | What                                                                |
| ---------------------------- | ------------------------------------------------------------------- |
| `src/bridge.ts`              | Verification, dedupe and publishing                                 |
| `src/config.ts`              | Settings and the files they name                                    |
| `src/main.ts`                | Starts the server                                                   |
| `test/bridge.test.ts`        | Against a stand-in ntfy server: `bunx vitest run` in this directory |
| `compose.yaml`, `Dockerfile` | The overlay next to the stack, and the image                        |
