"""M3 E2E in real Chrome: weekly projects end to end with the REAL music21 worker
and the REAL `claude -p` reviewer (as configured on the server under test).

Input: the on-screen keyboard (same event path as Web MIDI after parsing; the
Web MIDI stack itself is covered by e2e.py) and a faked microphone for the vocal
piece. The driver reassigns this week's project in the test DB between phases so
all four kinds can be exercised on one date.

Usage: python e2e_m3.py BASE_URL DATA_DIR OUT_DIR
"""
import json
import re
import sqlite3
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright, expect

BASE, DATA, OUT = sys.argv[1], Path(sys.argv[2]), Path(sys.argv[3])
OUT.mkdir(parents=True, exist_ok=True)
lines = []


def log(*a):
    s = " ".join(str(x) for x in a)
    lines.append(s)
    print(s, flush=True)


FAKE_MIC = """
window.__fakeHz = 0;
const realGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
navigator.mediaDevices.getUserMedia = async (c) => {
  if (!c || !c.audio) return realGUM(c);
  const ac = new AudioContext(); const o = ac.createOscillator(); o.type = "triangle";
  const g = ac.createGain(); g.gain.value = 0; const d = ac.createMediaStreamDestination();
  o.connect(g).connect(d); o.start();
  setInterval(() => { const hz = window.__fakeHz || 0; if (hz > 0) o.frequency.setTargetAtTime(hz, ac.currentTime, 0.01); g.gain.setTargetAtTime(hz > 0 ? 0.35 : 0, ac.currentTime, 0.01); }, 15);
  return d.stream;
};
"""


def assign(kind, project_id):
    db = sqlite3.connect(DATA / "trainer.db")
    db.execute("UPDATE projects SET project_id=?, kind=?, status='open', submission=NULL, submitted_at=NULL, auto=NULL, self=NULL, ai=NULL, ai_status=NULL, score=NULL, final=0", (project_id, kind))
    db.execute("DELETE FROM jobs")
    db.commit()
    db.close()


def key(page, note, ms):
    k = page.locator(f'[data-note="{note}"]')
    k.dispatch_event("pointerdown")
    time.sleep(ms / 1000)
    k.dispatch_event("pointerup")


def rate_all(page, value):
    for b in page.locator(f'[data-testid^="self-"][data-testid$="-{value}"]').all():
        b.click()


def submit_and_wait_ai(page, timeout=240):
    page.get_by_test_id("project-submit").click()
    expect(page.get_by_test_id("project-result")).to_be_visible(timeout=60000)
    # a resubmission: wait until the page shows the NEW submission (review queued again)
    expect(page.get_by_test_id("ai-status")).to_contain_text(re.compile("queued|u redu|done|gotovo|not available|nije dostupna"), timeout=60000)
    page.wait_for_function("!document.querySelector('[data-testid=project-submit]').disabled || true")
    log("  submitted:", page.get_by_test_id("project-result").inner_text().split("\n")[0], "|", page.get_by_test_id("ai-status").inner_text())
    t0 = time.time()
    while time.time() - t0 < timeout:
        st = page.get_by_test_id("ai-status").inner_text()
        if "pending" not in st and "u redu" not in st and "queued" not in st:
            break
        time.sleep(3)
    log(f"  after {time.time() - t0:.0f}s:", page.get_by_test_id("project-result").inner_text().split("\n")[0], "|", page.get_by_test_id("ai-status").inner_text())


