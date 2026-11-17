"""Federation end to end, against real relays (see conftest.py).

Covers FEDERATION.md: capabilities and compatibility, dialback peering,
cross-relay card sharing (incl. store-and-forward across a peer
restart and redelivery dedupe), and remote co-editing (join requests,
read-only, revocation, live streams, caps, room end)."""
import base64
import json
import secrets
import threading
import time

import httpx
import sqlalchemy


def b64url(s: str) -> str:
    return base64.urlsafe_b64encode(s.encode()).decode().rstrip("=")


def via(home, room_id: str) -> str:
    return f"/federation/v1/via/{b64url(home.base)}/rooms/{room_id}"


def wait_for(pred, timeout=15.0, step=0.1):
    deadline = time.time() + timeout
    while time.time() < deadline:
        v = pred()
        if v:
            return v
        time.sleep(step)
    raise AssertionError("condition not met in time")


class Sse:
    """Reads an SSE stream in a thread: frames → list of (event, data)."""

    def __init__(self, relay, path: str, headers: dict | None = None):
        self.frames: list[tuple[str, str]] = []
        self.status = None
        self.closed = threading.Event()
        self.opened = threading.Event()
        self._client = httpx.Client(
            base_url=relay.base, headers={**relay.auth, **(headers or {})}, timeout=httpx.Timeout(10, read=90)
        )
        self._t = threading.Thread(target=self._run, args=(path,), daemon=True)
        self._t.start()
        self.opened.wait(15)

    def _run(self, path):
        try:
            with self._client.stream("GET", path) as r:
                self.status = r.status_code
                self.opened.set()
                if r.status_code != 200:
                    self.body = r.read()
                    return
                ev, data = "", []
                for line in r.iter_lines():
                    if line == "":
                        self.frames.append((ev, "\n".join(data)))
                        ev, data = "", []
                    elif line.startswith(":"):
                        continue
                    elif line.startswith("event:"):
                        ev = line[6:].strip()
                    elif line.startswith("data:"):
                        data.append(line[5:].strip())
        except Exception:
            pass
        finally:
            self.opened.set()
            self.closed.set()

    def data(self) -> list[dict]:
        out = []
        for ev, d in list(self.frames):
            if ev == "" and d:
                try:
                    out.append(json.loads(d))
                except ValueError:
                    pass
        return out

    def close(self):
        self._client.close()


def mint_pass() -> str:
    return secrets.token_urlsafe(24)


# ── capabilities & compatibility ──


def test_capabilities_advertise_federation(relays):
    a, c = relays["a"], relays["c"]
    caps = httpx.get(f"{a.base}/capabilities").json()
    assert caps["federation"] == {"protocol": 1, "url": a.base, "nickname": "Alpha"}
    for f in ("client.versionFlags", "federation.mailbox", "federation.rooms", "federation.joinRequests"):
        assert f in caps["features"], f
    assert caps["limits"]["joinRequestTtlSeconds"] == 86400
    # Federation off: no block, no flags, no federation routes.
    caps_c = httpx.get(f"{c.base}/capabilities").json()
    assert "federation" not in caps_c
    assert not any(k.startswith(("federation.", "client.")) for k in caps_c["features"])
    assert not any("federation" in e["path"] or "join-requests" in e["path"] for e in caps_c["endpoints"])
    assert httpx.post(f"{c.base}/federation/v1/outbox", headers=c.auth, json={}).status_code == 404


def test_version_flags_pass_the_gate(relays):
    d = relays["d"]
    def gate(version):
        h = {**d.auth, **({"X-CardMirror-Version": version} if version else {})}
        return httpx.post(f"{d.base}/rooms", headers=h).status_code
    # Flags never take part in ordering: 1.15.0-f IS 1.15.0.
    assert gate("1.15.0-f") == 201
    assert gate("1.15.0") == 201
    assert gate("1.16.0-beta.2-f") == 201
    assert gate("1.14.9-f") == 426
    assert gate("1.15.0-beta.1-f") == 426
    assert gate(None) == 426
    caps = httpx.get(f"{d.base}/capabilities").json()
    assert "client.versionFlags" in caps["features"]
    assert caps["versionGate"] == {"minClientVersion": "1.15.0", "scope": "all"}
    # Proxied calls carry the app's version too and are gated the same way.
    r = httpx.get(f"{d.base}/federation/v1/via/{b64url(relays['a'].base)}/rooms/{'0' * 32}/updates",
                  headers={**d.auth, "X-CardMirror-Version": "1.0.0-f"})
    assert r.status_code == 426


