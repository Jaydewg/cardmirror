"""CardMirror card-sharing relay — standalone, self-hostable.

A content-agnostic store-and-forward mailbox with live push:

  POST   /relay/messages              store one addressed (encrypted) bundle
  GET    /relay/messages?recipient=   pull everything addressed to a code
  GET    /relay/stream?recipient=     SSE push: live-delivers new bundles
  DELETE /relay/messages/{msg_id}     acknowledge / remove one delivered bundle
  GET    /relay/health                liveness (no auth)
  GET    /relay/capabilities          limits, features, endpoints (no auth)

…plus durable ROOMS for collaboration sessions (opaque encrypted CRDT
update logs with server-assigned delivery cursors):

  POST   /relay/rooms                       create → {roomId, guestPass?, viewPass?}
  POST   /relay/rooms/{id}/updates          append opaque blob → {seq}
  GET    /relay/rooms/{id}/updates?after=N  snapshot (if N predates it) + tail
  GET    /relay/rooms/{id}/stream           SSE: hello{lastSeq, watchers}, update/presence/w frames
  POST   /relay/rooms/{id}/snapshot         {blob, coversThroughSeq} → truncates ≤ seq
  POST   /relay/rooms/{id}/presence         ephemeral fan-out, never stored
  DELETE /relay/rooms/{id}                  end session (tombstone → 410)
  GET    /relay/rooms/{id}/guest-pass       mint an edit pass (edit credentials)
  GET    /relay/rooms/{id}/view-pass        mint a view (spectator) pass (any credential)

…plus, only when the operator turns it on, FEDERATION with other relays
(card sharing and co-editing across servers; see FEDERATION.md for the
protocol and the "Federation" section below for the code):

  POST   /relay/federation/v1/outbox                  send a card to another relay's user
  GET    /relay/federation/v1/peer?url=               label/probe another relay (cached)
  *      /relay/federation/v1/via/{home}/rooms/{id}/… a room homed on another relay (proxied)
  GET    /relay/rooms/{id}/join-requests              cross-server join requests (local only)
  POST   /relay/rooms/{id}/join-requests/{reqId}      accept / accept read-only / decline
  (relay-to-relay: handshake, handshake/callback, inbox, rooms/{id}/…)

This is the same wire contract CardMirror's official relay speaks, so
pointing the app at your own deployment is just Settings → Card Sharing →
Custom relay URL + Custom relay token. Without federation, everyone
sharing cards with each other must use the same relay; with it, users on
federating relays reach each other.

Design notes:
  - Directed addressing: a sender POSTs to the recipient's routing code;
    the recipient receives only its own code and never sends to itself,
    so there is no self-echo.
  - Store-then-push: POST writes the row first (durability), then
    live-pushes to any open /relay/stream connections. Clients catch up
    via GET on every (re)connect, so delivery is at-least-once and the
    client's per-message dedupe absorbs overlap.
  - Messages are swept after 3 hours whether or not they were fetched
    (lazy expiry via a created_at cutoff on reads + a background sweeper).
  - The in-process push registry requires a SINGLE worker process (run
    plain `uvicorn`, no --workers).
  - DB-touching handlers are sync `def` on purpose: Starlette runs them
    in its threadpool, keeping the blocking psycopg2 driver off the
    event loop (which must stay free to serve SSE streams and accept
    connections). The pool is sized to the threadpool; exhaustion sheds
    as 503. Run uvicorn with `--limit-concurrency` sized WELL ABOVE the
    expected number of concurrent SSE streams (it counts long-lived
    connections) — e.g. 4096 — as a connection-storm backstop.

Rooms design notes:
  - `seq` is a delivery cursor, not a semantic order: CRDT updates are
    commutative, so the server only promises "give me everything after
    N" resumption. A global sequence shared across rooms is fine (gaps
    within a room are expected and harmless).
  - Compaction is the CLIENT's job (the server cannot read ciphertext):
    a client periodically uploads an encrypted snapshot covering
    everything through seq S; the server then deletes updates ≤ S.
    Joins fetch snapshot + tail, bounding join time on large docs.
  - Ended sessions tombstone (410, distinct from never-existed 404) so
    clients can tell "session over" from "bad room id". Idle rooms are
    garbage-collected after ROOM_IDLE_GC — generous by design: a
    session legitimately spans a travel day + tournament weekend with
    long fully-offline gaps.
  - At most MAX_STREAMS_PER_ROOM concurrent EDITOR streams per room
    (409 on the next), which is also the participant ceiling. Spectators
    (view passes) count against MAX_VIEWERS_PER_ROOM instead, and a
    refused editor's 409 carries a view pass ("watch instead").
  - Room passes: `guestPass` (edit) and `viewPass` (read-only) are
    bearer credentials for ONE room, accepted on that room's routes in
    place of RELAY_TOKEN (see "Room passes" below). They let someone
    without the relay token join from a link, and make spectating
    relay-enforced: a view pass can read and stream, never write.

PRIVACY: the card payload is end-to-end encrypted by the CardMirror
client. This server stores the bundle OPAQUELY (the `body` column) and
must never log or inspect it — only routing codes, ids, and counts are
ever touched here. Room update/snapshot/presence blobs are equally
opaque ciphertext: store, forward, count — never decode.

Env:
  RELAY_TOKEN    required — the shared bearer your CardMirror clients
                 configure as "Custom relay token".
  DATABASE_URL   required — Postgres, e.g.
                 postgresql://user:pass@localhost:5432/relay
  PORT           optional (default 8000; the Dockerfile wires this up).
  RELAY_<LIMIT>  optional — override any field of `Limits` (integer),
                 e.g. RELAY_MESSAGE_TTL_SECONDS=86400 or
                 RELAY_MAX_STREAMS_PER_ROOM=20. Published on
                 /relay/capabilities. (RELAY_MESSAGE_TTL_HOURS still works.)
  RELAY_CORS_ORIGINS  optional (default "*") — comma-separated allowed
                 origins for browser/PWA collab clients. "*" is safe
                 here (the auth is a bearer header, not a cookie).
  RELAY_GUEST_PASS optional (default on) — "0" / "off" turns room passes
                 off: no guest or view passes are minted or accepted,
                 so join links and spectating don't work.
  RELAY_PASS_SECRET optional — signing key for room passes. Defaults to
                 one derived from RELAY_TOKEN, so changing the token
                 also invalidates every outstanding pass.

Federation env (all optional; federation is OFF unless RELAY_FEDERATION
is on, and then nothing below changes behavior for non-federating apps):
  RELAY_FEDERATION        "on" to federate with other relays.
  RELAY_PUBLIC_URL        required with federation — this relay's full
                          public base URL, exactly as apps configure it,
                          e.g. https://relay.example.org/relay. It IS
                          this relay's identity to its peers.
  RELAY_NICKNAME          optional display name shown next to the URL's
                          host. Shown, never trusted or used to route.
  RELAY_FEDERATION_ALLOW  optional comma-separated peer URLs or host
                          patterns (*.example.org); empty = any relay.
  RELAY_FEDERATION_DENY   optional, same syntax; always wins.
  RELAY_FEDERATION_ALLOW_HTTP=1     accept plain-http peers (LAN / dev).
  RELAY_FEDERATION_ALLOW_PRIVATE=1  accept peers on private/loopback
                          addresses (LAN / dev).

See README.md for one-command deployment with docker compose.
"""
import asyncio
import base64
import fnmatch
import gzip
import hashlib
import hmac
import ipaddress
import json
import logging
import os
import random
import re
import secrets
import socket
import threading
import time
import uuid
import zlib
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from dataclasses import dataclass, field, fields
from datetime import datetime, timedelta, timezone
from typing import AsyncIterator, Optional
from urllib.parse import urlsplit

import anyio
import httpx
from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response, StreamingResponse
from fastapi.routing import APIRoute
from sqlalchemy import (
    BigInteger,
    Boolean,
    Column,
    DateTime,
    Index,
    Integer,
    String,
    Text,
    cast,
    create_engine,
    func,
    text,
)
from starlette.concurrency import run_in_threadpool
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.exc import IntegrityError
from sqlalchemy.exc import TimeoutError as SATimeoutError
from sqlalchemy.orm import Session, declarative_base, sessionmaker

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("relay")

# ── Storage ──────────────────────────────────────────────────────────

DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    raise RuntimeError("DATABASE_URL environment variable is required")
# requirements.txt ships psycopg2, but SQLAlchemy 2.1 maps a bare
# postgresql:// (and hosts' legacy postgres://) to psycopg 3 — a fresh
# install would fail to import a driver at startup. Name the driver we
# ship; an explicit +driver in the URL is left alone.
DATABASE_URL = re.sub(r"^postgres(?:ql)?://", "postgresql+psycopg2://", DATABASE_URL)

# Pool sized to Starlette's sync-handler threadpool (AnyIO default: 40
# tokens) so worker threads never convoy behind connection checkout. A
# short pool_timeout turns exhaustion into a clean 503 (see the
# TimeoutError handler below) instead of an unbounded queue.
engine = create_engine(
    DATABASE_URL,
    pool_pre_ping=True,
    pool_size=40,
    max_overflow=0,
    pool_timeout=5,
)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
Base = declarative_base()


