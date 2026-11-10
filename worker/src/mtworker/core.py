"""Request dict -> response dict. Never raises for bad input; errors become ok:false."""

from __future__ import annotations

import traceback

from .checks import CHECKS, WEIGHTS
from .parse import ParseError, parse

DEFAULT_RULES = list(CHECKS)


def music21_version() -> str:
    import music21

    return music21.__version__


def run(req: dict) -> dict:
    if not isinstance(req, dict):
        return {"ok": False, "error": "request must be a JSON object"}
    abc = req.get("abc")
    if not isinstance(abc, str) or not abc.strip():
        return {"ok": False, "error": "request needs a non-empty 'abc' string"}
    key_text = req.get("key") or "C major"
    meter = req.get("meter") or "4/4"
    rules = req.get("rules")
    if rules is None:
        rules = DEFAULT_RULES
    if not isinstance(rules, list):
        return {"ok": False, "error": "'rules' must be a list of rule ids"}

    try:
        piece = parse(abc, str(key_text), str(meter))
    except ParseError as e:
        return {"ok": False, "error": str(e)}

    from .checks import _count_bars

    checks = []
    for rid in rules:
        fn = CHECKS.get(rid) if isinstance(rid, str) else None
        if fn is None:
            checks.append({"id": rid, "pass": False, "score": 0, "weight": 1, "detail": "unknown rule", "bars": []})
            continue
        try:
            checks.append(fn(piece, req))
        except Exception as e:  # a bug in one rule must not sink the others
            checks.append({
                "id": rid, "pass": False, "score": 0, "weight": WEIGHTS.get(rid, 1),
                "detail": f"internal error in check: {type(e).__name__}: {e}", "bars": [],
                "trace": traceback.format_exc(limit=3),
            })
    total_w = sum(c["weight"] for c in checks)
    score = round(sum(c["score"] * c["weight"] for c in checks) / total_w, 3) if total_w else 0.0
    out = {
        "ok": True,
        "music21": music21_version(),
        "parsed": {
            "voices": len(piece.voices),
            "notes": len(piece.melody.notes),
            "bars": _count_bars(piece)[0],
            "key_detected": piece.key_detected,
            "meter": piece.abc_meter or piece.meter,
        },
        "checks": checks,
        "score": score,
    }
    if piece.warnings:
        out["warnings"] = piece.warnings
    return out