def test_create_room_reports_home(relays):
    a, c = relays["a"], relays["c"]
    assert a.client().post("/rooms").json()["home"] == a.base
    assert "home" not in c.client().post("/rooms").json()


def test_peer_info(relays):
    a, b, c = relays["a"], relays["b"], relays["c"]
    with a.client() as ca:
        me = ca.get("/federation/v1/peer", params={"url": a.base + "/"}).json()
        assert me["self"] is True and me["nickname"] == "Alpha"
        pb = ca.get("/federation/v1/peer", params={"url": b.base}).json()
        assert pb == {"url": b.base, "self": False, "permitted": True, "reachable": True,
                      "federates": True, "nickname": "Beta"}
        pc = ca.get("/federation/v1/peer", params={"url": c.base}).json()
        assert pc["reachable"] is True and pc["federates"] is False and pc["nickname"] is None
        denied = ca.get("/federation/v1/peer", params={"url": "https://denied.invalid/relay"}).json()
        assert denied["permitted"] is False
        assert ca.get("/federation/v1/peer", params={"url": "ftp://x"}).json()["error"] == "bad-url"


# ── peering ──


def test_peer_auth_required(relays):
    b = relays["b"]
    body = {"originMsgId": "x", "recipientCode": "r", "body": {}}
    r = httpx.post(f"{b.base}/federation/v1/inbox", json=body)
    assert r.status_code == 401 and r.json()["error"] == "peer-token-invalid"
    r = httpx.post(f"{b.base}/federation/v1/inbox", json=body,
                   headers={"X-CardMirror-Peer": relays["a"].base, "X-CardMirror-Peer-Token": "forged"})
    assert r.status_code == 401
    # An unsolicited dialback callback is refused.
    r = httpx.post(f"{b.base}/federation/v1/handshake/callback",
                   json={"origin": relays["a"].base, "nonce": "n" * 20, "token": "t" * 30})
    assert r.status_code == 404 and r.json()["error"] == "unknown-handshake"


def test_refusals_say_why(relays):
    """A relay without RELAY_FEDERATION_ALLOW_PRIVATE refuses LAN /
    loopback peers — and says so, to the app and in its log."""
    a, e = relays["a"], relays["e"]
    r = _send(e, "r", a.base, "x")
    assert r.status_code == 403
    assert r.json() == {"error": "peer-refused", "detail": "peer-refused", "relay": a.base,
                        "reason": "private-address"}
    r = e.client().get(f"/federation/v1/via/{b64url(a.base)}/rooms/{'0' * 32}/updates")
    assert r.status_code == 403 and r.json()["reason"] == "private-address"
    info = e.client().get("/federation/v1/peer", params={"url": a.base}).json()
    assert info["permitted"] is False and info["refusal"] == "private-address"
    assert "RELAY_FEDERATION_ALLOW_PRIVATE=1" in e.log.read_text()
    # A deny-listed peer reports that reason instead.
    info = a.client().get("/federation/v1/peer", params={"url": "https://denied.invalid/relay"}).json()
    assert info["refusal"] == "denied"


def test_handshake_to_unreachable_origin_fails(relays):
    b = relays["b"]
    r = httpx.post(f"{b.base}/federation/v1/handshake",
                   json={"origin": "http://127.0.0.1:9/relay", "nonce": "n" * 24})
    assert r.status_code == 502 and r.json()["error"] == "callback-failed"


# ── card sharing ──


def _send(relay, recipient: str, recipient_relay: str, ct: str):
    return relay.client().post("/federation/v1/outbox", json={
        "v": 1, "recipientCode": recipient, "recipientRelay": recipient_relay,
        "sentAt": 1, "epk": "e", "iv": "i", "ct": ct, "tag": "t",
    })


