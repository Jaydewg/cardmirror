"""Multi-relay harness for the federation tests.

Starts real relays (uvicorn subprocesses, one Postgres database each):

  A  federating, nickname "Alpha", 3-stream room cap (cap tests)
  B  federating, nickname "Beta"
  C  NOT federating (compatibility)
  D  federating, with a minimum-version gate (version flags)
  E  federating, but private addresses NOT allowed (refusal reasons)

Postgres: set RELAY_TEST_PG_URL (a superuser URL, e.g.
postgresql://postgres@localhost/postgres) or `pip install pgserver` and
one is started for the session. Needs: fastapi uvicorn sqlalchemy
psycopg2-binary httpx pytest (relay/requirements.txt + pytest).

    cd relay && python -m pytest tests -q
"""
import os
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import httpx
import pytest
import sqlalchemy

RELAY_DIR = Path(__file__).resolve().parent.parent


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="session")
def pg_url():
    url = os.environ.get("RELAY_TEST_PG_URL")
    if url:
        yield url
        return
    try:
        import pgserver  # type: ignore
    except ImportError:
        pytest.skip("set RELAY_TEST_PG_URL or pip install pgserver")
    tmp = tempfile.mkdtemp(prefix="relay-fed-pg-")
    srv = pgserver.get_server(tmp, cleanup_mode="stop")
    yield srv.get_uri()


def _fresh_db(admin_url: str, name: str) -> str:
    admin = sqlalchemy.create_engine(
        admin_url.replace("postgresql://", "postgresql+psycopg2://", 1), isolation_level="AUTOCOMMIT"
    )
    with admin.connect() as c:
        c.execute(sqlalchemy.text(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))
        c.execute(sqlalchemy.text(f'CREATE DATABASE "{name}"'))
    admin.dispose()
    u = sqlalchemy.engine.make_url(admin_url.replace("postgresql://", "postgresql+psycopg2://", 1))
    return u.set(database=name).render_as_string(hide_password=False)


class Relay:
    def __init__(self, name: str, db_url: str, token: str, env: dict, script: str = "server.py"):
        self.name = name
        self.db_url = db_url
        self.token = token
        self.port = _free_port()
        self.base = f"http://127.0.0.1:{self.port}/relay"
        self.script = script
        self.env = {
            **os.environ,
            "DATABASE_URL": db_url,
            "RELAY_TOKEN": token,
            **env,
        }
        if env.get("RELAY_FEDERATION") == "on":
            self.env.setdefault("RELAY_PUBLIC_URL", self.base)
        self.proc = None
        self.log = Path(tempfile.gettempdir()) / f"relay-fed-{name}-{self.port}.log"

    @property
    def auth(self) -> dict:
        return {"Authorization": f"Bearer {self.token}"}

    def start(self) -> None:
        module = Path(self.script).stem
        app_dir = str(Path(self.script).parent) if os.path.isabs(self.script) else str(RELAY_DIR)
        self.proc = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", f"{module}:app", "--app-dir", app_dir,
             "--host", "127.0.0.1", "--port", str(self.port), "--timeout-graceful-shutdown", "1"],
            cwd=app_dir,
            env=self.env,
            stdout=open(self.log, "ab"),
            stderr=subprocess.STDOUT,
        )
        deadline = time.time() + 30
        while time.time() < deadline:
            if self.proc.poll() is not None:
                raise RuntimeError(f"relay {self.name} exited; see {self.log}:\n{self.log.read_text()[-3000:]}")
            try:
                if httpx.get(f"{self.base}/health", timeout=1).status_code == 200:
                    return
            except httpx.HTTPError:
                pass
            time.sleep(0.2)
        raise RuntimeError(f"relay {self.name} did not start; see {self.log}")

    def stop(self) -> None:
        if self.proc is not None and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(10)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        self.proc = None

    def client(self, **kw) -> httpx.Client:
        headers = {**self.auth, **kw.pop("headers", {})}
        return httpx.Client(base_url=self.base, headers=headers, timeout=kw.pop("timeout", 20), **kw)


_FED = {
    "RELAY_FEDERATION": "on",
    "RELAY_FEDERATION_ALLOW_HTTP": "1",
    "RELAY_FEDERATION_ALLOW_PRIVATE": "1",
}


@pytest.fixture(scope="session")
def relays(pg_url):
    a = Relay("a", _fresh_db(pg_url, "relay_fed_a"), "tok-a", {
        **_FED, "RELAY_NICKNAME": "Alpha", "RELAY_MAX_STREAMS_PER_ROOM": "3",
        # Something to refuse in the policy tests (nothing listens there).
        "RELAY_FEDERATION_DENY": "denied.invalid",
    })
    b = Relay("b", _fresh_db(pg_url, "relay_fed_b"), "tok-b", {**_FED, "RELAY_NICKNAME": "Beta"})
    c = Relay("c", _fresh_db(pg_url, "relay_fed_c"), "tok-c", {})
    # Federating, with an opt-in minimum-version gate (version flags).
    d = Relay("d", _fresh_db(pg_url, "relay_fed_d"), "tok-d", {
        **_FED, "RELAY_MIN_CLIENT_VERSION": "1.15.0", "RELAY_MIN_VERSION_SCOPE": "all",
    })
    # Federating over http but WITHOUT the private-address opt-in: every
    # 127.0.0.1 peer is refused as a private address (the LAN pitfall).
    e = Relay("e", _fresh_db(pg_url, "relay_fed_e"), "tok-e", {
        "RELAY_FEDERATION": "on", "RELAY_FEDERATION_ALLOW_HTTP": "1",
    })
    started = []
    try:
        for r in (a, b, c, d, e):
            r.start()
            started.append(r)
        yield {"a": a, "b": b, "c": c, "d": d, "e": e}
    finally:
        for r in started:
            r.stop()