class RelayMessage(Base):
    __tablename__ = "relay_messages"

    id = Column(String, primary_key=True)
    recipient_code = Column(String, nullable=False)
    body = Column(JSONB, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
    # Added later (see _migrate): retry dedupe + poll byte budgeting. NULL
    # on rows written before the upgrade; those expire within one TTL.
    body_hash = Column(String, nullable=True)
    body_bytes = Column(BigInteger, nullable=True)
    # Federation (see _migrate): set only on bundles another relay
    # delivered — the relay-verified sender relay, plus that relay's own
    # msgId for redelivery dedupe. NULL for every locally posted bundle.
    origin_relay = Column(String, nullable=True)
    origin_msg_id = Column(String, nullable=True)

    __table_args__ = (
        Index("ix_relay_messages_recipient_created", "recipient_code", "created_at"),
        Index("ix_relay_messages_recipient_hash", "recipient_code", "body_hash"),
    )


class RelayRoom(Base):
    __tablename__ = "relay_rooms"

    id = Column(String, primary_key=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    last_activity = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
    bytes_used = Column(BigInteger, default=0, nullable=False)
    tombstoned = Column(Boolean, default=False, nullable=False)


class RelayRoomUpdate(Base):
    __tablename__ = "relay_room_updates"

    # Global autoincrement doubles as the per-room delivery cursor (`seq`).
    # Gaps within a room are expected; clients only rely on "after N".
    id = Column(BigInteger, primary_key=True, autoincrement=True)
    room_id = Column(String, nullable=False)
    blob = Column(String, nullable=False)  # base64 ciphertext, opaque
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    __table_args__ = (
        Index("ix_relay_room_updates_room_id_id", "room_id", "id"),
    )


class RelayRoomSnapshot(Base):
    __tablename__ = "relay_room_snapshots"

    room_id = Column(String, primary_key=True)
    blob = Column(String, nullable=False)  # base64 ciphertext, opaque
    covers_through_seq = Column(BigInteger, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)


# Federation tables. create_all makes them on every start (empty and
# unused while federation is off — harmless, and turning it on later
# needs no migration step).


class RelayFedOutbox(Base):
    """Bundles this relay's apps addressed to a user on ANOTHER relay,
    awaiting delivery (store-and-forward, like the local mailbox)."""

    __tablename__ = "relay_fed_outbox"

    id = Column(String, primary_key=True)  # also the msgId the sender saw
    peer_url = Column(String, nullable=False)
    recipient_code = Column(String, nullable=False)
    body = Column(JSONB, nullable=False)
    body_hash = Column(String, nullable=False)
    body_bytes = Column(BigInteger, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
    next_attempt_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
    attempts = Column(Integer, default=0, nullable=False)
    last_error = Column(String, nullable=True)

    __table_args__ = (
        Index("ix_relay_fed_outbox_dedupe", "peer_url", "recipient_code", "body_hash"),
    )


class RelayFedToken(Base):
    """Dialback tokens (FEDERATION.md §4). direction 'out': a token a peer
    issued US (raw — we present it). direction 'in': a token we issued a
    peer (sha256 only — we just verify it)."""

    __tablename__ = "relay_fed_tokens"

    id = Column(String, primary_key=True)  # 'out:<peer>' or 'in:<sha256>'
    direction = Column(String, nullable=False)
    peer_url = Column(String, nullable=False, index=True)
    token = Column(String, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class RelayFedJoinRequest(Base):
    """A participant from another relay asking into a room homed here
    (FEDERATION.md §6.1). `blob` is room-key ciphertext from the joiner
    (their name etc.) — opaque here, like every other room blob."""

    __tablename__ = "relay_fed_join_requests"

    id = Column(String, primary_key=True)
    room_id = Column(String, nullable=False, index=True)
    origin_url = Column(String, nullable=False)
    pass_hash = Column(String, nullable=False, unique=True)
    blob = Column(Text, nullable=False)
    state = Column(String, nullable=False, default="pending")
    mode = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    decided_at = Column(DateTime, nullable=True)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# ── Limits / lifecycle ───────────────────────────────────────────────

def _public(name: str) -> dict:
    """Field metadata: publish on /relay/capabilities under this key.
    Opt-in — unmarked fields are never published. Public keys are a client
    contract: rename the Python field freely, never the public name."""
    return {"public": name}


def gunzip_bounded(raw: bytes, max_bytes: int) -> bytes:
    """Inflate `raw` but stop as soon as the output would exceed `max_bytes`.

    gzip.decompress() inflates the whole body before any size check runs, so a
    30 MiB upload could expand toward ~30 GiB (gzip's ~1032:1 ceiling) in
    process memory first. Streaming through zlib with a running cap bounds the
    memory a malicious body can take to max_bytes + one chunk.
    (Security report 2026-10-08.)
    """
    d = zlib.decompressobj(16 + zlib.MAX_WBITS)  # gzip framing
    out = bytearray()
    view = memoryview(raw)
    step = 256 * 1024
    for i in range(0, len(view), step):
        out += d.decompress(view[i:i + step], max_bytes + 1 - len(out))
        if len(out) > max_bytes:
            raise ValueError("decompressed payload too large")
        # Input the decompressor held back because of the output cap means
        # the body is bigger than allowed; don't keep feeding it.
        if d.unconsumed_tail:
            raise ValueError("decompressed payload too large")
    out += d.flush()
    if len(out) > max_bytes:
        raise ValueError("decompressed payload too large")
    return bytes(out)


@dataclass(frozen=True)
class Limits:
    """Every tunable limit, in one place. Handlers enforce these and
    /relay/capabilities publishes the same object, so the two cannot
    disagree. Each field can be overridden by env RELAY_<FIELD_NAME>
    (e.g. RELAY_MAX_STREAMS_PER_ROOM=20)."""

    # Mailbox (card sharing)
    max_message_bytes: int = field(default=25 * 1024 * 1024, metadata=_public("maxMessageBytes"))  # decompressed
    max_compressed_bytes: int = field(default=30 * 1024 * 1024, metadata=_public("maxCompressedBytes"))  # gzip-bomb guard
    # Undelivered bundles are swept after this. 3h matches the official
    # relay; self-hosters whose users go offline longer (closed laptops
    # between rounds, travel) can raise it — storage grows proportionally.
    message_ttl_seconds: int = field(default=3 * 3600, metadata=_public("messageTtlSeconds"))
    max_per_poll: int = field(default=100, metadata=_public("maxPerPoll"))
    max_poll_bytes: int = field(default=32 * 1024 * 1024, metadata=_public("maxPollBytes"))  # always ≥ 1 message

    # Streams
    heartbeat_seconds: int = field(default=25, metadata=_public("heartbeatSeconds"))
    stream_queue_max: int = 1000                       # frames buffered per SSE stream …
    stream_queue_max_bytes: int = 64 * 1024 * 1024     # … and bytes; overflow closes the stream

    # Rooms (collaboration sessions)
    max_update_bytes: int = field(default=5 * 1024 * 1024, metadata=_public("maxUpdateBytes"))  # chunked client-side above 256 KiB
    max_snapshot_bytes: int = field(default=40 * 1024 * 1024, metadata=_public("maxSnapshotBytes"))  # base64 chars
    max_presence_bytes: int = field(default=64 * 1024, metadata=_public("maxPresenceBytes"))
    room_cap_bytes: int = field(default=200 * 1024 * 1024, metadata=_public("roomCapBytes"))  # updates + snapshot, raw
    max_updates_per_page: int = field(default=200, metadata=_public("maxUpdatesPerPage"))
    max_page_bytes: int = field(default=32 * 1024 * 1024, metadata=_public("maxPageBytes"))  # base64 incl. snapshot; ≥ 1 update
    max_streams_per_room: int = field(default=30, metadata=_public("maxStreamsPerRoom"))  # editor ceiling
    max_viewers_per_room: int = field(default=100, metadata=_public("maxViewersPerRoom"))  # spectator ceiling
    room_pass_ttl_seconds: int = 7 * 86400              # guest / view pass lifetime
    # Must exceed travel day + tournament weekend.
    room_idle_gc_seconds: int = field(default=7 * 86400, metadata=_public("roomIdleGcSeconds"))

    # Federation (inert unless RELAY_FEDERATION is on). Not published
    # except the join-request lifetime, which apps show while waiting.
    fed_join_request_ttl_seconds: int = field(default=86400, metadata=_public("joinRequestTtlSeconds"))
    fed_join_requests_per_room: int = 20        # pending at once, per room
    fed_join_blob_bytes: int = 8 * 1024         # base64 chars of the joiner's sealed intro
    fed_max_upstreams_per_peer: int = 512       # proxied room streams open to one home relay
    fed_peer_requests_per_second: int = 200     # inbound, per peer relay (burst = 2x)
    fed_handshakes_per_minute: int = 10         # inbound, per claimed origin
    fed_peer_timeout_seconds: int = 15          # control calls to a peer
    fed_peer_bulk_timeout_seconds: int = 120    # update / snapshot bodies to a peer

    @property
    def message_ttl(self) -> timedelta:
        return timedelta(seconds=self.message_ttl_seconds)

    @property
    def room_idle_gc(self) -> timedelta:
        return timedelta(seconds=self.room_idle_gc_seconds)

    @classmethod
    def from_env(cls) -> "Limits":
        overrides: dict[str, int] = {}
        # Older name, kept working: RELAY_MESSAGE_TTL_HOURS.
        if "RELAY_MESSAGE_TTL_HOURS" in os.environ:
            overrides["message_ttl_seconds"] = int(float(os.environ["RELAY_MESSAGE_TTL_HOURS"]) * 3600)
        for f in fields(cls):
            var = f"RELAY_{f.name.upper()}"
            if var in os.environ:
                try:
                    overrides[f.name] = int(os.environ[var])
                except ValueError:
                    raise RuntimeError(f"{var} must be an integer, got {os.environ[var]!r}")
        bad = [k for k, v in overrides.items() if v <= 0]
        if bad:
            raise RuntimeError(f"limits must be positive: {', '.join(bad)}")
        return cls(**overrides)

    def public(self) -> dict:
        return {
            f.metadata["public"]: getattr(self, f.name)
            for f in fields(self)
            if "public" in f.metadata
        }


@dataclass(frozen=True)
class VersionGate:
    """OPT-IN minimum-client-version gate (see _min_version_gate). Read
    once at startup; the middleware and /relay/capabilities share it."""

    min_client_version: str = ""
    scope: str = "off"  # "off" | "rooms" | "all"

    @classmethod
    def from_env(cls) -> "VersionGate":
        return cls(
            min_client_version=os.getenv("RELAY_MIN_CLIENT_VERSION", "").strip(),
            scope=os.getenv("RELAY_MIN_VERSION_SCOPE", "off").strip().lower(),
        )

    @property
    def active(self) -> bool:
        # Unparseable floors fail open — and are advertised as off.
        return (
            self.scope in ("rooms", "all")
            and _parse_version(self.min_client_version) is not None
        )

    def public(self) -> dict:
        if not self.active:
            return {"minClientVersion": None, "scope": "off"}
        return {"minClientVersion": self.min_client_version, "scope": self.scope}


LIMITS = Limits.from_env()
VERSION_GATE = VersionGate.from_env()


# ── Federation config (FEDERATION.md) ────────────────────────────────


def canon_url(raw: object) -> Optional[str]:
    """Canonical relay URL (FEDERATION.md §1), or None if `raw` is not a
    usable relay URL. A relay's identity IS this string: two URLs name
    the same relay iff their canonical forms are equal. Mirrored by the
    app's `canonRelayUrl` — keep the two rules identical."""
    if not isinstance(raw, str):
        return None
    s = raw.strip()
    if not s or len(s) > 512 or any(c.isspace() or ord(c) < 32 for c in s) or "@" in s:
        return None
    try:
        p = urlsplit(s)
        port = p.port
    except ValueError:
        return None
    scheme = p.scheme.lower()
    if scheme not in ("https", "http") or p.query or p.fragment or not p.hostname:
        return None
    host = p.hostname.lower()
    if ":" in host:  # IPv6 literal
        host = f"[{host}]"
    default = 443 if scheme == "https" else 80
    netloc = host if port in (None, default) else f"{host}:{port}"
    path = re.sub(r"/{2,}", "/", p.path).rstrip("/")
    return f"{scheme}://{netloc}{path}"


def _url_host(url: str) -> str:
    return (urlsplit(url).hostname or "").lower()


@dataclass(frozen=True)
class FederationConfig:
    """Read once at startup. `enabled` False ⇒ no federation route,
    feature, or capability field exists (byte-identical to a relay
    without this code, for every client)."""

    enabled: bool = False
    url: str = ""
    nickname: str = ""
    allow: tuple = ()
    deny: tuple = ()
    allow_http: bool = False
    allow_private: bool = False

    @classmethod
    def from_env(cls) -> "FederationConfig":
        on = os.getenv("RELAY_FEDERATION", "").strip().lower() in ("1", "on", "true", "yes")
        if not on:
            return cls()
        allow_http = os.getenv("RELAY_FEDERATION_ALLOW_HTTP", "").strip() in ("1", "on", "true")
        url = canon_url(os.getenv("RELAY_PUBLIC_URL", ""))
        if not url:
            raise RuntimeError(
                "RELAY_FEDERATION is on but RELAY_PUBLIC_URL is missing or not a valid "
                "http(s) URL (it must be this relay's public base URL, e.g. "
                "https://relay.example.org/relay)"
            )
        if url.startswith("http://") and not allow_http:
            raise RuntimeError(
                "RELAY_PUBLIC_URL is plain http — use https, or set "
                "RELAY_FEDERATION_ALLOW_HTTP=1 for a LAN / development federation"
            )
        nick = "".join(c for c in os.getenv("RELAY_NICKNAME", "") if c.isprintable()).strip()[:48]

        def patterns(var: str) -> tuple:
            out = []
            for item in os.getenv(var, "").split(","):
                item = item.strip()
                if not item:
                    continue
                out.append(canon_url(item) if "://" in item else item.lower())
            return tuple(p for p in out if p)

        return cls(
            enabled=True,
            url=url,
            nickname=nick,
            allow=patterns("RELAY_FEDERATION_ALLOW"),
            deny=patterns("RELAY_FEDERATION_DENY"),
            allow_http=allow_http,
            allow_private=os.getenv("RELAY_FEDERATION_ALLOW_PRIVATE", "").strip() in ("1", "on", "true"),
        )

    @staticmethod
    def _matches(url: str, pats: tuple) -> bool:
        host = _url_host(url)
        for p in pats:
            if "://" in p:
                if url == p:
                    return True
            elif fnmatch.fnmatchcase(host, p):
                return True
        return False

    def permits(self, peer_url: str) -> bool:
        """Static policy only (scheme, lists). Address checks — private
        ranges — need DNS and live in _peer_address_ok."""
        if not self.enabled or not peer_url or peer_url == self.url:
            return False
        if peer_url.startswith("http://") and not self.allow_http:
            return False
        if self._matches(peer_url, self.deny):
            return False
        return not self.allow or self._matches(peer_url, self.allow)


FEDERATION = FederationConfig.from_env()


# Feature registry for /relay/capabilities. Call feature() NEXT TO the
# code that implements a feature, so deleting or disabling the code drops
# the flag with it. Clients treat a listed feature as supported and an
# absent one as unsupported (which is also what every older relay, with
# no capabilities endpoint at all, means).
_FEATURES: dict[str, dict] = {}


def feature(name: str, **meta) -> None:
    _FEATURES[name] = meta


def _sse(obj: dict) -> str:
    """One SSE data frame. Serialized once per push, not once per stream."""
    return f"data: {json.dumps(obj, separators=(',', ':'))}\n\n"


_END_FRAME = _sse({"t": "end"})
# Federation: a remote participant's access was revoked — sent only to
# that participant's proxied stream, which then closes (like end, but
# the room lives on for everyone else).
_REVOKED_FRAME = _sse({"t": "x"})
# Cross-server join requests changed — sent only to LOCAL streams (only
# local participants may decide); a nudge to re-list, carrying nothing.
_JOIN_FRAME = _sse({"t": "j"})


feature("streams.closeOnOverflow")


class _Outbox:
    """Per-stream buffer of serialized SSE frames, bounded by count AND
    bytes (a stalled client on bad wifi previously pinned up to 100 full
    payloads in memory).

    On overflow the stream is CLOSED rather than a frame silently dropped:
    room seqs have gaps by design, so a client cannot detect a missing
    frame — but every client already treats a closed stream as
    "reconnect, then catch up via GET", which recovers exactly what was
    missed. Droppable frames (presence) are shed instead, since there is
    nothing to recover. Loop-owned, like the registries below."""

    __slots__ = ("_frames", "_bytes", "_wake", "overflowed", "fed_request", "viewer", "gone")

    def __init__(self, fed_request: Optional[str] = None, viewer: bool = False) -> None:
        self._frames: deque[str] = deque()
        self._bytes = 0
        self._wake = asyncio.Event()
        self.overflowed = False
        # Room streams only: the join-request id when this stream is a
        # remote participant's (proxied by their relay); None = local.
        self.fed_request = fed_request
        # Room streams only: a spectator's (view pass). Counts against the
        # viewer cap, not the editor cap, and toward the watcher count.
        self.viewer = viewer
        # The client went away (see _close_on_disconnect); get() returns.
        self.gone = False

    def close(self) -> None:
        self.gone = True
        self._wake.set()

    def put(self, frame: str, droppable: bool = False) -> None:
        if self.overflowed:
            return
        if len(self._frames) >= LIMITS.stream_queue_max or self._bytes + len(frame) > LIMITS.stream_queue_max_bytes:
            if droppable:
                return
            self.overflowed = True
            self._frames.clear()
            self._bytes = 0
        else:
            self._frames.append(frame)
            self._bytes += len(frame)
        self._wake.set()

    async def get(self, timeout: float) -> Optional[str]:
        """Next frame, or None on timeout / overflow / close (check
        `overflowed` and `gone`)."""
        if self.gone:
            return None
        if not self._frames:
            self._wake.clear()
            try:
                await asyncio.wait_for(self._wake.wait(), timeout)
            except asyncio.TimeoutError:
                return None
        if not self._frames:
            return None
        frame = self._frames.popleft()
        self._bytes -= len(frame)
        return frame


# routing code → open stream outboxes (single-worker only; see module doc)
_streams: dict[str, set[_Outbox]] = {}

# The server's one event loop, captured at startup. Sync (threadpool)
# handlers must never touch _streams or its outboxes directly — they are
# loop-owned and not thread-safe. All push fan-out is scheduled onto the
# loop via call_soon_threadsafe(_push_to_streams, …).
_loop: Optional[asyncio.AbstractEventLoop] = None


def _push_to_streams(recipient: str, frame: str) -> None:
    """Runs ON the event loop."""
    for box in list(_streams.get(recipient, ())):
        box.put(frame)


# room id → {outbox: sid}. sid = client-minted stream nonce (?sid= at
# connect); presence POSTs carrying ?from=<same nonce> skip that stream
# (no self-echo). No sid = never skipped (old clients unchanged).
_room_streams: dict[str, dict[_Outbox, Optional[str]]] = {}


def _push_to_room(
    room_id: str,
    frame: str,
    skip_sid: Optional[str] = None,
    droppable: bool = False,
    local_only: bool = False,
) -> None:
    """Runs ON the loop. `skip_sid` (presence only): no self-echo to the
    sender's stream. `local_only`: skip remote participants' streams."""
    for box, sid in list(_room_streams.get(room_id, {}).items()):
        if skip_sid is not None and sid == skip_sid:
            continue
        if local_only and box.fed_request is not None:
            continue
        box.put(frame, droppable=droppable)


def _push_to_request(room_id: str, request_id: str, frame: str) -> None:
    """Runs ON the loop: one remote participant's proxied stream(s)."""
    for box in list(_room_streams.get(room_id, {})):
        if box.fed_request == request_id:
            box.put(frame)


def _drop_room_stream(room_id: str, box: _Outbox) -> None:
    peers = _room_streams.get(room_id)
    if peers is not None:
        peers.pop(box, None)
        if not peers:
            _room_streams.pop(room_id, None)


async def _close_on_disconnect(request: Request, box: _Outbox) -> None:
    """Close `box` the moment its client disconnects. Starlette's
    StreamingResponse only notices a dropped client on its next write —
    up to a heartbeat later — which kept a departed spectator in the
    watcher count, and a departed editor in its seat, for ~25 s."""
    try:
        while (await request.receive())["type"] != "http.disconnect":
            pass
    except Exception:
        pass
    box.close()


def _watcher_count(room_id: str) -> int:
    """Spectator streams open in a room. Runs ON the loop."""
    return sum(1 for box in _room_streams.get(room_id, {}) if box.viewer)


def _announce_watchers(room_id: str) -> None:
    """Runs ON the loop: tell every stream in the room how many are
    watching (`w` frame), after a spectator connects or leaves."""
    _push_to_room(room_id, _sse({"t": "w", "n": _watcher_count(room_id)}))


# Per-room write serialization. Room writes (append / snapshot / delete)
# hold this across commit AND push scheduling, so for any one room:
#   - seqs become visible in seq order. Without it, update 100 could
#     commit after 101; a client resuming with after=101 would never see
#     100, and a snapshot covering 101 would then delete it unmerged.
#   - live frames are scheduled in seq order too.
# Taken BEFORE the first query, so waiters do not hold pool connections.
# Striped (fixed array, no per-room cleanup); SELECT … FOR UPDATE on the
# room row backs it up at the DB level.
_ROOM_LOCKS = [threading.Lock() for _ in range(256)]


def _room_lock(room_id: str) -> threading.Lock:
    return _ROOM_LOCKS[hash(room_id) % len(_ROOM_LOCKS)]


def _sweep(db: Session) -> int:
    cutoff = datetime.utcnow() - LIMITS.message_ttl
    removed = (
        db.query(RelayMessage)
        .filter(RelayMessage.created_at < cutoff)
        .delete(synchronize_session=False)
    )
    # Room GC: idle rooms tombstone (clients see 410 "session ended");
    # tombstones past a second idle period are dropped entirely.
    idle_cutoff = datetime.utcnow() - LIMITS.room_idle_gc
    # FOR UPDATE: a room written to right now is either skipped (locked)
    # or re-checked against its fresh last_activity — never GC'd from a
    # stale read.
    idle = (
        db.query(RelayRoom)
        .filter(RelayRoom.last_activity < idle_cutoff)
        .with_for_update(skip_locked=True)
        .all()
    )
    ended = []
    for room in idle:
        db.query(RelayRoomUpdate).filter(RelayRoomUpdate.room_id == room.id).delete(
            synchronize_session=False
        )
        db.query(RelayRoomSnapshot).filter(RelayRoomSnapshot.room_id == room.id).delete(
            synchronize_session=False
        )
        # A room's cross-server admissions die with it (ended or dropped).
        db.query(RelayFedJoinRequest).filter(RelayFedJoinRequest.room_id == room.id).delete(
            synchronize_session=False
        )
        if room.tombstoned:
            db.delete(room)
        else:
            room.tombstoned = True
            room.bytes_used = 0
            ended.append(room.id)
    # Federation: undelivered cross-relay mail expires on the same TTL as
    # local mail; unanswered join requests expire (the joiner sees
    # "expired" and can ask again).
    expired_out = (
        db.query(RelayFedOutbox)
        .filter(RelayFedOutbox.created_at < cutoff)
        .delete(synchronize_session=False)
    )
    stale_filter = (
        RelayFedJoinRequest.state == "pending",
        RelayFedJoinRequest.created_at
        < datetime.utcnow() - timedelta(seconds=LIMITS.fed_join_request_ttl_seconds),
    )
    stale_rooms = {
        r for (r,) in db.query(RelayFedJoinRequest.room_id).filter(*stale_filter).distinct().all()
    }
    if stale_rooms:
        db.query(RelayFedJoinRequest).filter(*stale_filter).update(
            {"state": "expired", "decided_at": datetime.utcnow()}, synchronize_session=False
        )
    db.commit()
    if expired_out:
        logger.info("[fed] expired %d undelivered outbox message(s)", expired_out)
    if stale_rooms or idle:
        _pass_cache_clear()
    # Same signal as DELETE: anyone still connected learns the session ended.
    if _loop is not None:
        for room_id in ended:
            _loop.call_soon_threadsafe(_push_to_room, room_id, _END_FRAME)
        # Local participants re-list (the expired rows drop out).
        for room_id in stale_rooms:
            _loop.call_soon_threadsafe(_push_to_room, room_id, _JOIN_FRAME, None, False, True)
    return removed


def _sweeper_loop() -> None:
    while True:
        time.sleep(300)
        db = SessionLocal()
        try:
            removed = _sweep(db)
            if removed:
                logger.info("[relay] swept %d expired message(s)", removed)
        except Exception as e:  # never let the sweeper kill the thread
            logger.warning("[relay] sweep error: %s", e)
        finally:
            db.close()


def _migrate() -> None:
    """create_all never alters existing tables; add later columns in place.
    Idempotent (no-ops on a fresh DB, where create_all already made them)."""
    with engine.begin() as conn:
        conn.execute(text("ALTER TABLE relay_messages ADD COLUMN IF NOT EXISTS body_hash VARCHAR"))
        conn.execute(text("ALTER TABLE relay_messages ADD COLUMN IF NOT EXISTS body_bytes BIGINT"))
        conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_relay_messages_recipient_hash "
            "ON relay_messages (recipient_code, body_hash)"
        ))
        # Federation: inbound redelivery dedupe (a peer retrying after a
        # lost 202 must not create a second row).
        conn.execute(text("ALTER TABLE relay_messages ADD COLUMN IF NOT EXISTS origin_relay VARCHAR"))
        conn.execute(text("ALTER TABLE relay_messages ADD COLUMN IF NOT EXISTS origin_msg_id VARCHAR"))
        conn.execute(text(
            "CREATE UNIQUE INDEX IF NOT EXISTS ux_relay_messages_origin "
            "ON relay_messages (origin_relay, origin_msg_id) WHERE origin_relay IS NOT NULL"
        ))


@asynccontextmanager
async def _lifespan(_app: FastAPI):
    global _loop
    _loop = asyncio.get_running_loop()
    Base.metadata.create_all(engine)
    _migrate()
    _build_capabilities()
    threading.Thread(target=_sweeper_loop, daemon=True).start()
    if FEDERATION.enabled:
        _federation_start()
    try:
        yield
    finally:
        if FEDERATION.enabled:
            await _federation_stop()


app = FastAPI(title="CardMirror relay", lifespan=_lifespan)

# CORS: collaboration sessions are driven from the browser/renderer via
# `fetch` (the mailbox card-sharing path runs in Electron's main process,
# which is not a browser and never triggers CORS — hence this was not
# needed before). A web/PWA client at a different origin needs the relay
# to answer CORS preflights. The bearer token is a header, not a cookie,
# so credential-less "*" is safe; lock it down with RELAY_CORS_ORIGINS
# (comma-separated) when serving a known front end.
_cors = os.getenv("RELAY_CORS_ORIGINS", "*").strip()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"] if _cors == "*" else [o.strip() for o in _cors.split(",") if o.strip()],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
    # Lets browser apps tell a proxied (federated) response from a
    # relay's own route-missing 404 (FEDERATION.md §6).
    expose_headers=["X-CardMirror-Federation"] if FEDERATION.enabled else (),
)


@app.exception_handler(SATimeoutError)
async def _pool_exhausted(_request: Request, _exc: SATimeoutError) -> JSONResponse:
    # Connection-pool checkout timed out: the server is at capacity.
    # Shed with a clean 503 — clients retry (send is user-driven; polls
    # retry next interval; streams reconnect with backoff).
    return JSONResponse({"detail": "relay busy, retry shortly"}, status_code=503)


# ── Auth ─────────────────────────────────────────────────────────────


_VER_RE = re.compile(r"^(\d+)\.(\d+)(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$")
_PRE_RANK = {"alpha": 0, "beta": 1, "rc": 2}
_FLAGS_RE = re.compile(r"^(.+)-([a-z]{1,8})$")


def split_version_flags(s: str) -> tuple[str, frozenset]:
    """'1.15.0-f' → ('1.15.0', {'f'}). Feature flags (FEDERATION.md §2.2)
    are the final `-<letters>` segment — never `alpha`/`beta`/`rc`,
    which are prereleases — and take no part in ordering. Mirrors the
    app's `splitVersionFlags`."""
    s = s.strip()
    m = _FLAGS_RE.match(s)
    if m and m.group(2) not in _PRE_RANK:
        return m.group(1), frozenset(m.group(2))
    return s, frozenset()


def _parse_version(s: str):
    """Prerelease-aware key for CardMirror's version shapes, or None.
    Flags are stripped first (1.15.0-f orders as 1.15.0), and a two-part
    core reads as .0 (1.15 == 1.15.0)."""
    m = _VER_RE.match(split_version_flags(s)[0])
    if not m:
        return None
    core = (int(m.group(1)), int(m.group(2)), int(m.group(3) or 0))
    pre = m.group(4)
    if pre is None:
        return core + (1, 0, 0)
    parts = pre.split(".")
    rank = _PRE_RANK.get(parts[0].lower(), 1)
    num = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 0
    return core + (0, rank, num)


@app.middleware("http")
async def _min_version_gate(request, call_next):
    """OPT-IN minimum-client-version gate (mirrors the official relay's).

    Dormant unless BOTH env vars are set:
      RELAY_MIN_CLIENT_VERSION  e.g. "1.0.0"
      RELAY_MIN_VERSION_SCOPE   "rooms" (block room CREATION only) or
                                "all" (rooms + mailbox)

    Clients >= 0.1.0-beta.32 send X-CardMirror-Version; older builds
    send nothing and read as below any floor. Refusals are 426. This
    runs before token auth (it is a middleware), which is acceptable
    for an opt-in self-hosted policy knob; the official relay checks
    auth first. Unparseable floors fail open.
    """
    if VERSION_GATE.active:
        floor_s, scope = VERSION_GATE.min_client_version, VERSION_GATE.scope
        path, method = request.url.path, request.method
        gated = path == "/relay/rooms" and method == "POST"
        if not gated and scope == "all":
            gated = (
                path.startswith("/relay/rooms/")
                or path == "/relay/messages"
                or path.startswith("/relay/messages/")
                or path == "/relay/stream"
                # Federation routes an APP drives (directly, or proxied
                # by its relay, which forwards the app's version header).
                # Relay-to-relay plumbing (handshake, inbox) carries no
                # app version and is never gated.
                or path == "/relay/federation/v1/outbox"
                or path.startswith("/relay/federation/v1/via/")
                or path.startswith("/relay/federation/v1/rooms/")
            )
        if gated:
            floor = _parse_version(floor_s)
            got = _parse_version(request.headers.get("x-cardmirror-version", ""))
            if got is None or got < floor:
                return JSONResponse(
                    {"detail": {"error": "update-required", "minVersion": floor_s}},
                    status_code=426,
                )
    return await call_next(request)


def require_relay_token(authorization: Optional[str] = Header(None)) -> None:
    """Shared bearer token. This stops the relay being an open public
    service; it is NOT the privacy mechanism (payloads are end-to-end
    encrypted, and the per-recipient routing code is the isolation
    boundary)."""
    expected = os.getenv("RELAY_TOKEN", "")
    if not expected:
        raise HTTPException(500, "RELAY_TOKEN not configured on server")
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Missing bearer token")
    if not hmac.compare_digest(authorization[len("Bearer "):], expected): #hmac.compare_digest used to defend against timing-based attacks
        raise HTTPException(401, "Invalid relay token")


# ── Room passes (guest + view) ──
#
# A room pass is a bearer credential for ONE room, accepted on that
# room's routes in place of RELAY_TOKEN:
#   guest (`g`) — edits: everything an app with the relay token may do in
#                 the room except deciding cross-server join requests;
#   view  (`v`) — spectates: reads and streams; every write is 403. Its
#                 stream counts against the viewer cap and the watcher
#                 count, and its presence frames reach others stamped
#                 `"v":1` so they can tell a spectator from an editor.
# Stateless: `cmrp1.<roomId>.<g|v>.<expiry epoch s>.<hmac>`, signed with
# RELAY_PASS_SECRET or a key derived from RELAY_TOKEN, so nothing is
# stored and a token change revokes every pass. Expiry is fixed at mint
# (room_pass_ttl_seconds); a tombstoned or deleted room refuses passes
# the same way it refuses the relay token (410 / 404).

ROOM_PASSES = os.getenv("RELAY_GUEST_PASS", "").strip().lower() not in ("0", "false", "off", "no")
_PASS_PREFIX = "cmrp1"
_PASS_ROLES = {"g": "guest", "v": "view"}


def _pass_key() -> bytes:
    secret = os.getenv("RELAY_PASS_SECRET", "") or os.getenv("RELAY_TOKEN", "")
    return hmac.new(secret.encode(), b"cardmirror room pass v1", hashlib.sha256).digest()


def _pass_sig(body: str) -> str:
    mac = hmac.new(_pass_key(), body.encode(), hashlib.sha256).digest()[:24]
    return base64.urlsafe_b64encode(mac).decode("ascii").rstrip("=")


def mint_room_pass(room_id: str, role: str, now: Optional[float] = None) -> str:
    """`role`: "g" (guest / edit) or "v" (view)."""
    exp = int((time.time() if now is None else now) + LIMITS.room_pass_ttl_seconds)
    body = f"{_PASS_PREFIX}.{room_id}.{role}.{exp}"
    return f"{body}.{_pass_sig(body)}"


def parse_room_pass(token: str, now: Optional[float] = None) -> Optional[tuple[str, str]]:
    """(room_id, "guest" | "view") for a valid, unexpired pass, else None."""
    parts = token.split(".")
    if len(parts) != 5 or parts[0] != _PASS_PREFIX or parts[2] not in _PASS_ROLES:
        return None
    body = ".".join(parts[:4])
    if not hmac.compare_digest(parts[4], _pass_sig(body)):
        return None
    try:
        exp = int(parts[3])
    except ValueError:
        return None
    if exp < (time.time() if now is None else now):
        return None
    return parts[1], _PASS_ROLES[parts[2]]


@dataclass(frozen=True)
class RoomCred:
    """Who is calling a room route: the relay token, or a pass for it."""

    kind: str  # "relay" | "guest" | "view"

    @property
    def viewer(self) -> bool:
        return self.kind == "view"


def room_auth(room_id: str, authorization: Optional[str] = Header(None)) -> RoomCred:
    """Room routes: the relay token, or a pass for THIS room (a pass for
    any other room is 401, exactly like a wrong token)."""
    expected = os.getenv("RELAY_TOKEN", "")
    if not expected:
        raise HTTPException(500, "RELAY_TOKEN not configured on server")
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Missing bearer token")
    token = authorization[len("Bearer "):]
    if hmac.compare_digest(token, expected):
        return RoomCred("relay")
    if ROOM_PASSES:
        parsed = parse_room_pass(token)
        if parsed is not None and parsed[0] == room_id:
            return RoomCred(parsed[1])
    raise HTTPException(401, "Invalid relay token")


def room_write_auth(cred: RoomCred = Depends(room_auth)) -> RoomCred:
    """Room writes: a view pass is refused (403), every edit credential
    passes."""
    if cred.viewer:
        raise HTTPException(403, "view-only")
    return cred


if ROOM_PASSES:
    feature("rooms.guestPasses")
    feature("rooms.viewPasses")
    # Spectators may post presence (that they're here — the app sends no
    # cursor for them); upstream's relay refuses it (403). Additive: an
    # app only posts it where this is listed.
    feature("rooms.spectatorPresence")


def _epoch_ms(dt: datetime) -> int:
    return int(dt.replace(tzinfo=timezone.utc).timestamp() * 1000)


# ── Routes ───────────────────────────────────────────────────────────

# Health page, fixed status
@app.get("/relay/health")
def relay_health() -> dict:
    return {"ok": True}

# Capabilities: what THIS relay supports and is configured with, for
# clients to adapt to (and for operators to inspect). Public like /health.
# Nothing here is hand-listed: limits come from LIMITS, the gate from
# VERSION_GATE, features from feature() calls beside their code, and
# endpoints from the route table. Built once at startup (_lifespan),
# after every route and feature has registered, since all of it is fixed
# for the life of the process. Describes configuration, never live state
# — that is /relay/health.
_capabilities: dict = {}
_capabilities_etag = ""


def _endpoints() -> list[dict]:
    methods: dict[str, set[str]] = {}
    for r in app.routes:
        if isinstance(r, APIRoute) and r.path.startswith("/relay/"):
            methods.setdefault(r.path, set()).update(r.methods - {"HEAD", "OPTIONS"})
    return [{"path": p, "methods": sorted(m)} for p, m in sorted(methods.items())]


def _build_capabilities() -> None:
    global _capabilities_etag
    _capabilities.clear()
    _capabilities.update(
        schema=1,
        limits=LIMITS.public(),
        versionGate=VERSION_GATE.public(),
        features=dict(sorted(_FEATURES.items())),
        endpoints=_endpoints(),
    )
    if FEDERATION.enabled:
        # Absent entirely when off, so a non-federating relay's document
        # (and ETag) is unchanged by this code existing.
        _capabilities["federation"] = {
            "protocol": FED_PROTOCOL,
            "url": FEDERATION.url,
            **({"nickname": FEDERATION.nickname} if FEDERATION.nickname else {}),
        }
    digest = hashlib.sha256(json.dumps(_capabilities, sort_keys=True).encode()).hexdigest()
    _capabilities_etag = f'"{digest[:16]}"'


@app.get("/relay/capabilities")
def relay_capabilities(request: Request) -> Response:
    headers = {"Cache-Control": "public, max-age=300", "ETag": _capabilities_etag}
    if request.headers.get("if-none-match") == _capabilities_etag:
        return Response(status_code=304, headers=headers)
    return JSONResponse(_capabilities, headers=headers)


# Plugin-install allowlist for CardMirror clients pointed at THIS relay
# (the client fetches it from whichever relay it is configured to use).
# Ungated like /health — it is public data, and the OPERATOR of a
# self-hosted relay is the right party to curate what their users'
# installers accept (plugins are full-trust code). Configure with
# RELAY_PLUGIN_ALLOWLIST (comma-separated owner/repo); the default
# matches the app's baked floor. Individuals who want arbitrary repos
# use the in-app console unlock instead: __plugins('community-on').
_DEFAULT_PLUGIN_ALLOWLIST = "shreerammodi/ebb,shreerammodi/cardmirror-ebb-plugin"


@app.get("/relay/plugin-allowlist")
def plugin_allowlist() -> dict:
    raw = os.getenv("RELAY_PLUGIN_ALLOWLIST", _DEFAULT_PLUGIN_ALLOWLIST)
    repos = sorted({r.strip().lower() for r in raw.split(",") if r.strip()})
    return {"schema": 1, "repos": repos}


async def _raw_body(request: Request) -> bytes:
    """Reads the request body on the event loop (a sync handler cannot
    await); everything after this runs on a worker thread."""
    return await request.body()


feature("mailbox.gzipUpload")
feature("mailbox.retryDedupe")


# Deliberately a sync `def`: Starlette runs it in the threadpool, so the
# blocking psycopg2 commit never executes on the event loop. Under
# sustained load the loop previously convoyed and stopped reading new
# connections entirely (permanent accept-path stall at ~200 msg/s,
# CPU idle); threadpool execution + the pool sizing above removes the
# failure mode — overload now degrades to clean 503s instead.
def _decode_message_body(raw: bytes, content_encoding: Optional[str]) -> tuple[dict, bytes]:
    """Size-check, gunzip, and parse a mailbox-shaped JSON body →
    (payload, decompressed bytes). Shared by every route that accepts a
    bundle (local POST, federation outbox, federation inbox)."""
    if len(raw) > LIMITS.max_compressed_bytes:
        raise HTTPException(413, "payload too large")

    if "gzip" in (content_encoding or "").lower():
        try:
            data = gunzip_bounded(raw, LIMITS.max_message_bytes)
        except ValueError:
            raise HTTPException(413, "payload too large")
        except Exception:
            raise HTTPException(400, "invalid gzip body")
    else:
        data = raw

    if len(data) > LIMITS.max_message_bytes:
        raise HTTPException(413, "payload too large")

    try:
        payload = json.loads(data) if data else {}
    except Exception:
        raise HTTPException(400, "invalid json")

    if not isinstance(payload, dict):
        raise HTTPException(400, "invalid payload")
    return payload, data


def _message_out(row: "RelayMessage", payload: Optional[dict] = None) -> dict:
    """The wire shape of one stored bundle (poll + push). `viaRelay` —
    the relay-verified sending relay — rides along only on bundles
    another relay delivered (additive; absent everywhere else)."""
    out = {**(row.body if payload is None else payload), "msgId": row.id, "receivedAt": _epoch_ms(row.created_at)}
    if row.origin_relay:
        out["viaRelay"] = row.origin_relay
    return out


@app.post("/relay/messages", status_code=202, dependencies=[Depends(require_relay_token)])
def post_message(
    raw: bytes = Depends(_raw_body),
    content_encoding: Optional[str] = Header(None),
    db: Session = Depends(get_db),
) -> JSONResponse:
    payload, data = _decode_message_body(raw, content_encoding)
    recipient = payload.get("recipientCode")
    if not isinstance(recipient, str) or not recipient:
        raise HTTPException(400, "missing recipientCode")
    return JSONResponse({"msgId": _store_local_message(db, recipient, payload, data)}, status_code=202)


def _store_local_message(db: Session, recipient: str, payload: dict, data: bytes) -> str:
    """Store one bundle for a LOCAL recipient and live-push it → msgId."""
    # Retry dedupe. On flaky wifi a POST can commit but lose its response;
    # the client resends the SAME ciphertext and would otherwise get a
    # fresh msgId, which its msgId dedupe cannot catch (the card shows up
    # twice). Encrypted bundles carry a random nonce, so byte-identical
    # bodies to one recipient are the same send — answer with the
    # original msgId. Only still-pending rows match: once the recipient
    # acked (deleted) it, an identical resend is delivered again.
    digest = hashlib.sha256(data).hexdigest()
    dup = (
        db.query(RelayMessage.id)
        .filter(
            RelayMessage.recipient_code == recipient,
            RelayMessage.body_hash == digest,
            RelayMessage.created_at >= datetime.utcnow() - LIMITS.message_ttl,
        )
        .first()
    )
    if dup is not None:
        logger.info("[relay] POST recipient=%s… duplicate of msgId=%s", recipient[:8], dup.id[:8])
        return dup.id

    msg_id = uuid.uuid4().hex
    row = RelayMessage(
        id=msg_id, recipient_code=recipient, body=payload, body_hash=digest, body_bytes=len(data)
    )
    db.add(row)
    db.commit()
    logger.info("[relay] POST recipient=%s… msgId=%s", recipient[:8], msg_id[:8])

    # Store-then-push. This runs on a worker thread; outboxes are
    # loop-owned and NOT thread-safe, so the fan-out is scheduled onto
    # the loop rather than touched here. Serialized here, off the loop.
    if _loop is not None:
        _loop.call_soon_threadsafe(_push_to_streams, recipient, _sse(_message_out(row, payload)))
    return msg_id


feature("responses.gzip")


def maybe_gzip_json(request: Request, payload: dict) -> Response:
    """Negotiated compression for the blob-heavy JSON endpoints. The
    ciphertext itself is incompressible, but its base64 EXPANSION gzips
    away (~-25% on blob bodies). Fires only when the client advertised
    gzip (every shipped client does); otherwise byte-identical to the
    uncompressed response. SSE never routes through here."""
    body = json.dumps(payload, separators=(",", ":")).encode()
    accepts = "gzip" in request.headers.get("accept-encoding", "").lower()
    if accepts and len(body) > 500:
        return Response(
            gzip.compress(body, 6),
            media_type="application/json",
            headers={"Content-Encoding": "gzip", "Vary": "Accept-Encoding"},
        )
    return Response(body, media_type="application/json", headers={"Vary": "Accept-Encoding"})


feature("mailbox.pollMore")


@app.get("/relay/messages", dependencies=[Depends(require_relay_token)])
def get_messages(
    request: Request,
    recipient: str = Query(..., min_length=1),
    db: Session = Depends(get_db),
) -> Response:
    # Lazy expiry via cutoff filter; the sweeper owns actual deletion.
    cutoff = datetime.utcnow() - LIMITS.message_ttl
    # Size first, bodies second: 100 × 25 MB bundles would otherwise be
    # built (and gzipped) in memory as one ~2.5 GB response. A page stops
    # at LIMITS.max_poll_bytes but always carries at least one message, so the
    # oldest bundle can never wedge the queue. Clients drain the rest by
    # acking (DELETE) and polling again, as they already do; `more` is an
    # additive hint for clients that want to poll again immediately.
    size = func.coalesce(RelayMessage.body_bytes, func.octet_length(cast(RelayMessage.body, Text)))
    candidates = (
        db.query(RelayMessage.id, size)
        .filter(
            RelayMessage.recipient_code == recipient,
            RelayMessage.created_at >= cutoff,
        )
        .order_by(RelayMessage.created_at.asc(), RelayMessage.id.asc())
        .limit(LIMITS.max_per_poll)
        .all()
    )
    chosen, used = [], 0
    for msg_id, n in candidates:
        if chosen and used + n > LIMITS.max_poll_bytes:
            break
        chosen.append(msg_id)
        used += n
    rows = (
        db.query(RelayMessage)
        .filter(RelayMessage.id.in_(chosen))
        .order_by(RelayMessage.created_at.asc(), RelayMessage.id.asc())
        .all()
        if chosen
        else []
    )
    messages = [_message_out(row) for row in rows]
    more = len(chosen) < len(candidates) or len(candidates) == LIMITS.max_per_poll
    return maybe_gzip_json(request, {"messages": messages, "more": more})


@app.get("/relay/stream", dependencies=[Depends(require_relay_token)])
async def stream_messages(
    request: Request,
    recipient: str = Query(..., min_length=1),
) -> StreamingResponse:
    """SSE push channel: `event: hello` on connect, one `data:` frame per
    newly POSTed bundle, heartbeat comments while idle."""
    box = _Outbox()
    _streams.setdefault(recipient, set()).add(box)

    async def gen() -> AsyncIterator[str]:
        try:
            yield "event: hello\ndata: {}\n\n"
            while True:
                if await request.is_disconnected():
                    return
                frame = await box.get(LIMITS.heartbeat_seconds)
                if box.overflowed:
                    # Client reconnects and catches up via GET.
                    logger.info("[relay] stream recipient=%s… overflowed, closing", recipient[:8])
                    return
                yield frame if frame is not None else ": hb\n\n"
        finally:
            peers = _streams.get(recipient)
            if peers is not None:
                peers.discard(box)
                if not peers:
                    _streams.pop(recipient, None)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.delete(
    "/relay/messages/{msg_id}",
    status_code=204,
    dependencies=[Depends(require_relay_token)],
)
def delete_message(msg_id: str, db: Session = Depends(get_db)) -> Response:
    db.query(RelayMessage).filter(RelayMessage.id == msg_id).delete(
        synchronize_session=False
    )
    db.commit()
    return Response(status_code=204)


# ── Rooms (collaboration sessions) ───────────────────────────────────


def _room_or_error(db: Session, room_id: str, *, for_update: bool = False, for_share: bool = False) -> RelayRoom:
    """Load the room. `for_update` takes the row lock that serializes writers
    (compaction vs. compaction, compaction vs. the bytes_used updates);
    `for_share` lets readers see snapshot + tail from one consistent point
    rather than straddling a compaction commit. (sqlite ignores both.)"""
    q = db.query(RelayRoom).filter(RelayRoom.id == room_id)
    if for_update:
        q = q.with_for_update()
    elif for_share:
        q = q.with_for_update(read=True)
    room = q.one_or_none()
    if room is None:
        raise HTTPException(404, "no such room")
    if room.tombstoned:
        raise HTTPException(410, "session ended")
    return room


def _room_last_seq(db: Session, room_id: str) -> int:
    max_id = (
        db.query(func.max(RelayRoomUpdate.id))
        .filter(RelayRoomUpdate.room_id == room_id)
        .scalar()
    )
    if max_id is not None:
        return int(max_id)
    snap = db.get(RelayRoomSnapshot, room_id)
    return int(snap.covers_through_seq) if snap is not None else 0


def _b64_raw_len(n: int) -> int:
    """Raw size of n base64 chars. bytes_used and the cap count RAW bytes
    everywhere (appends store base64 of raw; snapshots arrive as base64)."""
    return n * 3 // 4


@app.post("/relay/rooms", status_code=201, dependencies=[Depends(require_relay_token)])
def create_room(db: Session = Depends(get_db)) -> JSONResponse:
    room_id = uuid.uuid4().hex
    db.add(RelayRoom(id=room_id))
    db.commit()
    logger.info("[relay] room created %s…", room_id[:8])
    # `home` (federation only, additive): the room's home relay — what a
    # cross-server share code names (FEDERATION.md §2.1).
    body = {"roomId": room_id, **({"home": FEDERATION.url} if FEDERATION.enabled else {})}
    if ROOM_PASSES:
        body["guestPass"] = mint_room_pass(room_id, "g")
        body["viewPass"] = mint_room_pass(room_id, "v")
    return JSONResponse(body, status_code=201)


@app.get("/relay/rooms/{room_id}/guest-pass", dependencies=[Depends(room_write_auth)])
def get_guest_pass(room_id: str, db: Session = Depends(get_db)) -> JSONResponse:
    """A fresh edit pass (the host's resume path re-mints its join link).
    Edit credentials only — a view pass must never buy an edit seat."""
    if not ROOM_PASSES:
        raise HTTPException(404, "Not Found")
    _room_or_error(db, room_id)
    return JSONResponse({"guestPass": mint_room_pass(room_id, "g")})


@app.get("/relay/rooms/{room_id}/view-pass", dependencies=[Depends(room_auth)])
def get_view_pass(room_id: str, db: Session = Depends(get_db)) -> JSONResponse:
    """A fresh view pass. Any room credential may mint one, so every
    participant — spectators included — can hand out view links, and a
    desktop app can swap its own token for a pass when it spectates."""
    if not ROOM_PASSES:
        raise HTTPException(404, "Not Found")
    _room_or_error(db, room_id)
    return JSONResponse({"viewPass": mint_room_pass(room_id, "v")})


@app.post(
    "/relay/rooms/{room_id}/updates",
    status_code=202,
    dependencies=[Depends(room_write_auth)],
)
def post_room_update(
    room_id: str,
    raw: bytes = Depends(_raw_body),
    db: Session = Depends(get_db),
) -> JSONResponse:
    if not raw:
        raise HTTPException(400, "empty update")
    if len(raw) > LIMITS.max_update_bytes:
        raise HTTPException(413, "update too large")
    b64 = base64.b64encode(raw).decode("ascii")
    # Lock spans the cap check (no concurrent overshoot), the insert (seq
    # assignment), the commit, and the push scheduling — see _room_lock.
    with _room_lock(room_id):
        room = _room_or_error(db, room_id, for_update=True)
        if room.bytes_used + len(raw) > LIMITS.room_cap_bytes:
            raise HTTPException(413, "room storage cap reached")
        row = RelayRoomUpdate(room_id=room_id, blob=b64)
        db.add(row)
        room.bytes_used = room.bytes_used + len(raw)
        room.last_activity = datetime.utcnow()
        db.commit()
        seq = int(row.id)
        if _loop is not None:
            _loop.call_soon_threadsafe(
                _push_to_room, room_id, _sse({"t": "u", "seq": seq, "blob": b64})
            )
    return JSONResponse({"seq": seq}, status_code=202)


feature("rooms.byteBudgetPages")
feature("rooms.conditionalSnapshot")


@app.get("/relay/rooms/{room_id}/updates", dependencies=[Depends(room_auth)])
def get_room_updates(
    request: Request,
    room_id: str,
    after: int = Query(0, ge=0),
    have_snap: Optional[int] = Query(None, alias="haveSnap", ge=0),
    db: Session = Depends(get_db),
) -> Response:
    # One consistent view for the whole page. Under READ COMMITTED a
    # compaction landing between the snapshot read and the updates read
    # could hand back the OLD snapshot plus a tail whose head had just
    # been deleted — a silent hole. Read-only, so this never conflicts.
    db.connection(execution_options={"isolation_level": "REPEATABLE READ"})
    _room_or_error(db, room_id)
    out: dict = {}
    snap = db.get(RelayRoomSnapshot, room_id)
    floor = after
    budget = LIMITS.max_page_bytes
    if snap is not None and after < snap.covers_through_seq:
        if have_snap is not None and have_snap == int(snap.covers_through_seq):
            # Conditional snapshot: client already holds this exact one.
            out["snapshotUnchanged"] = True
            out["snapshotCovers"] = int(snap.covers_through_seq)
        else:
            out["snapshot"] = {
                "blob": snap.blob,
                "coversThroughSeq": int(snap.covers_through_seq),
            }
            budget -= len(snap.blob)
        floor = int(snap.covers_through_seq)
    # Pages are bounded by bytes as well as count (200 × 5 MB updates plus
    # a snapshot could otherwise exceed 1 GB — a timeout-and-retry loop on
    # venue wifi). At least one update per page whenever any remain, so
    # paging always progresses and `more` never comes with an empty page.
    candidates = (
        db.query(RelayRoomUpdate.id, func.length(RelayRoomUpdate.blob))
        .filter(RelayRoomUpdate.room_id == room_id, RelayRoomUpdate.id > floor)
        .order_by(RelayRoomUpdate.id.asc())
        .limit(LIMITS.max_updates_per_page)
        .all()
    )
    chosen, used = [], 0
    for seq, n in candidates:
        if chosen and used + n > budget:
            break
        chosen.append(seq)
        used += n
    rows = (
        db.query(RelayRoomUpdate)
        .filter(RelayRoomUpdate.id.in_(chosen))
        .order_by(RelayRoomUpdate.id.asc())
        .all()
        if chosen
        else []
    )
    # Compaction-epoch tag on every page (see the official relay: the
    # client's incremental audit keys off this).
    out["snapCovers"] = int(snap.covers_through_seq) if snap is not None else 0
    out["updates"] = [{"seq": int(r.id), "blob": r.blob} for r in rows]
    out["more"] = len(chosen) < len(candidates) or len(candidates) == LIMITS.max_updates_per_page
    out["lastSeq"] = int(rows[-1].id) if rows else floor
    return maybe_gzip_json(request, out)


@app.post(
    "/relay/rooms/{room_id}/snapshot",
    status_code=204,
    dependencies=[Depends(room_write_auth)],
)
def post_room_snapshot(
    room_id: str,
    raw: bytes = Depends(_raw_body),
    db: Session = Depends(get_db),
) -> Response:
    try:
        payload = json.loads(raw)
        blob = payload["blob"]
        covers = int(payload["coversThroughSeq"])
        if not isinstance(blob, str) or not blob or covers < 0:
            raise ValueError
    except Exception:
        raise HTTPException(400, "expected {blob, coversThroughSeq}")
    if len(blob) > LIMITS.max_snapshot_bytes:
        raise HTTPException(413, "snapshot too large")
    with _room_lock(room_id):
        room = _room_or_error(db, room_id, for_update=True)
        existing = db.get(RelayRoomSnapshot, room_id)
        if existing is not None and covers <= existing.covers_through_seq:
            # Stale or duplicate compaction (another client got there first).
            return Response(status_code=204)
        if existing is None:
            db.add(RelayRoomSnapshot(room_id=room_id, blob=blob, covers_through_seq=covers))
        else:
            existing.blob = blob
            existing.covers_through_seq = covers
            existing.created_at = datetime.utcnow()
        db.query(RelayRoomUpdate).filter(
            RelayRoomUpdate.room_id == room_id, RelayRoomUpdate.id <= covers
        ).delete(synchronize_session=False)
        # Recompute stored size from what actually remains, in raw bytes
        # like the append path. (Not capped: refusing a compaction would
        # only make the room bigger.)
        remaining = (
            db.query(func.coalesce(func.sum(func.length(RelayRoomUpdate.blob)), 0))
            .filter(RelayRoomUpdate.room_id == room_id)
            .scalar()
        )
        room.bytes_used = _b64_raw_len(int(remaining) + len(blob))
        room.last_activity = datetime.utcnow()
        db.commit()
    return Response(status_code=204)


feature("rooms.presenceSid")


@app.post("/relay/rooms/{room_id}/presence", status_code=202)
async def post_local_room_presence(
    room_id: str,
    request: Request,
    sender: Optional[str] = Query(None, alias="from", max_length=64),
    cred: RoomCred = Depends(room_auth),
) -> JSONResponse:
    """Local participants and spectators. A spectator's frames go out
    stamped `"v":1` — the relay's word, which a client can't forge."""
    return await _fan_out_presence(room_id, request, sender, viewer=cred.viewer)


async def post_room_presence(
    room_id: str,
    request: Request,
    sender: Optional[str] = Query(None, alias="from", max_length=64),
) -> JSONResponse:
    """Remote (federated) participants' presence — registered with peer
    auth in _register_federation. Never a spectator."""
    return await _fan_out_presence(room_id, request, sender, viewer=False)


async def _fan_out_presence(room_id: str, request: Request, sender: Optional[str], viewer: bool) -> JSONResponse:
    """Ephemeral fan-out only — never stored, never touches the DB (this
    is the hot path at cursor-move rates). An unknown room simply has no
    open streams, so the frame goes nowhere. Shed (not overflowed) at a
    backed-up stream: there is nothing to catch up on."""
    raw = await request.body()
    if not raw:
        raise HTTPException(400, "empty presence")
    if len(raw) > LIMITS.max_presence_bytes:
        raise HTTPException(413, "presence too large")
    b64 = base64.b64encode(raw).decode("ascii")
    frame = {"t": "p", "blob": b64, **({"v": 1} if viewer else {})}
    _push_to_room(room_id, _sse(frame), skip_sid=sender, droppable=True)
    return JSONResponse({}, status_code=202)


def _open_room_stream(room_id: str) -> int:
    """DB half of stream connect; runs in the threadpool (blocking
    psycopg2 must stay off the event loop)."""
    db = SessionLocal()
    try:
        room = _room_or_error(db, room_id)
        last_seq = _room_last_seq(db, room_id)
        room.last_activity = datetime.utcnow()
        db.commit()
        return last_seq
    finally:
        db.close()


@app.get("/relay/rooms/{room_id}/stream")
async def stream_room(
    request: Request,
    room_id: str,
    sid: Optional[str] = Query(None, max_length=64),
    cred: RoomCred = Depends(room_auth),
) -> Response:
    """SSE: `event: hello` with the current cursor and watcher count, then
    update/presence/`w` frames. The caps are enforced here — holding a
    stream IS being in the room (a view pass: watching it)."""
    return await _room_stream_response(request, room_id, sid, viewer=cred.viewer)


async def _room_stream_response(
    request: Request,
    room_id: str,
    sid: Optional[str],
    fed_request: Optional[str] = None,
    viewer: bool = False,
) -> Response:
    """The room stream, for a local participant (fed_request None), a
    local spectator (viewer), or a remote participant whose relay proxies
    it (fed_request = their join-request id: their stream also receives
    access changes, and closes on a revocation)."""
    # Check-and-register with no await in between, so concurrent connects
    # cannot both take the last slot. Registering BEFORE reading lastSeq
    # also means an update committed during connect is either covered by
    # hello.lastSeq or buffered in the outbox — never neither.
    open_now = _room_streams.get(room_id, {})
    if viewer:
        if sum(1 for b in open_now if b.viewer) >= LIMITS.max_viewers_per_room:
            raise HTTPException(409, "room is full")
    elif sum(1 for b in open_now if not b.viewer) >= LIMITS.max_streams_per_room:
        # "Watch instead": a refused LOCAL editor gets a view pass. A remote
        # one doesn't — its app talks to this room through its own relay,
        # where a pass for this one means nothing.
        body: dict = {"detail": "room is full"}
        if ROOM_PASSES and fed_request is None:
            body["viewPass"] = mint_room_pass(room_id, "v")
        return JSONResponse(body, status_code=409)
    box = _Outbox(fed_request, viewer=viewer)
    _room_streams.setdefault(room_id, {})[box] = sid
    try:
        last_seq = await run_in_threadpool(_open_room_stream, room_id)
    except BaseException:
        _drop_room_stream(room_id, box)
        raise
    if viewer:
        _announce_watchers(room_id)

    async def gen() -> AsyncIterator[str]:
        departed = asyncio.create_task(_close_on_disconnect(request, box))
        try:
            hello = json.dumps({"lastSeq": last_seq, "watchers": _watcher_count(room_id)}, separators=(",", ":"))
            yield f"event: hello\ndata: {hello}\n\n"
            while True:
                frame = await box.get(LIMITS.heartbeat_seconds)
                if box.gone:
                    return
                if box.overflowed:
                    # Plain close, NOT an end frame: the client reconnects
                    # and catches up via GET ?after=.
                    logger.info("[relay] room stream %s… overflowed, closing", room_id[:8])
                    return
                if frame is None:
                    yield ": hb\n\n"
                    continue
                yield frame
                if frame == _END_FRAME or frame == _REVOKED_FRAME:
                    return
        finally:
            departed.cancel()
            _drop_room_stream(room_id, box)
            if viewer:
                _announce_watchers(room_id)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.delete(
    "/relay/rooms/{room_id}",
    status_code=204,
    dependencies=[Depends(room_write_auth)],
)
def delete_room(room_id: str, db: Session = Depends(get_db)) -> Response:
    with _room_lock(room_id):
        room = (
            db.query(RelayRoom).filter(RelayRoom.id == room_id).with_for_update().one_or_none()
        )
        if room is None:
            raise HTTPException(404, "no such room")
        if not room.tombstoned:
            room.tombstoned = True
            room.bytes_used = 0
            room.last_activity = datetime.utcnow()
            db.query(RelayRoomUpdate).filter(RelayRoomUpdate.room_id == room_id).delete(
                synchronize_session=False
            )
            db.query(RelayRoomSnapshot).filter(RelayRoomSnapshot.room_id == room_id).delete(
                synchronize_session=False
            )
            db.query(RelayFedJoinRequest).filter(RelayFedJoinRequest.room_id == room_id).delete(
                synchronize_session=False
            )
            db.commit()
            _pass_cache_clear()
            if _loop is not None:
                _loop.call_soon_threadsafe(_push_to_room, room_id, _END_FRAME)
    return Response(status_code=204)


# ── Federation ───────────────────────────────────────────────────────
#
# Card sharing and co-editing between users on DIFFERENT relays. The
# protocol is FEDERATION.md; this is its implementation. Everything here
# is inert unless FEDERATION.enabled: no route is registered, no feature
# listed, no thread started, no outbound connection made.
#
# Threading follows the module's rules: DB work happens in sync
# handlers (threadpool) or the delivery thread; the loop only runs async
# HTTP to peers (room proxying) and touches the loop-owned stream
# registries. Outbound calls never hold a DB connection.
#
# Trust: a relay IS its canonical URL (FEDERATION.md §1). Dialback
# tokens prove a peer controls its URL; nicknames are display data only.

FED_PROTOCOL = 1
_ROOM_ID_RE = re.compile(r"^[0-9a-f]{16,64}$")
_PASS_RE = re.compile(r"^[A-Za-z0-9_-]{22,128}$")
_PEER_HDR = "x-cardmirror-peer"
_PEER_TOKEN_HDR = "x-cardmirror-peer-token"
_PASS_HDR = "x-cardmirror-room-pass"
_FED_HDRS = {"X-CardMirror-Federation": "1"}


class FedError(Exception):
    """A federation refusal with a machine-readable code. Rendered as
    {"error": code, "detail": code, ...}: `error` is the contract, and
    `detail` keeps the string shape shipped apps already fold into their
    error messages."""

    def __init__(self, status: int, code: str, **extra) -> None:
        super().__init__(code)
        self.status, self.code, self.extra = status, code, extra


@app.exception_handler(FedError)
async def _fed_error(_request: Request, exc: FedError) -> JSONResponse:
    return JSONResponse(
        {"error": exc.code, "detail": exc.code, **exc.extra},
        status_code=exc.status,
        headers=_FED_HDRS,
    )


class PeerError(Exception):
    """An outbound call to a peer relay failed. `transient` = worth
    retrying later (network, 5xx, handshake never completed); otherwise
    the peer (or our own policy, `local`) refused."""

    def __init__(self, status: int, code: str, transient: bool, local: bool = False) -> None:
        super().__init__(code)
        self.status, self.code, self.transient, self.local = status, code, transient, local


def _sha(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def _json_obj(raw: bytes, max_bytes: int) -> dict:
    if len(raw) > max_bytes:
        raise FedError(413, "too-large")
    try:
        body = json.loads(raw) if raw else {}
    except Exception:
        raise FedError(400, "invalid-json")
    if not isinstance(body, dict):
        raise FedError(400, "invalid-json")
    return body


def _err_code(raw: bytes) -> str:
    """The `error` code of a peer's refusal body ('' if none)."""
    try:
        body = json.loads(raw)
    except Exception:
        return ""
    if isinstance(body, dict):
        code = body.get("error")
        if isinstance(code, str):
            return code
        detail = body.get("detail")
        if isinstance(detail, dict) and isinstance(detail.get("error"), str):
            return detail["error"]
    return ""


def _clean_nickname(raw: object) -> Optional[str]:
    if not isinstance(raw, str):
        return None
    nick = "".join(c for c in raw if c.isprintable()).strip()[:48]
    return nick or None


# ── Peer address policy ──
# Outbound calls go to URLs other people chose (a share code's home, a
# recipient's relay, a handshake's claimed origin). Unless the operator
# opts in (LAN/dev), only publicly routable addresses are contacted, so
# a relay can't be steered at its own private network.

_addr_ok_cache: dict[str, tuple[float, bool]] = {}
# Caches keyed by values strangers can choose (hosts, claimed origins,
# probed URLs) are bounded: past this many entries the oldest go.
_FED_CACHE_MAX = 4096


def _bound(d: dict) -> None:
    """Drop the oldest-inserted entries once `d` outgrows the cap."""
    if len(d) > _FED_CACHE_MAX:
        for k in list(d)[: len(d) - _FED_CACHE_MAX]:
            d.pop(k, None)


def _peer_address_ok(url: str) -> bool:
    if FEDERATION.allow_private:
        return True
    host = _url_host(url).strip("[]")
    hit = _addr_ok_cache.get(host)
    now = time.monotonic()
    if hit is not None and hit[0] > now:
        return hit[1]
    try:
        infos = socket.getaddrinfo(host, None)
        addrs = {ipaddress.ip_address(i[4][0].split("%")[0]) for i in infos}
        ok = bool(addrs) and all(a.is_global for a in addrs)
    except (OSError, ValueError):
        ok = False
    _addr_ok_cache[host] = (now + 300, ok)
    _bound(_addr_ok_cache)
    return ok


def _static_refusal(url: str) -> Optional[str]:
    """Why the operator's static policy refuses `url` (None = it doesn't)."""
    if url == FEDERATION.url:
        return "self"
    if url.startswith("http://") and not FEDERATION.allow_http:
        return "http-not-allowed"
    if FederationConfig._matches(url, FEDERATION.deny):
        return "denied"
    if FEDERATION.allow and not FederationConfig._matches(url, FEDERATION.allow):
        return "not-on-allow-list"
    return None


def _refusal(url: str) -> Optional[str]:
    """Why this relay won't contact `url`, or None: the static policy,
    then the address check (may DNS — call from a thread).

    A peer the operator NAMED in RELAY_FEDERATION_ALLOW skips the address
    check: the operator has vouched for it, and private-looking addresses
    are normal for legitimate peers on overlay networks — e.g. Tailscale
    Funnel hosts on the same tailnet resolve to 100.64.0.0/10 addresses."""
    reason = _static_refusal(url)
    if reason is None and not FEDERATION.allow and not _peer_address_ok(url):
        reason = "private-address"
    return reason


_REFUSAL_HINTS = {
    "http-not-allowed": "set RELAY_FEDERATION_ALLOW_HTTP=1 to allow plain-http peers",
    "private-address": "it resolves to a private/loopback/tailnet address; name it in RELAY_FEDERATION_ALLOW "
                       "(e.g. *.tailXXXX.ts.net) or set RELAY_FEDERATION_ALLOW_PRIVATE=1",
    "denied": "it matches RELAY_FEDERATION_DENY",
    "not-on-allow-list": "it isn't on RELAY_FEDERATION_ALLOW",
    "self": "that is this relay's own URL",
}


def _refuse(url: str, reason: str, what: str) -> "FedError":
    """Log a policy refusal with the operator's fix, and build the app's
    `403 peer-refused` (now carrying `reason`)."""
    logger.warning("[fed] refused %s %s: %s (%s)", what, url, reason, _REFUSAL_HINTS.get(reason, ""))
    return FedError(403, "peer-refused", relay=url, reason=reason)


def _peer_allowed(url: str) -> bool:
    """Full outbound policy: operator lists + address check (may DNS —
    call from a thread)."""
    return _refusal(url) is None


# ── HTTP clients ──
# Sync client: the delivery thread and sync handlers (handshakes, peer
# info, outbox preflight). Async client: room proxying on the loop.
# Neither follows redirects — a peer's URL is its identity, and a
# redirect would silently talk to someone else.

_http: Optional[httpx.Client] = None
_ahttp: Optional[httpx.AsyncClient] = None
_UA = {"User-Agent": f"cardmirror-relay-federation/{FED_PROTOCOL}"}


# ── Peers: dialback tokens + capability cache ──


class _Peers:
    def __init__(self) -> None:
        self._mu = threading.Lock()
        self._out: dict[str, str] = {}        # peer → token we present
        self._in: dict[str, str] = {}         # sha256(token) → peer it was issued to
        self._pending: dict[str, dict] = {}   # handshake nonce → slot
        self._hs_locks: dict[str, threading.Lock] = {}
        self._hs_window: dict[str, list] = {}  # origin → [window start, count]
        self._caps: dict[str, dict] = {}       # peer → {"at", "ttl", "info", "etag"}

    # ---- outbound (tokens peers issued us) ----

    def _hs_lock(self, peer: str) -> threading.Lock:
        with self._mu:
            return self._hs_locks.setdefault(peer, threading.Lock())

    def out_token(self, peer: str) -> Optional[str]:
        with self._mu:
            tok = self._out.get(peer)
        if tok:
            return tok
        db = SessionLocal()
        try:
            row = db.get(RelayFedToken, f"out:{peer}")
            tok = row.token if row is not None else None
        finally:
            db.close()
        if tok:
            with self._mu:
                self._out[peer] = tok
        return tok

    def ensure_out_token(self, peer: str) -> str:
        """A token `peer` accepts from us, handshaking if we have none.
        Serialized per peer, so concurrent first contacts share one
        handshake. Raises PeerError."""
        tok = self.out_token(peer)
        if tok:
            return tok
        with self._hs_lock(peer):
            return self.out_token(peer) or self._handshake(peer)

    def _handshake(self, peer: str) -> str:
        nonce = secrets.token_urlsafe(24)
        slot = {"peer": peer, "event": threading.Event(), "token": None}
        with self._mu:
            self._pending[nonce] = slot
        try:
            try:
                r = _http.post(
                    f"{peer}/federation/v1/handshake",
                    json={"origin": FEDERATION.url, "nonce": nonce, "protocol": FED_PROTOCOL},
                    timeout=LIMITS.fed_peer_timeout_seconds + 10,
                )
            except httpx.HTTPError as e:
                raise PeerError(0, "peer-unreachable", transient=True) from e
            if r.status_code != 200:
                code = _err_code(r.content) or f"handshake-{r.status_code}"
                transient = r.status_code >= 500 or r.status_code in (404, 429)
                logger.warning("[fed] handshake with %s refused: %s", peer, code)
                raise PeerError(r.status_code, code, transient=transient)
            # The peer answers only after our callback endpoint accepted
            # the token, so this normally returns at once.
            slot["event"].wait(5)
            token = slot["token"]
            if not token:
                raise PeerError(502, "handshake-incomplete", transient=True)
        finally:
            with self._mu:
                self._pending.pop(nonce, None)
        db = SessionLocal()
        try:
            db.merge(RelayFedToken(id=f"out:{peer}", direction="out", peer_url=peer, token=token))
            db.commit()
        finally:
            db.close()
        with self._mu:
            self._out[peer] = token
        logger.info("[fed] peered with %s", peer)
        return token

    def accept_callback(self, origin: str, nonce: str, token: str) -> bool:
        with self._mu:
            slot = self._pending.get(nonce)
            if slot is None or slot["peer"] != origin or slot["token"] is not None:
                return False
            slot["token"] = token
        slot["event"].set()
        return True

    def invalidate_out(self, peer: str, token: str) -> None:
        """The peer no longer accepts `token` (it lost its store, or
        rotated): forget it so the next call handshakes again."""
        with self._mu:
            if self._out.get(peer) == token:
                del self._out[peer]
        db = SessionLocal()
        try:
            db.query(RelayFedToken).filter(
                RelayFedToken.id == f"out:{peer}", RelayFedToken.token == token
            ).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()

    # ---- inbound (tokens we issued peers) ----

    def allow_handshake(self, origin: str) -> bool:
        now = time.monotonic()
        with self._mu:
            w = self._hs_window.get(origin)
            if w is None or now - w[0] > 60:
                w = [now, 0]
            w[1] += 1
            self._hs_window[origin] = w
            _bound(self._hs_window)
            return w[1] <= LIMITS.fed_handshakes_per_minute

    def issue_in_token(self, origin: str) -> str:
        token = secrets.token_urlsafe(32)
        h = _sha(token)
        db = SessionLocal()
        try:
            db.add(RelayFedToken(id=f"in:{h}", direction="in", peer_url=origin, token=h))
            db.commit()
            # Keep the newest few per peer: a peer that re-handshakes
            # (lost its store) must not accumulate tokens forever, but a
            # token another of its threads is mid-request with stays good.
            stale = (
                db.query(RelayFedToken.id)
                .filter(RelayFedToken.direction == "in", RelayFedToken.peer_url == origin)
                .order_by(RelayFedToken.created_at.desc())
                .offset(4)
                .all()
            )
            if stale:
                ids = [s for (s,) in stale]
                db.query(RelayFedToken).filter(RelayFedToken.id.in_(ids)).delete(synchronize_session=False)
                db.commit()
                with self._mu:
                    for s in ids:
                        self._in.pop(s[3:], None)
        finally:
            db.close()
        with self._mu:
            self._in[h] = origin
        return token

    def revoke_in_token(self, token: str) -> None:
        h = _sha(token)
        with self._mu:
            self._in.pop(h, None)
        db = SessionLocal()
        try:
            db.query(RelayFedToken).filter(RelayFedToken.id == f"in:{h}").delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()

    def verify_in_cached(self, origin: str, token: str) -> Optional[bool]:
        """True/False when the cache knows the token, None to ask the DB."""
        with self._mu:
            peer = self._in.get(_sha(token))
        return None if peer is None else peer == origin

    def verify_in_db(self, origin: str, token: str) -> bool:
        h = _sha(token)
        db = SessionLocal()
        try:
            row = db.get(RelayFedToken, f"in:{h}")
            peer = row.peer_url if row is not None else None
        finally:
            db.close()
        if peer is None:
            return False
        with self._mu:
            self._in[h] = peer
        return peer == origin

    # ---- capabilities (limits, nickname, "does it federate?") ----

    def info_cached(self, peer: str) -> Optional[dict]:
        with self._mu:
            c = self._caps.get(peer)
        if c is not None and time.monotonic() - c["at"] < c["ttl"]:
            return c["info"]
        return None

    def info(self, peer: str, timeout: float = 5) -> dict:
        """{"reachable", "federates", "nickname", "limits"} — cached 5 min
        (30 s when unreachable). A peer federates only if its published
        federation.url IS the URL we reached it at: a relay answering
        under several names federates under its canonical one only."""
        hit = self.info_cached(peer)
        if hit is not None:
            return hit
        with self._mu:
            prev = self._caps.get(peer)
        headers = dict(_UA)
        if prev is not None and prev.get("etag"):
            headers["If-None-Match"] = prev["etag"]
        info = {"reachable": False, "federates": False, "nickname": None, "limits": {}}
        etag = None
        try:
            r = _http.get(f"{peer}/capabilities", headers=headers, timeout=timeout)
            if r.status_code == 304 and prev is not None:
                info, etag = prev["info"], prev.get("etag")
            elif r.status_code == 200:
                doc = r.json()
                fed = doc.get("federation") if isinstance(doc, dict) else None
                federates = (
                    isinstance(fed, dict)
                    and canon_url(fed.get("url")) == peer
                    and isinstance(fed.get("protocol"), int)
                    and fed["protocol"] >= FED_PROTOCOL
                )
                limits = doc.get("limits") if isinstance(doc, dict) else None
                info = {
                    "reachable": True,
                    "federates": bool(federates),
                    "nickname": _clean_nickname(fed.get("nickname")) if federates else None,
                    "limits": limits if isinstance(limits, dict) else {},
                }
                etag = r.headers.get("etag")
            elif r.status_code == 404:
                # No capabilities endpoint: an older relay, so not federating.
                info = {**info, "reachable": True}
        except (httpx.HTTPError, ValueError):
            pass
        with self._mu:
            self._caps[peer] = {
                "at": time.monotonic(),
                "ttl": 300 if info["reachable"] else 30,
                "info": info,
                "etag": etag,
            }
            _bound(self._caps)
        return info


PEERS = _Peers()


def _peer_call(
    method: str,
    peer: str,
    path: str,
    *,
    content: Optional[bytes] = None,
    headers: Optional[dict] = None,
    timeout: Optional[float] = None,
) -> httpx.Response:
    """One authenticated call to a peer (sync). A stale token is retried
    once after a fresh handshake. Raises PeerError on policy refusal or
    an unreachable peer; any HTTP status is returned."""
    if not _peer_allowed(peer):
        raise PeerError(403, "peer-refused", transient=False, local=True)
    for attempt in (0, 1):
        token = PEERS.ensure_out_token(peer)
        h = {**_UA, _PEER_HDR: FEDERATION.url, _PEER_TOKEN_HDR: token, **(headers or {})}
        try:
            r = _http.request(
                method, f"{peer}{path}", content=content, headers=h,
                timeout=timeout or LIMITS.fed_peer_timeout_seconds,
            )
        except httpx.HTTPError as e:
            raise PeerError(0, "peer-unreachable", transient=True) from e
        if r.status_code == 401 and attempt == 0 and _err_code(r.content) == "peer-token-invalid":
            PEERS.invalidate_out(peer, token)
            continue
        return r
    return r  # pragma: no cover — loop always returns


async def _read_raw(r: httpx.Response) -> bytes:
    """A streamed response's bytes exactly as sent (gzip stays gzip —
    passed through to an app that asked for it)."""
    try:
        return b"".join([chunk async for chunk in r.aiter_raw()])
    except httpx.StreamConsumed:
        return r.content  # a response _apeer_send already read


async def _apeer_send(
    method: str,
    peer: str,
    path: str,
    *,
    content: Optional[bytes] = None,
    headers: Optional[dict] = None,
    timeout=None,
) -> httpx.Response:
    """Async sibling of _peer_call for the room proxy: returns an OPEN
    streamed response (caller reads or pipes it, then closes it)."""
    for attempt in (0, 1):
        try:
            token = await run_in_threadpool(PEERS.ensure_out_token, peer)
        except SATimeoutError:
            raise PeerError(503, "relay-busy", transient=True)
        h = {**_UA, _PEER_HDR: FEDERATION.url, _PEER_TOKEN_HDR: token, **(headers or {})}
        req = _ahttp.build_request(
            method, f"{peer}{path}", content=content, headers=h,
            timeout=timeout or LIMITS.fed_peer_timeout_seconds,
        )
        try:
            r = await _ahttp.send(req, stream=True)
        except httpx.HTTPError as e:
            raise PeerError(0, "peer-unreachable", transient=True) from e
        if r.status_code == 401 and attempt == 0:
            try:
                raw = await _read_raw(r)
            except httpx.HTTPError as e:
                raise PeerError(0, "peer-unreachable", transient=True) from e
            finally:
                await r.aclose()
            if _err_code(raw) == "peer-token-invalid":
                await run_in_threadpool(PEERS.invalidate_out, peer, token)
                continue
            # Any other 401 is the HOME's answer for the app (e.g. a bad
            # room pass) — hand it back intact, already read.
            return httpx.Response(401, headers=r.headers, content=raw)
        return r
    raise PeerError(401, "peer-token-invalid", transient=False)  # pragma: no cover


# ── Inbound peer authentication ──

_peer_buckets: dict[str, list] = {}  # origin → [tokens, last refill] (loop-owned)


def _peer_rate_ok(origin: str) -> bool:
    rate = LIMITS.fed_peer_requests_per_second
    burst = 2 * rate
    now = time.monotonic()
    b = _peer_buckets.get(origin) or [burst, now]
    b[0] = min(burst, b[0] + (now - b[1]) * rate)
    b[1] = now
    _peer_buckets[origin] = b
    if b[0] < 1:
        return False
    b[0] -= 1
    return True


async def require_peer(request: Request) -> str:
    """Peer relay auth (FEDERATION.md §4) → the caller's canonical URL.
    Async with a cache so presence-rate peer calls skip the threadpool."""
    origin = canon_url(request.headers.get(_PEER_HDR, ""))
    token = request.headers.get(_PEER_TOKEN_HDR, "")
    if not origin or not token:
        raise FedError(401, "peer-token-invalid")
    if not FEDERATION.permits(origin):
        raise _refuse(origin, _static_refusal(origin) or "denied", "inbound request from")
    ok = PEERS.verify_in_cached(origin, token)
    if ok is None:
        ok = await run_in_threadpool(PEERS.verify_in_db, origin, token)
    if not ok:
        raise FedError(401, "peer-token-invalid")
    if not _peer_rate_ok(origin):
        raise FedError(429, "peer-rate-limited")
    return origin


# ── Room passes (remote participants' admissions) ──
# pass_hash → decision, cached because every proxied room call checks
# one. `_pass_gen` stops a slow DB read from caching a decision that a
# concurrent accept/decline already superseded.


@dataclass(frozen=True)
class _PassInfo:
    request_id: str
    room_id: str
    origin: str
    state: str
    mode: Optional[str]


_pass_cache: dict[str, _PassInfo] = {}
_pass_lock = threading.Lock()
_pass_gen = 0


def _pass_cache_clear() -> None:
    global _pass_gen
    with _pass_lock:
        _pass_cache.clear()
        _pass_gen += 1


def _pass_cache_put(pass_hash: str, info: _PassInfo) -> None:
    global _pass_gen
    with _pass_lock:
        _pass_cache[pass_hash] = info
        _pass_gen += 1


def _row_pass_info(row: RelayFedJoinRequest) -> _PassInfo:
    return _PassInfo(row.id, row.room_id, row.origin_url, row.state, row.mode)


def _pass_lookup_db(pass_hash: str) -> Optional[_PassInfo]:
    with _pass_lock:
        hit = _pass_cache.get(pass_hash)
        gen = _pass_gen
    if hit is not None:
        return hit
    db = SessionLocal()
    try:
        row = db.query(RelayFedJoinRequest).filter(RelayFedJoinRequest.pass_hash == pass_hash).one_or_none()
        info = _row_pass_info(row) if row is not None else None
    finally:
        db.close()
    if info is not None:
        with _pass_lock:
            if _pass_gen == gen:
                _pass_cache[pass_hash] = info
    return info


def _room_gone_status(room_id: str) -> Optional[int]:
    """404 / 410 when the room no longer exists / has ended, else None."""
    db = SessionLocal()
    try:
        room = db.get(RelayRoom, room_id)
        if room is None:
            return 404
        return 410 if room.tombstoned else None
    finally:
        db.close()


async def _pass_from_request(request: Request, room_id: str, origin: str) -> _PassInfo:
    p = request.headers.get(_PASS_HDR, "")
    if not _PASS_RE.match(p):
        raise FedError(401, "pass-invalid")
    h = _sha(p)
    with _pass_lock:
        info = _pass_cache.get(h)
    if info is None:
        info = await run_in_threadpool(_pass_lookup_db, h)
    if info is None or info.room_id != room_id or info.origin != origin:
        # A room's admissions are dropped with it: say "ended" / "gone"
        # rather than "bad pass" so the joiner stops cleanly.
        gone = await run_in_threadpool(_room_gone_status, room_id)
        if gone == 410:
            raise HTTPException(410, "session ended")
        if gone == 404:
            raise HTTPException(404, "no such room")
        raise FedError(401, "pass-invalid")
    return info


async def fed_room_access(request: Request, room_id: str, origin: str = Depends(require_peer)) -> _PassInfo:
    """Remote participant gate for room DATA: an accepted pass."""
    info = await _pass_from_request(request, room_id, origin)
    if info.state == "pending":
        raise FedError(403, "join-pending")
    if info.state != "approved":
        raise FedError(403, "join-denied", state=info.state)
    return info


async def fed_room_write(info: _PassInfo = Depends(fed_room_access)) -> _PassInfo:
    if info.mode != "write":
        raise FedError(403, "read-only")
    return info


def _join_state(row: RelayFedJoinRequest) -> dict:
    return {"requestId": row.id, "state": row.state, "mode": row.mode}


# ── Relay-to-relay routes ──


def fed_handshake(raw: bytes = Depends(_raw_body)) -> JSONResponse:
    """Step 1–2 of the dialback: mint a token for the claimed origin and
    deliver it TO that origin's URL — only the real origin receives it."""
    body = _json_obj(raw, 4096)
    origin = canon_url(body.get("origin"))
    nonce = body.get("nonce")
    if not origin or not isinstance(nonce, str) or not 16 <= len(nonce) <= 128:
        raise FedError(400, "bad-handshake")
    reason = _refusal(origin)
    if reason is not None:
        raise _refuse(origin, reason, "handshake from")
    if not PEERS.allow_handshake(origin):
        raise FedError(429, "handshake-rate-limited")
    token = PEERS.issue_in_token(origin)
    try:
        r = _http.post(
            f"{origin}/federation/v1/handshake/callback",
            json={"origin": FEDERATION.url, "nonce": nonce, "token": token},
            timeout=10,
        )
        delivered = r.status_code == 204
    except httpx.HTTPError:
        delivered = False
    if not delivered:
        PEERS.revoke_in_token(token)
        logger.info("[fed] handshake callback to %s failed", origin)
        raise FedError(502, "callback-failed")
    logger.info("[fed] issued peer token to %s", origin)
    return JSONResponse({"ok": True, "protocol": FED_PROTOCOL})


def fed_handshake_callback(raw: bytes = Depends(_raw_body)) -> Response:
    """Step 3: accept a token only for a handshake WE started with that
    peer (unsolicited tokens are refused)."""
    body = _json_obj(raw, 4096)
    origin = canon_url(body.get("origin"))
    nonce, token = body.get("nonce"), body.get("token")
    if (
        not origin
        or not isinstance(nonce, str)
        or not isinstance(token, str)
        or not 16 <= len(token) <= 256
        or not PEERS.accept_callback(origin, nonce, token)
    ):
        raise FedError(404, "unknown-handshake")
    return Response(status_code=204)


def fed_inbox(
    origin: str = Depends(require_peer),
    raw: bytes = Depends(_raw_body),
    content_encoding: Optional[str] = Header(None),
    db: Session = Depends(get_db),
) -> JSONResponse:
    """A peer delivering one bundle to a user of THIS relay. Stored and
    pushed exactly like a local POST, plus the verified sender relay.
    Never forwarded onward (a relay only relays its own users' sends),
    so there are no loops."""
    payload, _data = _decode_message_body(raw, content_encoding)
    origin_msg_id = payload.get("originMsgId")
    recipient = payload.get("recipientCode")
    body = payload.get("body")
    if not isinstance(origin_msg_id, str) or not 1 <= len(origin_msg_id) <= 64:
        raise FedError(400, "missing-origin-msg-id")
    if not isinstance(recipient, str) or not 1 <= len(recipient) <= 128 or "@" in recipient:
        raise FedError(400, "bad-recipient")
    if not isinstance(body, dict):
        raise FedError(400, "missing-body")
    body["recipientCode"] = recipient  # the bare mailbox id, as a local POST stores it
    dup = (
        db.query(RelayMessage.id)
        .filter(RelayMessage.origin_relay == origin, RelayMessage.origin_msg_id == origin_msg_id)
        .first()
    )
    if dup is not None:
        return JSONResponse({"msgId": dup.id}, status_code=202)
    body_bytes = json.dumps(body, separators=(",", ":")).encode()
    msg_id = uuid.uuid4().hex
    row = RelayMessage(
        id=msg_id,
        recipient_code=recipient,
        body=body,
        body_hash=hashlib.sha256(body_bytes).hexdigest(),
        body_bytes=len(body_bytes),
        origin_relay=origin,
        origin_msg_id=origin_msg_id,
    )
    db.add(row)
    try:
        db.commit()
    except IntegrityError:
        # A concurrent redelivery won the unique index.
        db.rollback()
        dup = (
            db.query(RelayMessage.id)
            .filter(RelayMessage.origin_relay == origin, RelayMessage.origin_msg_id == origin_msg_id)
            .first()
        )
        return JSONResponse({"msgId": dup.id if dup else msg_id}, status_code=202)
    logger.info("[fed] inbox from=%s recipient=%s… msgId=%s", origin, recipient[:8], msg_id[:8])
    if _loop is not None:
        _loop.call_soon_threadsafe(_push_to_streams, recipient, _sse(_message_out(row, body)))
    return JSONResponse({"msgId": msg_id}, status_code=202)


# ── Home side: rooms for remote participants ──


def fed_join_create(
    room_id: str,
    origin: str = Depends(require_peer),
    raw: bytes = Depends(_raw_body),
    db: Session = Depends(get_db),
) -> JSONResponse:
    """A remote participant asks into a room homed here. Idempotent on
    the joiner-minted pass (a resend after a lost response returns the
    same request)."""
    body = _json_obj(raw, LIMITS.fed_join_blob_bytes + 1024)
    p, blob = body.get("pass"), body.get("blob")
    if not isinstance(p, str) or not _PASS_RE.match(p):
        raise FedError(400, "bad-pass")
    if not isinstance(blob, str) or not blob or len(blob) > LIMITS.fed_join_blob_bytes:
        raise FedError(400, "bad-blob")
    if not _ROOM_ID_RE.match(room_id):
        raise HTTPException(404, "no such room")
    h = _sha(p)
    existing = db.query(RelayFedJoinRequest).filter(RelayFedJoinRequest.pass_hash == h).one_or_none()
    if existing is not None:
        if existing.room_id != room_id or existing.origin_url != origin:
            raise FedError(409, "pass-conflict")
        return JSONResponse(_join_state(existing), status_code=202)
    _room_or_error(db, room_id)
    pending = (
        db.query(func.count(RelayFedJoinRequest.id))
        .filter(RelayFedJoinRequest.room_id == room_id, RelayFedJoinRequest.state == "pending")
        .scalar()
    )
    if pending >= LIMITS.fed_join_requests_per_room:
        raise FedError(429, "too-many-join-requests")
    row = RelayFedJoinRequest(
        id=uuid.uuid4().hex, room_id=room_id, origin_url=origin, pass_hash=h, blob=blob, state="pending"
    )
    db.add(row)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        existing = db.query(RelayFedJoinRequest).filter(RelayFedJoinRequest.pass_hash == h).one_or_none()
        if existing is None or existing.room_id != room_id or existing.origin_url != origin:
            raise FedError(409, "pass-conflict")
        return JSONResponse(_join_state(existing), status_code=202)
    _pass_cache_put(h, _row_pass_info(row))
    logger.info("[fed] join request %s… room=%s… from=%s", row.id[:8], room_id[:8], origin)
    if _loop is not None:
        _loop.call_soon_threadsafe(_push_to_room, room_id, _JOIN_FRAME, None, False, True)
    return JSONResponse(_join_state(row), status_code=202)


async def fed_join_self(request: Request, room_id: str, origin: str = Depends(require_peer)) -> JSONResponse:
    """The joiner polls its own request (any state)."""
    info = await _pass_from_request(request, room_id, origin)
    return JSONResponse({"requestId": info.request_id, "state": info.state, "mode": info.mode})


def _withdraw(room_id: str, pass_hash: str, origin: str) -> Optional[_PassInfo]:
    db = SessionLocal()
    try:
        with _room_lock(room_id):
            row = (
                db.query(RelayFedJoinRequest)
                .filter(RelayFedJoinRequest.pass_hash == pass_hash)
                .with_for_update()
                .one_or_none()
            )
            if row is None or row.room_id != room_id or row.origin_url != origin:
                return None
            if row.state in ("pending", "approved"):
                row.state, row.mode, row.decided_at = "withdrawn", None, datetime.utcnow()
                db.commit()
            info = _row_pass_info(row)
    finally:
        db.close()
    _pass_cache_put(pass_hash, info)
    return info


async def fed_join_withdraw(request: Request, room_id: str, origin: str = Depends(require_peer)) -> Response:
    """The joiner withdraws (cancels a pending request, or gives up an
    admission for good)."""
    info = await _pass_from_request(request, room_id, origin)
    after = await run_in_threadpool(_withdraw, room_id, _sha(request.headers.get(_PASS_HDR, "")), origin)
    if after is not None:
        _push_to_room(room_id, _JOIN_FRAME, local_only=True)
        _push_to_request(room_id, info.request_id, _REVOKED_FRAME)
    return Response(status_code=204, headers=_FED_HDRS)


async def fed_stream_room(
    request: Request,
    room_id: str,
    sid: Optional[str] = Query(None, max_length=64),
    info: _PassInfo = Depends(fed_room_access),
) -> StreamingResponse:
    return await _room_stream_response(request, room_id, sid, fed_request=info.request_id)


# ── Home side: local participants decide ──


def list_join_requests(room_id: str, db: Session = Depends(get_db)) -> JSONResponse:
    """Cross-server requests for a room, for its LOCAL participants
    (app token). Pending first-class; approved ones too, so a host can
    see who is in and change their access."""
    _room_or_error(db, room_id)
    rows = (
        db.query(RelayFedJoinRequest)
        .filter(
            RelayFedJoinRequest.room_id == room_id,
            RelayFedJoinRequest.state.in_(("pending", "approved")),
        )
        .order_by(RelayFedJoinRequest.created_at.asc())
        .all()
    )
    out = []
    for row in rows:
        info = PEERS.info_cached(row.origin_url) or PEERS.info(row.origin_url, timeout=3)
        out.append({
            "requestId": row.id,
            "origin": row.origin_url,
            **({"originNickname": info["nickname"]} if info.get("nickname") else {}),
            "blob": row.blob,
            "state": row.state,
            "mode": row.mode,
            "createdAt": _epoch_ms(row.created_at),
        })
    return JSONResponse({"requests": out})


def decide_join_request(
    room_id: str,
    request_id: str,
    raw: bytes = Depends(_raw_body),
    db: Session = Depends(get_db),
) -> Response:
    body = _json_obj(raw, 1024)
    decision = body.get("decision")
    if decision not in ("write", "read", "deny", "revoke"):
        raise FedError(400, "bad-decision")
    with _room_lock(room_id):
        _room_or_error(db, room_id, for_update=True)
        row = (
            db.query(RelayFedJoinRequest)
            .filter(RelayFedJoinRequest.id == request_id, RelayFedJoinRequest.room_id == room_id)
            .with_for_update()
            .one_or_none()
        )
        if row is None:
            raise FedError(404, "no-such-request")
        if row.state in ("expired", "withdrawn"):
            raise FedError(409, "request-closed", state=row.state)
        was_approved, prev_mode = row.state == "approved", row.mode
        if decision in ("write", "read"):
            row.state, row.mode = "approved", decision
        else:
            row.state, row.mode = "denied", None
        row.decided_at = datetime.utcnow()
        db.commit()
        info = _row_pass_info(row)
        pass_hash = row.pass_hash
    _pass_cache_put(pass_hash, info)
    logger.info("[fed] join request %s… → %s", request_id[:8], decision)
    if _loop is not None:
        _loop.call_soon_threadsafe(_push_to_room, room_id, _JOIN_FRAME, None, False, True)
        if was_approved and info.state != "approved":
            _loop.call_soon_threadsafe(_push_to_request, room_id, request_id, _REVOKED_FRAME)
        elif was_approved and info.mode != prev_mode:
            _loop.call_soon_threadsafe(
                _push_to_request, room_id, request_id, _sse({"t": "a", "mode": info.mode})
            )
    return Response(status_code=204)


# ── Joiner side: proxy a remote-homed room for this relay's apps ──

_upstreams: dict[str, int] = {}  # home → open proxied streams (loop-owned)


def _decode_home(home64: str) -> str:
    try:
        raw = base64.urlsafe_b64decode(home64 + "=" * (-len(home64) % 4)).decode("utf-8")
    except Exception:
        raise FedError(400, "bad-home")
    home = canon_url(raw)
    if not home or home != raw:
        raise FedError(400, "bad-home")
    if home == FEDERATION.url:
        # The app should use the plain local routes for its own relay.
        raise FedError(400, "home-is-self")
    return home


async def _ensure_home(home: str) -> dict:
    reason = _static_refusal(home) or await run_in_threadpool(_refusal, home)
    if reason is not None:
        raise _refuse(home, reason, "room home")
    info = PEERS.info_cached(home) or await run_in_threadpool(PEERS.info, home)
    if not info["reachable"]:
        raise FedError(503, "home-unreachable", relay=home)
    if not info["federates"]:
        raise FedError(409, "home-not-federating", relay=home)
    return info


def _proxy_error(e: PeerError, home: str) -> FedError:
    if e.transient:
        return FedError(503, "home-unreachable", relay=home)
    if e.local:
        return FedError(403, "peer-refused", relay=home)
    return FedError(403, "home-refused", relay=home)


def _forward_headers(request: Request) -> dict:
    out = {}
    for name in ("content-type", "content-encoding", "x-cardmirror-version", _PASS_HDR):
        v = request.headers.get(name)
        if v:
            out[name] = v
    # Pass gzip through only when the app itself accepts it.
    out["accept-encoding"] = "gzip" if "gzip" in request.headers.get("accept-encoding", "").lower() else "identity"
    return out


def _passthrough_headers(r: httpx.Response) -> dict:
    out = dict(_FED_HDRS)
    for name in ("content-type", "content-encoding", "vary"):
        if name in r.headers:
            out[name] = r.headers[name]
    return out


async def _proxy_room_call(
    request: Request, home64: str, room_id: str, tail: str, max_body: int, bulk: bool = False
) -> Response:
    home = _decode_home(home64)
    if not _ROOM_ID_RE.match(room_id):
        raise HTTPException(404, "no such room")
    body = await request.body() if request.method in ("POST", "PUT") else b""
    if len(body) > max_body:
        raise FedError(413, "too-large")
    await _ensure_home(home)
    query = request.url.query
    path = f"/federation/v1/rooms/{room_id}/{tail}" + (f"?{query}" if query else "")
    timeout = LIMITS.fed_peer_bulk_timeout_seconds if bulk else LIMITS.fed_peer_timeout_seconds
    try:
        r = await _apeer_send(
            request.method, home, path, content=body or None, headers=_forward_headers(request), timeout=timeout
        )
    except PeerError as e:
        raise _proxy_error(e, home)
    try:
        raw = await _read_raw(r)
    except httpx.HTTPError:
        raise FedError(503, "home-unreachable", relay=home)
    finally:
        await r.aclose()
    if r.status_code in (401, 403) and _err_code(raw) in ("peer-refused", "peer-token-invalid"):
        # The HOME refused this relay (not the app): say so distinctly.
        raise FedError(403, "home-refused", relay=home)
    return Response(raw, status_code=r.status_code, headers=_passthrough_headers(r))


async def via_join_create(request: Request, home64: str, room_id: str) -> Response:
    return await _proxy_room_call(request, home64, room_id, "join-requests", LIMITS.fed_join_blob_bytes + 1024)


async def via_join_self(request: Request, home64: str, room_id: str) -> Response:
    return await _proxy_room_call(request, home64, room_id, "join-requests/self", 0)


async def via_updates(request: Request, home64: str, room_id: str) -> Response:
    return await _proxy_room_call(request, home64, room_id, "updates", LIMITS.max_update_bytes, bulk=True)


async def via_snapshot(request: Request, home64: str, room_id: str) -> Response:
    return await _proxy_room_call(request, home64, room_id, "snapshot", LIMITS.max_snapshot_bytes + 4096, bulk=True)


async def via_presence(request: Request, home64: str, room_id: str) -> Response:
    return await _proxy_room_call(request, home64, room_id, "presence", LIMITS.max_presence_bytes)


async def via_stream(request: Request, home64: str, room_id: str) -> Response:
    """One upstream SSE per app stream, piped byte-for-byte: hello, u/p/
    end frames, heartbeats, and the access frames (a/x). One-to-one, so
    the home's participant cap and sid-based echo suppression stay exact,
    and backpressure carries through (a slow app stops us reading; the
    home's outbox overflows and closes; the app reconnects + catches up)."""
    home = _decode_home(home64)
    if not _ROOM_ID_RE.match(room_id):
        raise HTTPException(404, "no such room")
    info = await _ensure_home(home)
    if _upstreams.get(home, 0) >= LIMITS.fed_max_upstreams_per_peer:
        raise FedError(503, "too-many-upstreams", relay=home)
    query = request.url.query
    path = f"/federation/v1/rooms/{room_id}/stream" + (f"?{query}" if query else "")
    headers = {**_forward_headers(request), "accept": "text/event-stream", "accept-encoding": "identity"}
    try:
        hb = int(info["limits"].get("heartbeatSeconds") or LIMITS.heartbeat_seconds)
    except (TypeError, ValueError):
        hb = LIMITS.heartbeat_seconds
    # Read timeout well past the home's heartbeat: silence that long
    # means a dead upstream — close, and the app reconnects.
    timeout = httpx.Timeout(LIMITS.fed_peer_timeout_seconds, read=hb * 3 + 10)
    try:
        r = await _apeer_send("GET", home, path, headers=headers, timeout=timeout)
    except PeerError as e:
        raise _proxy_error(e, home)
    if r.status_code != 200:
        try:
            raw = await _read_raw(r)
        except httpx.HTTPError:
            raw = b""
        finally:
            await r.aclose()
        if r.status_code in (401, 403) and _err_code(raw) in ("peer-refused", "peer-token-invalid"):
            raise FedError(403, "home-refused", relay=home)
        return Response(raw, status_code=r.status_code, headers=_passthrough_headers(r))
    _upstreams[home] = _upstreams.get(home, 0) + 1

    async def gen() -> AsyncIterator[bytes]:
        try:
            async for chunk in r.aiter_raw():
                yield chunk
        except httpx.HTTPError:
            return  # upstream dropped: close ours, the app reconnects
        finally:
            n = _upstreams.get(home, 1) - 1
            if n > 0:
                _upstreams[home] = n
            else:
                _upstreams.pop(home, None)
            # An app disconnect arrives as a cancellation; shield the close
            # or the home keeps our seat until its next heartbeat write.
            with anyio.CancelScope(shield=True):
                await r.aclose()

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", **_FED_HDRS},
    )


# ── Card sharing: outbox (apps → other relays) ──

_outbox_wake = threading.Event()
_delivery_pool: Optional[ThreadPoolExecutor] = None
_OUTBOX_BATCH = 50
_OUTBOX_LEASE = timedelta(seconds=120)


def fed_outbox_post(
    raw: bytes = Depends(_raw_body),
    content_encoding: Optional[str] = Header(None),
    db: Session = Depends(get_db),
) -> JSONResponse:
    """An app sends a bundle to a user on another relay. Same body as
    POST /relay/messages plus `recipientRelay`. Refusals that can be known
    now are answered now (policy, non-federating peer, oversize);
    everything else is store-and-forward."""
    payload, data = _decode_message_body(raw, content_encoding)
    recipient = payload.get("recipientCode")
    if not isinstance(recipient, str) or not 1 <= len(recipient) <= 128 or "@" in recipient:
        raise HTTPException(400, "missing recipientCode")
    peer = canon_url(payload.pop("recipientRelay", None))
    if not peer:
        raise FedError(400, "bad-recipient-relay")
    if peer == FEDERATION.url:
        # Addressed to our own users after all: an ordinary local send.
        return JSONResponse(
            {"msgId": _store_local_message(db, recipient, payload, data), "queued": False}, status_code=202
        )
    reason = _refusal(peer)
    if reason is not None:
        raise _refuse(peer, reason, "card recipient relay")
    info = PEERS.info(peer, timeout=5)
    if info["reachable"] and not info["federates"]:
        raise FedError(409, "peer-not-federating", relay=peer)
    body_bytes = json.dumps(payload, separators=(",", ":")).encode()
    cap = info["limits"].get("maxMessageBytes")
    if isinstance(cap, int) and len(body_bytes) > cap:
        raise FedError(413, "too-large-for-peer", relay=peer, maxMessageBytes=cap)
    digest = hashlib.sha256(body_bytes).hexdigest()
    # Retry dedupe, as on the local route: an identical resend while the
    # first is still queued is the same send.
    dup = (
        db.query(RelayFedOutbox.id)
        .filter(
            RelayFedOutbox.peer_url == peer,
            RelayFedOutbox.recipient_code == recipient,
            RelayFedOutbox.body_hash == digest,
        )
        .first()
    )
    if dup is not None:
        return JSONResponse({"msgId": dup.id, "queued": True}, status_code=202)
    msg_id = uuid.uuid4().hex
    db.add(RelayFedOutbox(
        id=msg_id,
        peer_url=peer,
        recipient_code=recipient,
        body=payload,
        body_hash=digest,
        body_bytes=len(body_bytes),
        next_attempt_at=datetime.utcnow(),
    ))
    db.commit()
    _outbox_wake.set()
    logger.info("[fed] queued %s… → %s", msg_id[:8], peer)
    out = {"msgId": msg_id, "queued": True}
    if not info["reachable"]:
        out["peerState"] = "unreachable"
    return JSONResponse(out, status_code=202)


def _backoff_seconds(attempts: int) -> float:
    base = min(3600.0, 5.0 * 2 ** max(0, attempts - 1))
    return base * (0.7 + random.random() * 0.6)


def _deliver_peer(jobs: list) -> list:
    """Deliver one peer's claimed rows, serially. After the first
    transient failure the peer is treated as down for this round: its
    remaining rows are rescheduled untried, so a dead peer costs one
    timeout, not one per message. → [(msgId, outcome, delay, error)]."""
    results = []
    down: Optional[str] = None
    expiry = datetime.utcnow() - LIMITS.message_ttl
    for mid, peer, recipient, body, created_at, attempts in jobs:
        if created_at < expiry:
            results.append((mid, "drop", 0, "expired"))
            continue
        if down is not None:
            results.append((mid, "retry", _backoff_seconds(attempts), down))
            continue
        payload = json.dumps(
            {"originMsgId": mid, "recipientCode": recipient, "body": body}, separators=(",", ":")
        ).encode()
        try:
            r = _peer_call(
                "POST", peer, "/federation/v1/inbox",
                content=gzip.compress(payload, 6),
                headers={"content-type": "application/json", "content-encoding": "gzip"},
                timeout=LIMITS.fed_peer_bulk_timeout_seconds,
            )
        except PeerError as e:
            down = e.code
            delay = _backoff_seconds(attempts) if e.transient else 3600
            results.append((mid, "retry", delay, e.code))
            continue
        except SATimeoutError:
            down = "relay-busy"
            results.append((mid, "retry", _backoff_seconds(attempts), down))
            continue
        s = r.status_code
        if 200 <= s < 300:
            results.append((mid, "done", 0, None))
        elif s in (400, 404, 413, 422):
            results.append((mid, "drop", 0, _err_code(r.content) or str(s)))
        elif s in (401, 403, 429):
            down = _err_code(r.content) or str(s)
            results.append((mid, "retry", 60 if s == 429 else 3600, down))
        else:
            down = str(s)
            results.append((mid, "retry", _backoff_seconds(attempts), down))
    return results


def _deliver_batch() -> bool:
    """Claim due rows (lease), deliver them with NO DB connection held,
    record the outcomes. True when the batch was full (more may be due)."""
    now = datetime.utcnow()
    db = SessionLocal()
    try:
        rows = (
            db.query(RelayFedOutbox)
            .filter(RelayFedOutbox.next_attempt_at <= now)
            .order_by(RelayFedOutbox.next_attempt_at.asc())
            .limit(_OUTBOX_BATCH)
            .with_for_update(skip_locked=True)
            .all()
        )
        jobs = []
        for row in rows:
            # The lease: if we crash mid-delivery the row comes due again
            # and is redelivered — the peer dedupes on our msgId.
            row.next_attempt_at = now + _OUTBOX_LEASE
            row.attempts = row.attempts + 1
            jobs.append((row.id, row.peer_url, row.recipient_code, row.body, row.created_at, row.attempts))
        db.commit()
    finally:
        db.close()
    if not jobs:
        return False
    by_peer: dict[str, list] = {}
    for job in jobs:
        by_peer.setdefault(job[1], []).append(job)
    results = [r for batch in _delivery_pool.map(_deliver_peer, by_peer.values()) for r in batch]
    db = SessionLocal()
    try:
        done = [mid for mid, outcome, _, _ in results if outcome in ("done", "drop")]
        if done:
            db.query(RelayFedOutbox).filter(RelayFedOutbox.id.in_(done)).delete(synchronize_session=False)
        for mid, outcome, delay, err in results:
            if outcome == "retry":
                db.query(RelayFedOutbox).filter(RelayFedOutbox.id == mid).update(
                    {
                        "next_attempt_at": datetime.utcnow() + timedelta(seconds=delay),
                        "last_error": (err or "")[:200],
                    },
                    synchronize_session=False,
                )
        db.commit()
    finally:
        db.close()
    for mid, outcome, _, err in results:
        if outcome == "done":
            logger.info("[fed] delivered %s…", mid[:8])
        elif outcome == "drop":
            logger.info("[fed] dropped %s… reason=%s", mid[:8], err)
    retried = {err for _, outcome, _, err in results if outcome == "retry"}
    if retried:
        logger.info("[fed] delivery deferred (%s)", ", ".join(sorted(e or "?" for e in retried)))
    return len(jobs) == _OUTBOX_BATCH


def _delivery_loop() -> None:
    while True:
        _outbox_wake.wait(5)
        _outbox_wake.clear()
        try:
            while _deliver_batch():
                pass
        except Exception as e:  # never let delivery kill the thread
            logger.warning("[fed] delivery error: %s", e)


def fed_peer_info(url: str = Query(..., max_length=600)) -> JSONResponse:
    """Label / probe another relay for this relay's apps, from the cache
    (apps never contact foreign relays themselves)."""
    peer = canon_url(url)
    if not peer:
        raise FedError(400, "bad-url")
    if peer == FEDERATION.url:
        return JSONResponse({
            "url": peer, "self": True, "permitted": True, "reachable": True, "federates": True,
            "nickname": FEDERATION.nickname or None,
        })
    refusal = _refusal(peer)
    permitted = refusal is None
    info = PEERS.info(peer, timeout=5) if permitted else {"reachable": None, "federates": None, "nickname": None}
    return JSONResponse({
        "url": peer, "self": False, "permitted": permitted,
        # Why not, for the operator ("private-address", "http-not-allowed", …).
        **({"refusal": refusal} if refusal else {}),
        "reachable": info["reachable"], "federates": info["federates"], "nickname": info["nickname"],
    })


# ── Wiring ──


def _register_federation() -> None:
    feature("client.versionFlags")
    feature("federation.mailbox")
    feature("federation.rooms")
    feature("federation.joinRequests", modes=["write", "read"])
    app_auth = [Depends(require_relay_token)]
    add = app.add_api_route
    # Relay ↔ relay
    add("/relay/federation/v1/handshake", fed_handshake, methods=["POST"])
    add("/relay/federation/v1/handshake/callback", fed_handshake_callback, methods=["POST"], status_code=204)
    add("/relay/federation/v1/inbox", fed_inbox, methods=["POST"], status_code=202)
    fed_rooms = "/relay/federation/v1/rooms/{room_id}"
    add(f"{fed_rooms}/join-requests", fed_join_create, methods=["POST"], status_code=202)
    add(f"{fed_rooms}/join-requests/self", fed_join_self, methods=["GET"])
    add(f"{fed_rooms}/join-requests/self", fed_join_withdraw, methods=["DELETE"], status_code=204)
    # Room data for accepted remote participants: the SAME handlers the
    # local routes use (one seq authority, untouched §11 logic), behind
    # peer auth + an accepted pass instead of the app token.
    add(f"{fed_rooms}/updates", get_room_updates, methods=["GET"], dependencies=[Depends(fed_room_access)])
    add(f"{fed_rooms}/updates", post_room_update, methods=["POST"], status_code=202,
        dependencies=[Depends(fed_room_write)])
    add(f"{fed_rooms}/snapshot", post_room_snapshot, methods=["POST"], status_code=204,
        dependencies=[Depends(fed_room_write)])
    add(f"{fed_rooms}/presence", post_room_presence, methods=["POST"], status_code=202,
        dependencies=[Depends(fed_room_access)])
    add(f"{fed_rooms}/stream", fed_stream_room, methods=["GET"])
    # App → own relay
    add("/relay/federation/v1/outbox", fed_outbox_post, methods=["POST"], status_code=202, dependencies=app_auth)
    add("/relay/federation/v1/peer", fed_peer_info, methods=["GET"], dependencies=app_auth)
    add("/relay/rooms/{room_id}/join-requests", list_join_requests, methods=["GET"], dependencies=app_auth)
    add("/relay/rooms/{room_id}/join-requests/{request_id}", decide_join_request, methods=["POST"],
        status_code=204, dependencies=app_auth)
    via = "/relay/federation/v1/via/{home64}/rooms/{room_id}"
    add(f"{via}/join-requests", via_join_create, methods=["POST"], dependencies=app_auth)
    add(f"{via}/join-requests/self", via_join_self, methods=["GET", "DELETE"], dependencies=app_auth)
    add(f"{via}/updates", via_updates, methods=["GET", "POST"], dependencies=app_auth)
    add(f"{via}/snapshot", via_snapshot, methods=["POST"], dependencies=app_auth)
    add(f"{via}/presence", via_presence, methods=["POST"], dependencies=app_auth)
    add(f"{via}/stream", via_stream, methods=["GET"], dependencies=app_auth)


def _federation_start() -> None:
    global _http, _ahttp, _delivery_pool
    _http = httpx.Client(follow_redirects=False, headers=_UA, timeout=LIMITS.fed_peer_timeout_seconds)
    _ahttp = httpx.AsyncClient(
        follow_redirects=False,
        timeout=LIMITS.fed_peer_timeout_seconds,
        # Each proxied stream holds a connection for its lifetime.
        limits=httpx.Limits(max_connections=None, max_keepalive_connections=256),
    )
    _delivery_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="fed-deliver")
    threading.Thread(target=_delivery_loop, daemon=True, name="fed-delivery").start()
    _outbox_wake.set()  # deliver anything left from before a restart
    logger.info(
        "[fed] federation on as %s%s", FEDERATION.url,
        f" ({FEDERATION.nickname})" if FEDERATION.nickname else "",
    )


async def _federation_stop() -> None:
    if _ahttp is not None:
        await _ahttp.aclose()
    if _http is not None:
        _http.close()


if FEDERATION.enabled:
    _register_federation()