def test_mailbox_cross_relay_delivery_poll_and_push(relays):
    a, b = relays["a"], relays["b"]
    rcpt = "bob-" + secrets.token_hex(4)
    sse = Sse(b, f"/stream?recipient={rcpt}")
    try:
        r = _send(a, rcpt, b.base, "card-1")
        assert r.status_code == 202, r.text
        assert r.json()["queued"] is True and "peerState" not in r.json()
        pushed = wait_for(lambda: [d for d in sse.data() if d.get("ct") == "card-1"])
        assert pushed[0]["viaRelay"] == a.base
        assert pushed[0]["recipientCode"] == rcpt
        assert "recipientRelay" not in pushed[0]
    finally:
        sse.close()
    msgs = b.client().get("/messages", params={"recipient": rcpt}).json()["messages"]
    assert [m["ct"] for m in msgs] == ["card-1"] and msgs[0]["viaRelay"] == a.base
    # ack on B, the recipient's own relay, as today
    assert b.client().delete(f"/messages/{msgs[0]['msgId']}").status_code == 204


def test_mailbox_resend_while_queued_dedupes(relays):
    a = relays["a"]
    # An unreachable peer keeps the row queued.
    peer = "http://127.0.0.1:9/relay"
    r1 = _send(a, "r", peer, "same")
    r2 = _send(a, "r", peer, "same")
    assert r1.status_code == r2.status_code == 202
    assert r1.json()["peerState"] == "unreachable"
    assert r1.json()["msgId"] == r2.json()["msgId"]


def test_mailbox_refusals(relays):
    a, c = relays["a"], relays["c"]
    r = _send(a, "r", c.base, "x")
    assert r.status_code == 409 and r.json()["error"] == "peer-not-federating"
    r = _send(a, "r", "https://denied.invalid/relay", "x")
    assert r.status_code == 403 and r.json()["error"] == "peer-refused"
    assert r.json()["reason"] == "denied"
    r = _send(a, "r", "not a url", "x")
    assert r.status_code == 400
    r = a.client().post("/federation/v1/outbox", json={"recipientCode": "a@b", "recipientRelay": c.base})
    assert r.status_code == 400


def test_mailbox_to_self_is_local(relays):
    a = relays["a"]
    rcpt = "self-" + secrets.token_hex(4)
    r = _send(a, rcpt, a.base + "/", "local")
    assert r.status_code == 202 and r.json()["queued"] is False
    msgs = a.client().get("/messages", params={"recipient": rcpt}).json()["messages"]
    assert [m["ct"] for m in msgs] == ["local"] and "viaRelay" not in msgs[0]


def test_mailbox_store_and_forward_across_peer_restart(relays):
    a, b = relays["a"], relays["b"]
    rcpt = "offline-" + secrets.token_hex(4)
    # Make sure A has peered with B and knows it federates (cached), then
    # take B down: the send is accepted and queued.
    assert _send(a, "warm-" + secrets.token_hex(2), b.base, "warm").status_code == 202
    b.stop()
    try:
        r = _send(a, rcpt, b.base, "while-down")
        assert r.status_code == 202
    finally:
        b.start()
    # Delivery retries with backoff (first retries are seconds apart).
    msgs = wait_for(
        lambda: b.client().get("/messages", params={"recipient": rcpt}).json()["messages"], timeout=60
    )
    assert [m["ct"] for m in msgs] == ["while-down"]


