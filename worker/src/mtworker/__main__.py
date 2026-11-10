"""CLI: python -m mtworker check  (JSON request on stdin, JSON result on stdout).

Exit 0 whenever a JSON result was written, including {"ok": false}.
Exit 2 for usage errors (unknown subcommand).
"""

from __future__ import annotations

import json
import sys

USAGE = "usage: python -m mtworker check < request.json\n"


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if argv[:1] != ["check"] or len(argv) != 1:
        sys.stderr.write(USAGE)
        return 2
    raw = sys.stdin.read()
    try:
        req = json.loads(raw)
    except json.JSONDecodeError as e:
        out = {"ok": False, "error": f"bad request JSON: {e}"}
    else:
        from .core import run

        try:
            out = run(req)
        except Exception as e:  # last line of defence: always answer in JSON
            out = {"ok": False, "error": f"internal error: {type(e).__name__}: {e}"}
    sys.stdout.write(json.dumps(out, ensure_ascii=False) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
