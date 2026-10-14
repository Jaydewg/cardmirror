"""Pure helpers: URL canonicalization, version flags, peer policy.
The app mirrors canon_url / split_version_flags (src/editor/federation/
address.ts); tests/federation/address.test.ts pins the same vectors."""
import os
import sys
from pathlib import Path

import pytest

os.environ.setdefault("DATABASE_URL", "postgresql://unused@localhost/unused")
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server  # noqa: E402  (engine creation is lazy; nothing connects)


@pytest.mark.parametrize("raw,want", [
    ("https://Relay.Example.org/relay", "https://relay.example.org/relay"),
    ("https://relay.example.org/relay/", "https://relay.example.org/relay"),
    ("https://relay.example.org:443/relay", "https://relay.example.org/relay"),
    ("http://relay.example.org:80/relay", "http://relay.example.org/relay"),
    ("https://relay.example.org:8443/relay", "https://relay.example.org:8443/relay"),
    ("HTTPS://relay.example.org//a//b/", "https://relay.example.org/a/b"),
    ("https://relay.example.org", "https://relay.example.org"),
    ("https://[::1]:8000/relay", "https://[::1]:8000/relay"),
    ("  https://relay.example.org/relay  ", "https://relay.example.org/relay"),
    ("https://relay.example.org/Relay", "https://relay.example.org/Relay"),  # path case kept
])
def test_canon_url(raw, want):
    assert server.canon_url(raw) == want


@pytest.mark.parametrize("raw", [
    "", "relay.example.org", "ftp://relay.example.org", "https://user@relay.example.org/relay",
    "https://relay.example.org/relay?x=1", "https://relay.example.org/relay#f",
    "https://relay.example.org:99999/relay", "https://rel ay.example.org", None, 42,
    "https://relay.example.org/re@lay",
])
def test_canon_url_rejects(raw):
    assert server.canon_url(raw) is None


@pytest.mark.parametrize("v,core,flags", [
    ("1.15.0-f", "1.15.0", {"f"}),
    ("1.15-f", "1.15", {"f"}),
    ("1.15.0", "1.15.0", set()),
    ("1.16.0-beta.2-f", "1.16.0-beta.2", {"f"}),
    ("1.16.0-beta", "1.16.0-beta", set()),
    ("1.16.0-rc", "1.16.0-rc", set()),
    ("1.15.0-fx", "1.15.0", {"f", "x"}),
])
def test_split_version_flags(v, core, flags):
    assert server.split_version_flags(v) == (core, frozenset(flags))


def test_flags_never_affect_ordering():
    p = server._parse_version
    assert p("1.15.0-f") == p("1.15.0") == p("1.15-f") == p("1.15")
    assert p("1.16.0-beta.2-f") == p("1.16.0-beta.2") < p("1.16.0")
    assert p("1.14.9-f") < p("1.15.0")
    assert p("garbage") is None


def test_peer_policy():
    cfg = server.FederationConfig(
        enabled=True, url="https://me.example/relay",
        allow=("*.friends.org", "https://solo.example/relay"), deny=("bad.friends.org",),
    )
    assert cfg.permits("https://a.friends.org/relay")
    assert cfg.permits("https://solo.example/relay")
    assert not cfg.permits("https://solo.example/other")      # URL entries are exact
    assert not cfg.permits("https://bad.friends.org/relay")   # deny wins
    assert not cfg.permits("https://stranger.example/relay")  # not on the allow list
    assert not cfg.permits("https://me.example/relay")        # never ourselves
    assert not cfg.permits("http://a.friends.org/relay")      # http needs the opt-in
    open_cfg = server.FederationConfig(enabled=True, url="https://me.example/relay")
    assert open_cfg.permits("https://anyone.example/relay")
    assert not server.FederationConfig().permits("https://anyone.example/relay")  # off