def test_inbox_redelivery_dedupes(relays):
    a, b = relays["a"], relays["b"]
    # Ensure A holds a token for B, then replay a delivery with it.
    assert _send(a, "warm2", b.base, "warm2").status_code == 202
    eng = sqlalchemy.create_engine(a.db_url)
    tok = wait_for(lambda: eng.connect().execute(
        sqlalchemy.text("SELECT token FROM relay_fed_tokens WHERE id = :i"), {"i": f"out:{b.base}"}
    ).scalar())
    eng.dispose()
    hdrs = {"X-CardMirror-Peer": a.base, "X-CardMirror-Peer-Token": tok}
    body = {"originMsgId": "replay-1", "recipientCode": "dup-rcpt", "body": {"ct": "once", "recipientCode": "dup-rcpt"}}
    r1 = httpx.post(f"{b.base}/federation/v1/inbox", json=body, headers=hdrs)
    r2 = httpx.post(f"{b.base}/federation/v1/inbox", json=body, headers=hdrs)
    assert r1.status_code == r2.status_code == 202
    assert r1.json()["msgId"] == r2.json()["msgId"]
    msgs = b.client().get("/messages", params={"recipient": "dup-rcpt"}).json()["messages"]
    assert len(msgs) == 1
    # A peer cannot address a qualified (forwarding) recipient.
    bad = {**body, "originMsgId": "replay-2", "recipientCode": "x@elsewhere"}
    assert httpx.post(f"{b.base}/federation/v1/inbox", json=bad, headers=hdrs).status_code == 400


# ── co-editing ──


def _room(home) -> str:
    return home.client().post("/rooms").json()["roomId"]


def _join(joiner_relay, home, room_id: str, p: str, blob: str = "c2VhbGVk"):
    return joiner_relay.client().post(f"{via(home, room_id)}/join-requests", json={"pass": p, "blob": blob})


def _decide(home, room_id, request_id, decision):
    return home.client().post(f"/rooms/{room_id}/join-requests/{request_id}", json={"decision": decision})


def test_remote_join_request_lifecycle(relays):
    a, b = relays["a"], relays["b"]
    room = _room(a)
    host_stream = Sse(a, f"/rooms/{room}/stream?sid=host")
    p = mint_pass()
    jb = b.client(headers={**b.auth, "X-CardMirror-Room-Pass": p})
    try:
        r = _join(b, a, room, p)
        assert r.status_code == 202, r.text
        assert r.headers["x-cardmirror-federation"] == "1"
        req = r.json()
        assert req["state"] == "pending" and req["mode"] is None
        # Idempotent on the pass.
        assert _join(b, a, room, p).json()["requestId"] == req["requestId"]
        # Local participants are nudged and can list it, labelled by the
        # verified origin URL (+ its nickname, shown — never trusted).
        wait_for(lambda: {"t": "j"} in host_stream.data())
        listed = a.client().get(f"/rooms/{room}/join-requests").json()["requests"]
        assert [(x["requestId"], x["origin"], x["originNickname"], x["state"]) for x in listed] == [
            (req["requestId"], b.base, "Beta", "pending")
        ]
        assert listed[0]["blob"] == "c2VhbGVk"
        # Pending: no room data yet.
        r = jb.get(f"{via(a, room)}/updates?after=0")
        assert r.status_code == 403 and r.json()["error"] == "join-pending"
        assert jb.get(f"{via(a, room)}/join-requests/self").json()["state"] == "pending"
        # Only local (app-token) callers decide — a peer cannot reach it.
        assert httpx.post(f"{a.base}/rooms/{room}/join-requests/{req['requestId']}",
                          json={"decision": "write"}).status_code == 401

        # Accept read-only.
        assert _decide(a, room, req["requestId"], "read").status_code == 204
        assert jb.get(f"{via(a, room)}/join-requests/self").json() == {
            "requestId": req["requestId"], "state": "approved", "mode": "read"}
        assert jb.get(f"{via(a, room)}/updates?after=0").status_code == 200
        r = jb.post(f"{via(a, room)}/updates", content=b"nope")
        assert r.status_code == 403 and r.json()["error"] == "read-only"
        r = jb.post(f"{via(a, room)}/snapshot", json={"blob": "eA==", "coversThroughSeq": 1})
        assert r.status_code == 403 and r.json()["error"] == "read-only"
        # Presence is allowed read-only, and reaches the host.
        assert jb.post(f"{via(a, room)}/presence?from=bob", content=b"cursor").status_code == 202
        wait_for(lambda: any(d.get("t") == "p" for d in host_stream.data()))

        # The remote participant's live stream, through B.
        remote = Sse(b, f"{via(a, room)}/stream?sid=bob", {"X-CardMirror-Room-Pass": p})
        try:
            assert remote.status == 200
            wait_for(lambda: any(ev == "hello" for ev, _ in remote.frames))
            # Upgrade to write: the access frame reaches the remote stream.
            assert _decide(a, room, req["requestId"], "write").status_code == 204
            wait_for(lambda: {"t": "a", "mode": "write"} in remote.data())
            seq = jb.post(f"{via(a, room)}/updates", content=b"from-bob").json()["seq"]
            # One seq authority: the home's; both sides see it.
            wait_for(lambda: any(d.get("t") == "u" and d.get("seq") == seq for d in host_stream.data()))
            wait_for(lambda: any(d.get("t") == "u" and d.get("seq") == seq for d in remote.data()))
            host_seq = a.client().post(f"/rooms/{room}/updates", content=b"from-alice").json()["seq"]
            wait_for(lambda: any(d.get("seq") == host_seq for d in remote.data()))
            page = jb.get(f"{via(a, room)}/updates?after=0", headers={"Accept-Encoding": "gzip"}).json()
            assert [u["seq"] for u in page["updates"]] == [seq, host_seq]
            # Host presence reaches the remote; the remote's own does not echo back.
            a.client().post(f"/rooms/{room}/presence?from=host", content=b"alice-cursor")
            jb.post(f"{via(a, room)}/presence?from=bob", content=b"bob-cursor")
            wait_for(lambda: sum(1 for d in remote.data() if d.get("t") == "p") >= 1)
            time.sleep(0.5)
            blobs = [base64.b64decode(d["blob"]) for d in remote.data() if d.get("t") == "p"]
            assert b"bob-cursor" not in blobs and b"alice-cursor" in blobs
            # j frames are for LOCAL participants only.
            assert {"t": "j"} not in remote.data()

            # Revoke: the remote stream gets x and closes; access is gone.
            assert _decide(a, room, req["requestId"], "revoke").status_code == 204
            wait_for(lambda: {"t": "x"} in remote.data())
            assert remote.closed.wait(10)
        finally:
            remote.close()
        r = jb.get(f"{via(a, room)}/updates?after=0")
        assert r.status_code == 403 and r.json()["error"] == "join-denied"
        assert a.client().get(f"/rooms/{room}/join-requests").json()["requests"] == []
    finally:
        host_stream.close()
        jb.close()


