"""Room passes and spectators, against real relays (see conftest.py).

Mirrors dev/relay-contract.mjs §16 (upstream's spectator contract) on
this relay, plus its one deliberate difference: a spectator MAY post
presence, and the relay stamps those frames `"v":1`."""
import base64
import json
import socket
import time
from urllib.parse import urlsplit

from test_federation import Sse, wait_for


class RawStream:
    """A room stream over a bare socket, so the test can really hang up
    (closing an httpx client from another thread doesn't interrupt the
    reader). Returns the hello frame; close() drops the connection."""

    def __init__(self, relay, path: str, token: str):
        u = urlsplit(relay.base)
        self.sock = socket.create_connection((u.hostname, u.port), timeout=10)
        self.sock.sendall(
            f"GET {u.path}{path} HTTP/1.1\r\nHost: {u.hostname}\r\n"
            f"Authorization: Bearer {token}\r\nAccept: text/event-stream\r\n\r\n".encode()
        )
        buf = b""
        # Chunked transfer encoding: wait for the whole hello frame.
        while b"event: hello" not in buf or b"}\n\n" not in buf:
            chunk = self.sock.recv(4096)
            assert chunk, buf
            buf += chunk
        self.head = buf
        line = next(ln for ln in buf.decode().splitlines() if ln.startswith("data:") and "lastSeq" in ln)
        self.hello = json.loads(line[5:])

    def close(self):
        self.sock.close()


def _bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _made(relay) -> dict:
    r = relay.client().post("/rooms")
    assert r.status_code == 201
    return r.json()


def test_capabilities_list_passes_and_spectator_presence(relays):
    feats = relays["b"].client().get("/capabilities").json()["features"]
    for f in ("rooms.guestPasses", "rooms.viewPasses", "rooms.spectatorPresence"):
        assert f in feats
    limits = relays["b"].client().get("/capabilities").json()["limits"]
    assert limits["maxStreamsPerRoom"] == 30
    assert limits["maxViewersPerRoom"] == 100


def test_view_pass_reads_but_never_writes(relays):
    b = relays["b"]
    made = _made(b)
    room = made["roomId"]
    assert isinstance(made["guestPass"], str) and isinstance(made["viewPass"], str)
    view = b.client(headers=_bearer(made["viewPass"]))
    guest = b.client(headers=_bearer(made["guestPass"]))
    octet = {"Content-Type": "application/octet-stream"}

    assert view.post(f"/rooms/{room}/updates", content=b"nope", headers=octet).status_code == 403
    snap = view.post(f"/rooms/{room}/snapshot", json={"blob": "AA==", "coversThroughSeq": 0})
    assert snap.status_code == 403
    assert view.delete(f"/rooms/{room}").status_code == 403
    # An edit pass writes; the view pass reads what it wrote.
    assert guest.post(f"/rooms/{room}/updates", content=b"edit", headers=octet).status_code == 202
    page = view.get(f"/rooms/{room}/updates?after=0")
    assert page.status_code == 200 and len(page.json()["updates"]) == 1
    # Minting: any credential gets a view pass; only edit credentials get
    # an edit pass (a view pass must never buy a seat).
    assert view.get(f"/rooms/{room}/view-pass").status_code == 200
    assert b.client().get(f"/rooms/{room}/view-pass").json()["viewPass"].startswith("cmrp1.")
    assert guest.get(f"/rooms/{room}/guest-pass").status_code == 200
    assert view.get(f"/rooms/{room}/guest-pass").status_code == 403
    # Scoped to its room, and useless outside room routes.
    other = _made(b)["roomId"]
    assert view.get(f"/rooms/{other}/updates?after=0").status_code == 401
    assert guest.post(f"/rooms/{other}/updates", content=b"x", headers=octet).status_code == 401
    assert guest.get("/messages?recipient=abc").status_code == 401
    assert view.post("/rooms").status_code == 401


