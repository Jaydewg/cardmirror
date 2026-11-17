"""Run the APP's federation tests against real relays.

Starts relays A + B (federating) and C (not), exactly as the pytest
harness does, then runs tests/federation/real-relays*.test.ts
(co-editing and card sharing) and tests/desktop/pairing-federation.test.ts
(the desktop main process) with FED_RELAYS pointing at them.

    cd relay && python tests/run_client_federation.py
    NODE=/path/to/node22 python tests/run_client_federation.py

Needs the same Postgres as conftest.py (RELAY_TEST_PG_URL or pgserver)
and the app's node_modules (npm ci at the repo root).
"""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from conftest import _FED, Relay, _fresh_db  # noqa: E402

REPO = HERE.parent.parent


def main() -> int:
    pg = os.environ.get("RELAY_TEST_PG_URL")
    if not pg:
        import pgserver  # type: ignore

        pg = pgserver.get_server(tempfile.mkdtemp(prefix="relay-fed-pg-"), cleanup_mode="stop").get_uri()
    relays = {
        "a": Relay("ca", _fresh_db(pg, "relay_cfed_a"), "tok-a", {**_FED, "RELAY_NICKNAME": "Alpha"}),
        "b": Relay("cb", _fresh_db(pg, "relay_cfed_b"), "tok-b", {**_FED, "RELAY_NICKNAME": "Beta"}),
        "c": Relay("cc", _fresh_db(pg, "relay_cfed_c"), "tok-c", {}),
    }
    started = []
    try:
        for r in relays.values():
            r.start()
            started.append(r)
        env = {
            **os.environ,
            "FED_RELAYS": json.dumps({k: {"url": r.base, "token": r.token} for k, r in relays.items()}),
        }
        node = os.environ.get("NODE", "node")
        return subprocess.call(
            [node, "node_modules/vitest/vitest.mjs", "run", "tests/federation/real-relays", "tests/desktop/pairing-federation"],
            cwd=REPO,
            env=env,
        )
    finally:
        for r in started:
            r.stop()


if __name__ == "__main__":
    sys.exit(main())