with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", headless=True, args=["--autoplay-policy=no-user-gesture-required"])
    ctx = b.new_context(viewport={"width": 1100, "height": 1000})
    ctx.grant_permissions(["microphone", "midi"])
    ctx.add_init_script(FAKE_MIC)
    page = ctx.new_page()
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)))
    page.goto(BASE + "/")
    page.evaluate("fetch('/api/settings', {method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({placementSkipped: true})})")
    page.reload()
    expect(page.get_by_test_id("project-card")).to_be_visible(timeout=10000)
    log("home project card:", page.get_by_test_id("project-card").inner_text().replace("\n", " | "))

    # ---- composition, recorded on the (on-screen) keyboard
    log("PC-001 composition (recorded):")
    page.goto(BASE + "/project")
    page.locator("input[type=number]").first.fill("100")  # tempo 100: quarter = 600 ms
    page.get_by_test_id("compose-record").click()
    time.sleep(0.1 + 4 * 0.6)  # count-in bar
    q = 600
    # 8 bars, question/answer, half cadence at bar 4 (D), ends 2-1
    tune = [(60, 1), (64, 1), (67, 1), (64, 1), (65, 1), (64, 1), (62, 2), (60, 1), (64, 1), (67, 1), (72, 1), (71, 2), (67, 2),
            (69, 1), (67, 1), (65, 1), (64, 1), (62, 2), (64, 2), (65, 1), (64, 1), (62, 1), (59, 1), (60, 4)]
    for n, beats in tune:
        key(page, n, beats * q - 60)
        time.sleep(0.06)
    page.get_by_test_id("compose-stop").click()
    abc = page.get_by_test_id("abc-text").input_value()
    log("  quantized ABC:", abc.replace("\n", " / "))
    page.wait_for_timeout(800)
    page.screenshot(path=str(OUT / "m3-composition.png"), full_page=True)
    rate_all(page, 2)
    submit_and_wait_ai(page)
    res = page.get_by_test_id("project-result").inner_text()
    log("  result block:", res.replace("\n", " | ")[:900])
    page.screenshot(path=str(OUT / "m3-composition-result.png"), full_page=True)

    # ---- composition again, typed ABC with a deliberate error (ends on the leading tone)
    log("PC-001 composition (typed ABC, ends on B):")
    page.wait_for_timeout(500)
    before = page.get_by_test_id("project-result").inner_text()
    page.get_by_test_id("abc-text").fill("X:1\nM:4/4\nL:1/4\nK:C\nC E G E | F E D2 | C E G c | B2 G2 | A G F E | D2 E2 | F E D C | B,4 |]")
    page.get_by_test_id("project-submit").click()
    page.wait_for_function("b => document.querySelector('[data-testid=project-result]').innerText !== b", arg=before, timeout=60000)
    t0 = time.time()
    while time.time() - t0 < 240 and re.search("queued", page.get_by_test_id("ai-status").inner_text()):
        time.sleep(3)
    res = page.get_by_test_id("project-result").inner_text()
    log(f"  after {time.time() - t0:.0f}s:", res.split("\n")[0], "|", page.get_by_test_id("ai-status").inner_text())
    log("  cadence line:", [l for l in res.split("\n") if "cadence" in l][:2])

    # ---- lyrics (Serbian), real claude review
    assign("lyrics", "PL-002")
    log("PL-002 lyrics (sr):")
    page.goto(BASE + "/project")
    page.locator("button.lang").click()  # UI to Serbian
    text = "[Strofa]\nU avliji bagrem cveta\nmiris nosi tiha noć\nčekam tebe pola leta\na ti nećeš, nećeš doć'\n\n[Refren]\nOj, sevdahu, rano moja\nne daj srcu da zaspi\nsvaka zvezda, zvezda tvoja\nsvaka suza, suza ti"
    page.get_by_test_id("lyrics-text").fill(text)
    log("  live stats:", page.get_by_test_id("lyrics-stats").inner_text())
    rate_all(page, 3)
    submit_and_wait_ai(page)
    log("  review:", page.get_by_test_id("project-result").inner_text().replace("\n", " | ")[:700])
    page.screenshot(path=str(OUT / "m3-lyrics.png"), full_page=True)
    page.locator("button.lang").click()  # back to English

    # ---- by ear
    assign("byear", "PE-001")
    log("PE-001 by ear:")
    page.goto(BASE + "/project")
    page.get_by_test_id("byear-listen").click()
    time.sleep(1)
    melody = json.loads(page.evaluate("fetch('/api/projects/current').then(r=>r.text())"))["project"]["def"]["melody"]
    names = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
    def m(n):
        pc = names[n[0]] + (1 if "#" in n else -1 if n[1:2] == "b" else 0)
        return (int(n[-1]) + 1) * 12 + pc
    time.sleep(20)  # let the reference finish
    for n, beats in zip(melody["notes"], melody["beats"]):
        if n == "r":
            time.sleep(beats * 0.5)
            continue
        key(page, m(n) - 2, beats * 500 - 60)  # a whole tone lower: by-ear grading is key-independent
        time.sleep(0.06)
    rate_all(page, 3)
    page.get_by_test_id("project-submit").click()
    expect(page.get_by_test_id("project-result")).to_be_visible(timeout=30000)
    log("  result:", page.get_by_test_id("project-result").inner_text().replace("\n", " | "))

    # ---- vocal (fake mic)
    assign("vocal", "PV-001")
    log("PV-001 vocal (fake mic):")
    page.goto(BASE + "/project")
    page.get_by_test_id("checkin-fine").click()
    mel = json.loads(page.evaluate("fetch('/api/projects/current').then(r=>r.text())"))["project"]["def"]["melody"]
    beat = 60 / mel["tempo"]
    time.sleep(2 + sum(mel["beats"]) * beat)  # reference playback
    page.get_by_test_id("record").click()
    time.sleep(0.3)
    for n, beats in zip(mel["notes"], mel["beats"]):
        hz = 0 if n == "r" else 440 * 2 ** ((m(n) - 69) / 12)
        page.evaluate(f"window.__fakeHz = {hz}")
        time.sleep(beats * beat * 0.92)
        page.evaluate("window.__fakeHz = 0")
        time.sleep(beats * beat * 0.08)
    if page.get_by_test_id("stop").count():
        page.get_by_test_id("stop").click()
    page.wait_for_function("!document.body.innerText.includes('Analyzing')", timeout=60000)
    rate_all(page, 2)
    page.get_by_test_id("project-submit").click()
    expect(page.get_by_test_id("project-result")).to_be_visible(timeout=30000)
    log("  result:", page.get_by_test_id("project-result").inner_text().replace("\n", " | "))

    # ---- history
    page.goto(BASE + "/history")
    expect(page.get_by_test_id("project-history")).to_be_visible(timeout=10000)
    log("history rows:", page.get_by_test_id("project-history").inner_text().replace("\n", " || "))
    page.screenshot(path=str(OUT / "m3-history.png"), full_page=True)
    log("page errors:", errs)
    b.close()

(OUT / "e2e-m3.log").write_text("\n".join(lines) + "\n")
