# CardMirror relay (self-hosting)

The server behind CardMirror's collaboration features — both **card
sharing** (store-and-forward mailbox) and **co-editing** (real-time
session rooms). Everything is **end-to-end encrypted by the app** —
this server only ever sees opaque ciphertext, a hashed routing code,
and timestamps. Mailbox messages are forgotten after 3 hours whether
or not they were delivered; co-editing rooms hold their (encrypted)
session log until the host ends the session or the room has been idle
for 7 days. New cards and session updates are live-pushed to connected
apps over SSE; the app also catches up by polling on every reconnect,
so nothing is lost while a machine is offline.

Run your own if you'd rather not use the official relay. Everyone
sharing cards with each other must point at the same relay — unless
you turn on **federation**, which lets your users share cards and
co-edit with users of other federating relays (see below).

## Quick start (docker compose)

```sh
cd relay
RELAY_TOKEN=$(openssl rand -hex 24) docker compose up -d
```

Then in CardMirror on every machine: **Settings → Collaboration** →
**Custom relay URL** = `http://<your-host>:8410/relay`, **Custom relay
token** = the same token. Use HTTPS (a reverse proxy such as Caddy or
your platform's TLS) for anything beyond a LAN.

## Running it elsewhere

Any host that runs a Python process + Postgres works (Railway, Fly,
a VPS…). Requirements:

- env `DATABASE_URL` (Postgres) and `RELAY_TOKEN` (any long random
  string — it's the shared bearer, not the privacy mechanism).
- **Exactly one worker process** (`uvicorn server:app`, no
  `--workers`): the live-push registry is in-process.
- Recommended: `--limit-concurrency 4096` (the Dockerfile sets this) as
  a connection-storm backstop. It counts long-lived SSE streams too, so
  keep it far above the number of apps you expect connected at once.
- Required: `--timeout-graceful-shutdown 5` (the Dockerfile sets this).
  Without it a stopped instance waits forever for its open SSE streams
  and lingers as an unbound zombie that keeps heartbeating old clients
  while the new instance owns the port — their live pushes then go
  nowhere until the clients notice on their own.
- The tables are created automatically on first start.

Health check: `GET /relay/health` → `{"ok": true}` (no auth).

## Federation (optional)

Off by default; with it off, nothing in this section exists and the
relay behaves exactly as before. To let your users work with users of
other relays:

```sh
RELAY_FEDERATION=on
RELAY_PUBLIC_URL=https://relay.example.org/relay   # exactly what your apps configure
RELAY_NICKNAME="Debate Club"                        # optional display name
```

- **Identity is the URL.** `RELAY_PUBLIC_URL` is how other relays and
  apps name this relay; it must be the public HTTPS base URL including
  `/relay`. Relays prove they own their URL to each other with a
  dialback (a relay hands its access token to whoever answers at the
  claimed URL), so there are no keys to exchange or configure.
- **Nicknames are display only.** Apps always show a nickname next to
  the URL's host, and never route or trust by it.
- **Who you federate with.** Open to any federating relay by default.
  Restrict with `RELAY_FEDERATION_ALLOW` (comma-separated peer URLs or
  host patterns like `*.example.org`) and/or `RELAY_FEDERATION_DENY`
  (always wins). Plain-`http` peers and peers on private/loopback
  addresses are refused unless `RELAY_FEDERATION_ALLOW_HTTP=1` /
  `RELAY_FEDERATION_ALLOW_PRIVATE=1` (for LAN or development setups).
- **Tailscale Funnel / overlay networks.** Relays on the same tailnet
  reach each other's `*.ts.net` names at tailnet (100.64.0.0/10)
  addresses, which the private-address guard refuses. Name your peers
  instead — `RELAY_FEDERATION_ALLOW=*.tailXXXX.ts.net` (peers named
  there skip the address check) — or set
  `RELAY_FEDERATION_ALLOW_PRIVATE=1`. Refusals are logged with the
  reason and the fix (`[fed] refused …`), and
  `GET /relay/federation/v1/peer?url=…` reports it as `refusal`.
- **Served under a path** (e.g. `https://host/cmrelay/relay`): set
  `RELAY_PUBLIC_URL` to that full URL. The proxy in front must strip
  its own prefix so the relay still sees `/relay/…`; check with
  `curl https://host/cmrelay/relay/health` → `{"ok": true}`.
- **Card sharing** across relays is store-and-forward: your relay
  queues the bundle and retries delivery with backoff; undelivered
  bundles expire after the same 3 hours as local mail.
- **Co-editing** across relays: a session lives only on the relay that
  created it. Remote participants reach it through their own relay
  (which proxies, holding no copy), and must be let in by someone on
  this relay — accept, accept read-only, or decline. They count toward
  the 10-participant cap and can't end the session.
- **Version flags.** Federating relays advertise `client.versionFlags`
  and read app versions like `1.15.0-f` (the flags never affect
  ordering, so `RELAY_MIN_CLIENT_VERSION` works unchanged). Apps send
  plain `1.15.0` to every other relay.
- Everything stays end-to-end encrypted. What federation adds to
  metadata: your relay learns which relay a user's correspondent is on,
  and a session's relay sees remote participants via their relay.

The protocol is specified in [FEDERATION.md](FEDERATION.md). Tests run
real relays against each other (Postgres via `RELAY_TEST_PG_URL`, or
`pip install pgserver`):

```sh
pip install -r requirements.txt pytest
python -m pytest tests -q                 # relay ↔ relay
python tests/run_client_federation.py     # the app against real relays
```

## Notes

- One `RELAY_TOKEN` covers both features — card sharing and co-editing
  sessions authenticate with the same shared bearer.
- Co-editing rooms: at most **10 people** per session (enforced at
  stream connect), 5 MB per update (the app chunks bigger ones),
  200 MB stored per room.
- Payload cap 25 MB decompressed / 30 MB gzipped per send.
- Poll returns at most 100 messages, oldest first; the app deletes
  each message after it lands.
- CardMirror also works against a relay without the `/stream`
  endpoint by falling back to interval polling — but this server
  includes push, so you get instant delivery.
- Plugin allowlist: clients pointed at this relay ask it which GitHub
  repos the in-app plugin installer may install from
  (`GET /relay/plugin-allowlist`, no auth — public data). Configure
  the list with `RELAY_PLUGIN_ALLOWLIST` (comma-separated
  `owner/repo`); it defaults to the app's built-in list, so leaving it
  alone changes nothing. Plugins run with full access to CardMirror
  and your users' documents — curate deliberately. Individual users
  who want arbitrary repos can instead run
  `__plugins('community-on')` in the app's console.
