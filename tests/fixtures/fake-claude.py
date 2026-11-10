#!/usr/bin/env python3
"""Stand-in for `claude -p --output-format json` in tests: reads the prompt on stdin
and returns a review scoring every rubric id 3. FAKE_CLAUDE_MODE=garbage|error|slow
exercises the failure paths."""
import json, os, re, sys, time
prompt = sys.stdin.read()
if os.environ.get("FAKE_CLAUDE_CAPTURE"):
    open(os.environ["FAKE_CLAUDE_CAPTURE"], "w").write(prompt)
mode = os.environ.get("FAKE_CLAUDE_MODE", "ok")
ids = re.findall(r'- id "([a-z0-9-]+)"', prompt)
if mode == "slow":
    time.sleep(30)
if mode == "error":
    print(json.dumps({"type": "result", "is_error": True, "result": "API Error: overloaded"}))
    sys.exit(1)
review = {"criteria": [{"id": i, "score": 3, "comment": f"ok {i}"} for i in ids], "summary": "Solid.", "next_steps": ["Vary the rhythm in bar 5."]}
body = "not json at all" if mode == "garbage" else "```json\n" + json.dumps(review) + "\n```"
print(json.dumps({"type": "result", "is_error": False, "result": body, "total_cost_usd": 0.01}))
