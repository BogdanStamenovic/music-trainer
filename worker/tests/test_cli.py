"""End-to-end through `python -m mtworker check`, the way the app calls it."""

from __future__ import annotations

import json
import subprocess
import sys

REQ = {
    "abc": "X:1\nM:4/4\nL:1/8\nK:C\nE2 D2 C2 D2 | E2 E2 E4 | D2 D2 E2 F2 | E2 D2 G4 |"
    " E2 D2 C2 D2 | E2 E2 E2 E2 | D2 D2 E2 D2 | C8 |]\n",
    "key": "C major",
    "meter": "4/4",
    "bars": 8,
    "rules": ["bars", "range", "key", "cadence", "half-cadence", "leaps", "stepwise", "augmented", "parallels", "rhythm"],
    "range": [55, 76],
}


def cli(stdin: str, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, "-m", "mtworker", *args], input=stdin, capture_output=True, text=True, timeout=120)


def test_round_trip():
    p = cli(json.dumps(REQ), "check")
    assert p.returncode == 0, p.stderr
    out = json.loads(p.stdout)
    assert out["ok"] is True
    assert out["music21"].split(".")[0].isdigit()
    assert [c["id"] for c in out["checks"]] == REQ["rules"]
    assert out["score"] == 1.0
    for c in out["checks"]:
        assert set(c) >= {"id", "pass", "score", "weight", "detail", "bars"}


def test_malformed_abc_exit_0_ok_false():
    p = cli(json.dumps({**REQ, "abc": "((( {{{ garbage"}), "check")
    assert p.returncode == 0
    out = json.loads(p.stdout)
    assert out["ok"] is False and "could not parse ABC" in out["error"]


def test_bad_json_exit_0_ok_false():
    p = cli("{not json", "check")
    assert p.returncode == 0
    assert json.loads(p.stdout)["ok"] is False


def test_usage_error_exit_2():
    for args in ((), ("grade",), ("check", "extra")):
        p = cli("{}", *args)
        assert p.returncode == 2
        assert p.stdout == ""
        assert "usage" in p.stderr
