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

  POST   /relay/rooms                       create → {roomId}
  POST   /relay/rooms/{id}/updates          append opaque blob → {seq}
  GET    /relay/rooms/{id}/updates?after=N  snapshot (if N predates it) + tail
  GET    /relay/rooms/{id}/stream           SSE: hello{lastSeq}, update/presence frames
  POST   /relay/rooms/{id}/snapshot         {blob, coversThroughSeq} → truncates ≤ seq
  POST   /relay/rooms/{id}/presence         ephemeral fan-out, never stored
  DELETE /relay/rooms/{id}                  end session (tombstone → 410)

This is the same wire contract CardMirror's official relay speaks, so
pointing the app at your own deployment is just Settings → Card Sharing →
Custom relay URL + Custom relay token. Everyone sharing cards with each
other must use the same relay.

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
  - At most MAX_STREAMS_PER_ROOM concurrent streams per room (409 on
    the next), which is also the participant ceiling.

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

See README.md for one-command deployment with docker compose.
"""
import asyncio
import base64
import gzip
import hashlib
import hmac
import json
import logging
import os
import re
import threading
import time
import uuid
from collections import deque
from contextlib import asynccontextmanager
from dataclasses import dataclass, field, fields
from datetime import datetime, timedelta, timezone
from typing import AsyncIterator, Optional

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
    String,
    Text,
    cast,
    create_engine,
    func,
    text,
)
from starlette.concurrency import run_in_threadpool
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.exc import TimeoutError as SATimeoutError
from sqlalchemy.orm import Session, declarative_base, sessionmaker

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("relay")

# ── Storage ──────────────────────────────────────────────────────────

DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    raise RuntimeError("DATABASE_URL environment variable is required")

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
    max_streams_per_room: int = field(default=10, metadata=_public("maxStreamsPerRoom"))  # participant ceiling
    # Must exceed travel day + tournament weekend.
    room_idle_gc_seconds: int = field(default=7 * 86400, metadata=_public("roomIdleGcSeconds"))

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

    __slots__ = ("_frames", "_bytes", "_wake", "overflowed")

    def __init__(self) -> None:
        self._frames: deque[str] = deque()
        self._bytes = 0
        self._wake = asyncio.Event()
        self.overflowed = False

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
        """Next frame, or None on timeout / overflow (check `overflowed`)."""
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
    room_id: str, frame: str, skip_sid: Optional[str] = None, droppable: bool = False
) -> None:
    """Runs ON the loop. `skip_sid` (presence only): no self-echo to the
    sender's stream."""
    for box, sid in list(_room_streams.get(room_id, {}).items()):
        if skip_sid is not None and sid == skip_sid:
            continue
        box.put(frame, droppable=droppable)


def _drop_room_stream(room_id: str, box: _Outbox) -> None:
    peers = _room_streams.get(room_id)
    if peers is not None:
        peers.pop(box, None)
        if not peers:
            _room_streams.pop(room_id, None)


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
        if room.tombstoned:
            db.delete(room)
        else:
            room.tombstoned = True
            room.bytes_used = 0
            ended.append(room.id)
    db.commit()
    # Same signal as DELETE: anyone still connected learns the session ended.
    if _loop is not None:
        for room_id in ended:
            _loop.call_soon_threadsafe(_push_to_room, room_id, _END_FRAME)
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


@asynccontextmanager
async def _lifespan(_app: FastAPI):
    global _loop
    _loop = asyncio.get_running_loop()
    Base.metadata.create_all(engine)
    _migrate()
    _build_capabilities()
    threading.Thread(target=_sweeper_loop, daemon=True).start()
    yield


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
)


@app.exception_handler(SATimeoutError)
async def _pool_exhausted(_request: Request, _exc: SATimeoutError) -> JSONResponse:
    # Connection-pool checkout timed out: the server is at capacity.
    # Shed with a clean 503 — clients retry (send is user-driven; polls
    # retry next interval; streams reconnect with backoff).
    return JSONResponse({"detail": "relay busy, retry shortly"}, status_code=503)


# ── Auth ─────────────────────────────────────────────────────────────


_VER_RE = re.compile(r"^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$")
_PRE_RANK = {"alpha": 0, "beta": 1, "rc": 2}