def test_remote_cannot_end_room_and_room_end_reaches_remote(relays):
    a, b = relays["a"], relays["b"]
    room = _room(a)
    p = mint_pass()
    req = _join(b, a, room, p).json()
    _decide(a, room, req["requestId"], "write")
    jb = b.client(headers={**b.auth, "X-CardMirror-Room-Pass": p})
    # No DELETE route exists for remote participants at all.
    assert jb.delete(f"{via(a, room)}").status_code in (404, 405)
    remote = Sse(b, f"{via(a, room)}/stream?sid=r1", {"X-CardMirror-Room-Pass": p})
    try:
        wait_for(lambda: any(ev == "hello" for ev, _ in remote.frames))
        assert a.client().delete(f"/rooms/{room}").status_code == 204
        wait_for(lambda: {"t": "end"} in remote.data())
        assert remote.closed.wait(10)
    finally:
        remote.close()
    r = jb.get(f"{via(a, room)}/updates?after=0")
    assert r.status_code == 410
    assert jb.get(f"{via(a, room)}/join-requests/self").status_code == 410


def test_participant_cap_counts_remote_streams(relays):
    a, b = relays["a"], relays["b"]  # A caps rooms at 3 streams
    room = _room(a)
    p = mint_pass()
    _decide(a, room, _join(b, a, room, p).json()["requestId"], "write")
    ph = {"X-CardMirror-Room-Pass": p}
    streams = [Sse(a, f"/rooms/{room}/stream?sid=l1"), Sse(a, f"/rooms/{room}/stream?sid=l2"),
               Sse(b, f"{via(a, room)}/stream?sid=r1", ph)]
    try:
        assert [s.status for s in streams] == [200, 200, 200]
        extra = Sse(b, f"{via(a, room)}/stream?sid=r2", ph)
        assert extra.status == 409
        assert extra.closed.wait(5)
        # Closing the remote stream frees its seat on the home.
        streams[2].close()
        def reopened():
            s = Sse(b, f"{via(a, room)}/stream?sid=r3", ph)
            if s.status == 200:
                streams.append(s)
                return True
            s.close()
            return False
        wait_for(reopened, timeout=60, step=1)
    finally:
        for s in streams:
            s.close()