def test_tampered_pass_is_refused(relays):
    b = relays["b"]
    made = _made(b)
    room = made["roomId"]
    # Turning a view pass into an edit pass breaks the signature.
    forged = made["viewPass"].replace(".v.", ".g.", 1)
    r = b.client(headers=_bearer(forged)).post(
        f"/rooms/{room}/updates", content=b"x", headers={"Content-Type": "application/octet-stream"}
    )
    assert r.status_code == 401


def test_watchers_and_stamped_spectator_presence(relays):
    b = relays["b"]
    made = _made(b)
    room = made["roomId"]
    editor = Sse(b, f"/rooms/{room}/stream?sid=ed")
    viewer = None
    try:
        assert editor.status == 200
        hello = wait_for(lambda: next((json.loads(d) for ev, d in editor.frames if ev == "hello"), None))
        assert hello["watchers"] == 0
        viewer = Sse(b, f"/rooms/{room}/stream?sid=v1", _bearer(made["viewPass"]))
        assert viewer.status == 200
        vhello = wait_for(lambda: next((json.loads(d) for ev, d in viewer.frames if ev == "hello"), None))
        assert vhello["watchers"] == 1
        wait_for(lambda: any(f.get("t") == "w" and f.get("n") == 1 for f in editor.data()))
        # A second spectator on a bare socket: hanging up drops the count
        # promptly (not a heartbeat later).
        raw = RawStream(b, f"/rooms/{room}/stream?sid=v2", made["viewPass"])
        assert raw.hello["watchers"] == 2
        wait_for(lambda: any(f.get("t") == "w" and f.get("n") == 2 for f in editor.data()))
        hung_up = time.time()
        raw.close()
        wait_for(lambda: [f.get("n") for f in editor.data() if f.get("t") == "w"][-1] == 1, timeout=5)
        assert time.time() - hung_up < 5

        # The spectator announces itself; the editor sees the frame stamped.
        r = b.client(headers=_bearer(made["viewPass"])).post(
            f"/rooms/{room}/presence?from=v1", content=b"roster", headers={"Content-Type": "application/octet-stream"}
        )
        assert r.status_code == 202
        got = wait_for(lambda: next((f for f in editor.data() if f.get("t") == "p"), None))
        assert got.get("v") == 1 and base64.b64decode(got["blob"]) == b"roster"
        # No self-echo to the spectator's own stream.
        time.sleep(0.3)
        assert not any(f.get("t") == "p" for f in viewer.data())
        # An editor's presence is not stamped, and reaches the spectator.
        b.client().post(f"/rooms/{room}/presence?from=ed", content=b"cursor",
                        headers={"Content-Type": "application/octet-stream"})
        vp = wait_for(lambda: next((f for f in viewer.data() if f.get("t") == "p"), None))
        assert "v" not in vp

    finally:
        editor.close()
        if viewer is not None:
            viewer.close()


def test_separate_caps_and_watch_instead(relays):
    a = relays["a"]  # A caps rooms at 3 editors
    made = _made(a)
    room = made["roomId"]
    editors = [Sse(a, f"/rooms/{room}/stream?sid=e{i}") for i in range(3)]
    extra = []
    try:
        assert [s.status for s in editors] == [200, 200, 200]
        over = Sse(a, f"/rooms/{room}/stream?sid=over")
        extra.append(over)
        assert over.status == 409
        assert over.closed.wait(5)
        body = json.loads(over.body)
        assert body["detail"] == "room is full" and body["viewPass"].startswith("cmrp1.")
        # Viewers don't take editor seats; the 409's pass opens one.
        late = Sse(a, f"/rooms/{room}/stream?sid=v1", _bearer(made["viewPass"]))
        extra.append(late)
        assert late.status == 200
        offered = Sse(a, f"/rooms/{room}/stream?sid=v2", _bearer(body["viewPass"]))
        extra.append(offered)
        assert offered.status == 200
    finally:
        for s in editors + extra:
            s.close()