def _parse_version(s: str):
    """Prerelease-aware key for CardMirror's version shapes, or None."""
    m = _VER_RE.match(s.strip())
    if not m:
        return None
    core = (int(m.group(1)), int(m.group(2)), int(m.group(3)))
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
@app.post("/relay/messages", status_code=202, dependencies=[Depends(require_relay_token)])
def post_message(
    raw: bytes = Depends(_raw_body),
    content_encoding: Optional[str] = Header(None),
    db: Session = Depends(get_db),
) -> JSONResponse:
    if len(raw) > LIMITS.max_compressed_bytes:
        raise HTTPException(413, "payload too large")

    if "gzip" in (content_encoding or "").lower():
        try:
            data = gzip.decompress(raw)
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
    recipient = payload.get("recipientCode")
    if not isinstance(recipient, str) or not recipient:
        raise HTTPException(400, "missing recipientCode")

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
        return JSONResponse({"msgId": dup.id}, status_code=202)

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
        frame = _sse({**payload, "msgId": msg_id, "receivedAt": _epoch_ms(row.created_at)})
        _loop.call_soon_threadsafe(_push_to_streams, recipient, frame)
    return JSONResponse({"msgId": msg_id}, status_code=202)


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
    messages = [
        {**row.body, "msgId": row.id, "receivedAt": _epoch_ms(row.created_at)}
        for row in rows
    ]
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


def _room_or_error(db: Session, room_id: str, for_update: bool = False) -> RelayRoom:
    query = db.query(RelayRoom).filter(RelayRoom.id == room_id)
    if for_update:
        query = query.with_for_update()
    room = query.one_or_none()
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
    return JSONResponse({"roomId": room_id}, status_code=201)


@app.post(
    "/relay/rooms/{room_id}/updates",
    status_code=202,
    dependencies=[Depends(require_relay_token)],
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


@app.get("/relay/rooms/{room_id}/updates", dependencies=[Depends(require_relay_token)])
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
    dependencies=[Depends(require_relay_token)],
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


@app.post(
    "/relay/rooms/{room_id}/presence",
    status_code=202,
    dependencies=[Depends(require_relay_token)],
)
async def post_room_presence(
    room_id: str,
    request: Request,
    sender: Optional[str] = Query(None, alias="from", max_length=64),
) -> JSONResponse:
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
    _push_to_room(room_id, _sse({"t": "p", "blob": b64}), skip_sid=sender, droppable=True)
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


@app.get("/relay/rooms/{room_id}/stream", dependencies=[Depends(require_relay_token)])
async def stream_room(
    request: Request,
    room_id: str,
    sid: Optional[str] = Query(None, max_length=64),
) -> StreamingResponse:
    """SSE: `event: hello` with the current cursor, then update/presence
    frames. The participant cap is enforced here — holding a stream IS
    being in the room."""
    # Check-and-register with no await in between, so concurrent connects
    # cannot both take the last slot. Registering BEFORE reading lastSeq
    # also means an update committed during connect is either covered by
    # hello.lastSeq or buffered in the outbox — never neither.
    if len(_room_streams.get(room_id, {})) >= LIMITS.max_streams_per_room:
        raise HTTPException(409, "room is full")
    box = _Outbox()
    _room_streams.setdefault(room_id, {})[box] = sid
    try:
        last_seq = await run_in_threadpool(_open_room_stream, room_id)
    except BaseException:
        _drop_room_stream(room_id, box)
        raise

    async def gen() -> AsyncIterator[str]:
        try:
            yield f'event: hello\ndata: {{"lastSeq":{last_seq}}}\n\n'
            while True:
                if await request.is_disconnected():
                    return
                frame = await box.get(LIMITS.heartbeat_seconds)
                if box.overflowed:
                    # Plain close, NOT an end frame: the client reconnects
                    # and catches up via GET ?after=.
                    logger.info("[relay] room stream %s… overflowed, closing", room_id[:8])
                    return
                if frame is None:
                    yield ": hb\n\n"
                    continue
                yield frame
                if frame == _END_FRAME:
                    return
        finally:
            _drop_room_stream(room_id, box)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.delete(
    "/relay/rooms/{room_id}",
    status_code=204,
    dependencies=[Depends(require_relay_token)],
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
            db.commit()
            if _loop is not None:
                _loop.call_soon_threadsafe(_push_to_room, room_id, _END_FRAME)
    return Response(status_code=204)