def test_withdraw_and_deny(relays):
    a, b = relays["a"], relays["b"]
    room = _room(a)
    p1, p2 = mint_pass(), mint_pass()
    r1 = _join(b, a, room, p1).json()
    _join(b, a, room, p2)
    j1 = b.client(headers={**b.auth, "X-CardMirror-Room-Pass": p1})
    j2 = b.client(headers={**b.auth, "X-CardMirror-Room-Pass": p2})
    assert j1.delete(f"{via(a, room)}/join-requests/self").status_code == 204
    assert j1.get(f"{via(a, room)}/join-requests/self").json()["state"] == "withdrawn"
    assert _decide(a, room, r1["requestId"], "write").status_code == 409  # closed request
    req2 = [x for x in a.client().get(f"/rooms/{room}/join-requests").json()["requests"]]
    assert len(req2) == 1
    assert _decide(a, room, req2[0]["requestId"], "deny").status_code == 204
    assert j2.get(f"{via(a, room)}/join-requests/self").json()["state"] == "denied"
    r = j2.get(f"{via(a, room)}/updates?after=0")
    assert r.json()["error"] == "join-denied"
    assert _decide(a, room, "nope", "write").status_code == 404
    assert _decide(a, room, req2[0]["requestId"], "maybe").status_code == 400


def test_pass_is_bound_to_room_and_relay(relays):
    a, b = relays["a"], relays["b"]
    room1, room2 = _room(a), _room(a)
    p = mint_pass()
    _decide(a, room1, _join(b, a, room1, p).json()["requestId"], "write")
    jb = b.client(headers={**b.auth, "X-CardMirror-Room-Pass": p})
    r = jb.get(f"{via(a, room2)}/updates?after=0")
    assert r.status_code == 401 and r.json()["error"] == "pass-invalid"
    # Reusing a pass for another room is a conflict, not a second request.
    assert _join(b, a, room2, p).json()["error"] == "pass-conflict"
    assert b.client().get(f"{via(a, room1)}/updates?after=0").json()["error"] == "pass-invalid"


def test_proxy_errors(relays):
    a, b, c = relays["a"], relays["b"], relays["c"]
    cb = b.client()
    r = cb.get(f"/federation/v1/via/{b64url(b.base)}/rooms/{'0' * 32}/updates")
    assert r.json()["error"] == "home-is-self"
    r = cb.get(f"/federation/v1/via/{b64url(c.base)}/rooms/{'0' * 32}/updates")
    assert r.status_code == 409 and r.json()["error"] == "home-not-federating"
    r = cb.get(f"/federation/v1/via/{b64url(a.base + '/')}/rooms/{'0' * 32}/updates")
    assert r.json()["error"] == "bad-home"  # non-canonical
    r = cb.get(f"/federation/v1/via/{b64url('http://127.0.0.1:9/relay')}/rooms/{'0' * 32}/updates")
    assert r.status_code == 503 and r.json()["error"] == "home-unreachable"
    # Unknown room on a real home: the home's own 404, marked as proxied.
    r = _join(b, a, "ab" * 16, mint_pass())
    assert r.status_code == 404 and r.headers["x-cardmirror-federation"] == "1"
    # Unauthenticated app calls are refused by the joiner's relay.
    assert httpx.get(f"{b.base}/federation/v1/via/{b64url(a.base)}/rooms/{'0' * 32}/updates").status_code == 401


def test_join_request_limit(relays):
    a, b = relays["a"], relays["b"]
    room = _room(a)
    codes = [_join(b, a, room, mint_pass()).status_code for _ in range(21)]
    assert codes[:20] == [202] * 20 and codes[20] == 429
