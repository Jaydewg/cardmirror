# CardMirror relay federation — protocol v1

Federation lets a user on relay **A** share cards with, and co-edit
sessions alongside, a user on relay **B**. Each app still talks only to
its **own** relay with its own token; relays talk to each other.

Everything here is **additive and opt-in**:

- A relay federates only when its operator sets `RELAY_FEDERATION=on`
  and `RELAY_PUBLIC_URL`. Otherwise none of the routes, features, or
  capability fields below exist, and the relay behaves byte-for-byte as
  before for every client.
- An app federates only when its own relay advertises it. Against an
  older relay (no `/relay/capabilities`, or no `federation` block) a new
  app behaves exactly like the old one.
- Payloads stay end-to-end encrypted. Relays store and forward
  ciphertext; nothing in this protocol lets a relay read a card, an
  update, or a join request's contents.

## 1. Identity

**A relay's identity is its full public base URL** — the same URL its
apps are configured with, including the `/relay` path prefix:
`https://relay-a.example/relay`.

Canonical form (servers and clients canonicalize identically):

- scheme `https` (or `http` only where the operator allows it),
  lowercased; host lowercased; default port (`:443` / `:80`) dropped;
- no userinfo, query, or fragment; no trailing `/`;
- path kept as written (case-sensitive), `//` runs collapsed.

Two URLs name the same relay iff their canonical forms are equal. No
other comparison (host only, nickname, IP) is ever used.

**Nicknames.** `RELAY_NICKNAME` is a display label (≤ 48 chars, control
characters stripped). It is *shown, never accepted*: it never identifies,
routes, or authorizes anything, and clients always render it next to the
URL's host (`Debate Club (relay-b.example)`) so one relay cannot pass
itself off as another by nickname.

## 2. Codes and versions

### 2.1 Feature-flagged code prefixes

A code's prefix is `<kind><generation><flags>`: `cmk1`, `cmshare2`,
`cmshare2f`. The **generation** is the format upstream may bump
(`cmshare3`); **flags** are lowercase letters appended to it, each an
independent feature. `f` = federation (the code carries its home relay).
Parsers split the prefix with `^(cmk|cmshare)(\d+)([a-z]*)$` and handle
each part separately, so `cmshare3f` composes with no new grammar.

| Code | Format | Who reads it |
|---|---|---|
| pairing, local | `cmk1.<key>` | every build |
| pairing, federated | `cmk1f.<key>@<relay-url>` | federation builds |
| share, list room | `cmshare1.<roomId>.<key>` | every build |
| share, movable room | `cmshare2.<roomId>.<key>.<minVersion>` | ≥ 1.0.0 |
| share, federated | `cmshare<gen>f.<roomId>.<key>[.<minVersion>]@<relay-url>` | federation builds |

- The suffix after the **first** `@` is the canonical relay URL (no part
  before it can contain `@`).
- Older builds reject `f` codes cleanly at the prefix check ("that does
  not look like a share code") instead of misreading them.
- Federation builds still **mint the old codes by default**. The `f`
  forms are produced on request ("Copy cross-server code") and for
  mailbox invites to a recipient on another relay.
- A federated code whose relay is the reader's own relay is treated
  exactly as its plain form.

### 2.2 Version flags

App versions carry the same flags: `1.15.0-f`. The flag suffix is the
final `-<letters>` segment (not `alpha`/`beta`/`rc`), and it never takes
part in ordering: `1.15.0-f` == `1.15.0` for every floor and gate.

The `X-CardMirror-Version` header carries flags **only** to relays that
list the `client.versionFlags` feature. Every other relay (including all
older ones) receives the plain numeric version (`1.15.0`), which their
parsers and gates already understand.

## 3. Capabilities

A federating relay adds, to `GET /relay/capabilities`:

```json
"features": {
  "client.versionFlags": {},
  "federation.mailbox": {},
  "federation.rooms": {},
  "federation.joinRequests": {"modes": ["write", "read"]}
},
"federation": {
  "protocol": 1,
  "url": "https://relay-a.example/relay",
  "nickname": "Debate Club"
}
```

`nickname` is omitted when unset. `create_room` additionally returns
`"home": <url>`.

## 4. Relay-to-relay authentication (dialback)

Relays authenticate each other by **proving control of their URL**:

1. A → B `POST {B}/federation/v1/handshake` `{"origin": A, "nonce": n}`
2. B checks its peer policy, mints a random token `T`, and delivers it
   to the claimed origin: B → A
   `POST {A}/federation/v1/handshake/callback`
   `{"origin": B, "nonce": n, "token": T}`.
3. A accepts the callback only for a handshake it started (matching
   nonce and B), and stores `T`.
4. B answers step 1 with `200 {"ok": true}`.

Only whoever answers at A's URL ever receives `T`, so a request bearing
`T` comes from A. Each direction has its own token. Peer requests carry:

```
X-CardMirror-Peer:       https://relay-a.example/relay
X-CardMirror-Peer-Token: <T>
```

Refusals: `401 {"error":"peer-token-invalid"}` (handshake again, once),
`403 {"error":"peer-refused"}` (policy). Tokens persist across restarts.

**Peer policy** (operator): `RELAY_FEDERATION_ALLOW` / `_DENY` hold
comma-separated canonical URLs or host patterns (`*.example.org`); an
empty allow list means open federation. Plain-`http` peers and peers
resolving to private/loopback addresses are refused unless
`RELAY_FEDERATION_ALLOW_HTTP=1` / `RELAY_FEDERATION_ALLOW_PRIVATE=1`
(LAN and development setups).

**Peer info for apps.** `GET /relay/federation/v1/peer?url=<u>` (app
token) returns `{url, nickname, federates, reachable}` from the relay's
cache, so apps can label a remote relay without contacting it.

## 5. Card sharing (mailbox)

```
app ──POST /federation/v1/outbox──► A ──(queue, retry)──POST /federation/v1/inbox──► B ──stream/GET──► app
```

**App → own relay**: `POST /relay/federation/v1/outbox` with the same
body as `POST /relay/messages` plus `"recipientRelay": <url>`. A distinct
route on purpose: an older relay answers 404 rather than storing a
remote-addressed message in a local mailbox nobody reads.

| Response | Meaning |
|---|---|
| `202 {"msgId", "queued": true}` | accepted for delivery |
| `202 {"msgId", "queued": true, "peerState": "unreachable"}` | accepted, B unreachable right now (retried until the TTL) |
| `403 {"error":"peer-refused"}` | this relay does not federate with B |
| `409 {"error":"peer-not-federating"}` | B is reachable but does not federate |
| `413` | larger than B's published `maxMessageBytes` |

`recipientRelay` equal to the relay's own URL is delivered locally,
exactly like `/messages`.

**Relay → relay**: `POST {B}/federation/v1/inbox` (peer auth)
`{"originMsgId", "recipientCode", "body"}`. B stores `body` verbatim
under `recipientCode` (a bare routing id — B never forwards again, so
there are no loops), dedupes on `(origin, originMsgId)`, and pushes it to
live streams. Delivered messages gain one field, `"viaRelay": <A>`, the
relay-verified origin; apps trust it over any sender claim inside the
ciphertext.

Delivery is at-least-once with exponential backoff; permanent refusals
(400/413) drop the message; undelivered messages expire after A's
`messageTtlSeconds`, as undelivered local mail always has.

## 6. Co-editing (rooms)

Each room lives on exactly one **home** relay, which alone assigns seqs,
compacts, and tombstones. Remote participants reach it through their own
relay, which proxies:

```
app ──{own}/federation/v1/via/{home64}/rooms/{id}/…──► own relay ──{home}/federation/v1/rooms/{id}/…──► home relay
```

`home64` = base64url (no padding) of the home's canonical URL. The app
simply uses `{own}/federation/v1/via/{home64}` as its rooms base URL,
so every room call (updates, snapshot, presence, stream) is the
unchanged wire contract. Proxy responses carry
`X-CardMirror-Federation: 1` (exposed to CORS) so an app can tell a
relay's "no such route" 404 from a home relay's "no such room" 404.
Home unreachable → `503 {"error":"home-unreachable"}`.

### 6.1 Join requests (cross-server consent)

Participants on the home relay trust each other as before — a share
code is enough. **A participant from another relay must be accepted**:

1. Joiner → `POST …/rooms/{id}/join-requests`
   `{"pass": P, "blob": <room-key-sealed {name, …}>}`; `P` is a random
   secret the joiner mints (idempotent: resending the same `P` returns
   the same request). → `202 {"requestId", "state": "pending"}`.
2. The home relay pushes `{"t":"j"}` to its **local** room streams. Local
   participants list requests with `GET /relay/rooms/{id}/join-requests`
   (`origin`, `originNickname`, `blob`, `state`, `mode`) and decide with
   `POST /relay/rooms/{id}/join-requests/{requestId}`
   `{"decision": "write" | "read" | "deny" | "revoke"}`. Only local
   (app-token) callers can decide.
3. Joiner polls `GET …/rooms/{id}/join-requests/self` (pass header) →
   `{"state": "pending" | "approved" | "denied" | "expired", "mode"}`, or
   withdraws with `DELETE`.
4. Approved, the joiner sends `X-CardMirror-Room-Pass: P` on every room
   call. Before approval room calls answer
   `403 {"error":"join-pending"}`; after a denial or revocation
   `403 {"error":"join-denied"}`; writes (updates, snapshot) from a
   read-only participant `403 {"error":"read-only"}`. Presence is always
   allowed for approved participants. Remote participants can never
   delete (end) the room.
5. Access changes reach the remote stream live: `{"t":"a","mode":…}` on
   a mode change; `{"t":"x"}` then close on revocation.

Pending requests expire after `RELAY_FED_JOIN_REQUEST_TTL_SECONDS`
(24h); all of a room's requests are dropped with the room. A remote
participant's stream counts toward `maxStreamsPerRoom` like any other.

### 6.2 Frames on room streams (additive)

| Frame | To | Meaning |
|---|---|---|
| `{"t":"j"}` | local participants only | join requests changed — re-list |
| `{"t":"a","mode":"write"\|"read"}` | that remote participant | access changed live |
| `{"t":"x"}` | that remote participant | access revoked (or withdrawn); the stream closes |

Older apps ignore unknown frame types, and none of these reach them
unless a cross-server participant is involved.

## 7. Error codes

Every federation refusal is `{"error": <code>, "detail": <code>, …}`.

| Code | Status | From | Meaning |
|---|---|---|---|
| `peer-token-invalid` | 401 | any relay | handshake again (retried once automatically) |
| `peer-refused` | 403 | own / peer relay | policy: these relays don't federate |
| `peer-not-federating` | 409 | own relay (outbox) | destination doesn't federate |
| `too-large-for-peer` | 413 | own relay (outbox) | over the destination's `maxMessageBytes` |
| `home-is-self` / `bad-home` | 400 | own relay (proxy) | use the local routes / not a canonical URL |
| `home-not-federating` | 409 | own relay (proxy) | the room's home doesn't federate |
| `home-unreachable` | 503 | own relay (proxy) | transient — retry |
| `home-refused` | 403 | own relay (proxy) | the home refuses this relay |
| `pass-invalid` / `pass-conflict` | 401 / 409 | home relay | unknown pass / pass reused for another room |
| `join-pending` | 403 | home relay | not decided yet |
| `join-denied` | 403 | home relay | declined, revoked, withdrawn, or expired |
| `read-only` | 403 | home relay | write from a read-only participant |
| `too-many-join-requests` | 429 | home relay | room's pending-request cap |
| `peer-rate-limited` | 429 | any relay | per-peer request rate |

## 8. App rules (CardMirror)

- Only the app's OWN relay is ever contacted; foreign relays are named,
  never called (`GET /relay/federation/v1/peer` labels them).
- `f` codes are produced on request (and for mailbox invites to a
  recipient on another relay); plain codes stay the default.
- Identity is key **and** relay: a pairing key on another relay is a
  different contact. Received mail is attributed to `viaRelay`.
- A cross-server code naming the app's own relay behaves exactly like
  the plain code (no join request).
- Admissions persist per room (the pass), so a rejoin or resume needs no
  new approval; the home relay remains the enforcer.
- A relay whose route 404s without `X-CardMirror-Federation` "doesn't
  federate" — never "the session ended".

## 9. Compatibility matrix

| App ↓ / relay → | old relay | new relay, federation off | new relay, federation on |
|---|---|---|---|
| old app | unchanged | unchanged | unchanged (local only; never sees `f` codes from same-server peers) |
| new app | unchanged (no federation UI, plain version header) | unchanged | federation available |
