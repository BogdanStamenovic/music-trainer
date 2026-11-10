"""End-to-end browser test: real Chrome + a virtual MIDI device (snd-virmidi).

The driver writes raw MIDI bytes to the virmidi rawmidi device; Chrome sees the
matching ALSA sequencer port as a MIDI input, exactly like a USB piano. It also
reads what the app sends to the virmidi output to verify MIDI-out playback.

Usage: python e2e.py BASE_URL RAWMIDI_DEV OUT_DIR
Requires: playwright (python), google-chrome-stable, node/tsx in the repo.
"""
import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

from playwright.sync_api import sync_playwright, expect

BASE, DEV, OUT = sys.argv[1], sys.argv[2], Path(sys.argv[3])
OUT.mkdir(parents=True, exist_ok=True)
REPO = Path(__file__).resolve().parents[2]
log_lines: list[str] = []


def log(*a):
    s = " ".join(str(x) for x in a)
    log_lines.append(s)
    print(s, flush=True)


fd = os.open(DEV, os.O_RDWR | os.O_NONBLOCK)
received = bytearray()


def reader():
    while True:
        try:
            b = os.read(fd, 1024)
            if b:
                received.extend(b)
        except BlockingIOError:
            pass
        time.sleep(0.005)


threading.Thread(target=reader, daemon=True).start()


def send(*b):
    os.write(fd, bytes(b))


def note_on(n, v=80):
    send(0x90, n, v)


def note_off(n):
    send(0x80, n, 0)


def answers(ex_id, seed, count=None):
    args = ["npx", "tsx", "scripts/dev/answers.ts", ex_id, seed] + ([str(count)] if count else [])
    return json.loads(subprocess.check_output(args, cwd=REPO))


def play_item(it, wrong=False):
    """Perform one MIDI item on the virtual piano."""
    exp = list(it.get("expect") or [])
    if wrong and exp:
        exp = [n + 1 for n in exp]
    tempo = it.get("tempo") or 100
    beat = 60.0 / tempo
    if it["mode"] == "chord":
        for n in exp:
            note_on(n)
            time.sleep(0.01)
        time.sleep(0.3)
        for n in exp:
            note_off(n)
    elif it["mode"] == "sequence":
        for n in exp:
            note_on(n)
            time.sleep(beat * 0.8)
            note_off(n)
            time.sleep(beat * 0.2)
    else:
        for ch in it["expectChords"]:
            ch = [n + 1 for n in ch] if wrong else ch
            for n in ch:
                note_on(n)
                time.sleep(0.008)
            time.sleep(beat * 0.85)
            for n in ch:
                note_off(n)
            time.sleep(beat * 0.15 - 0.008 * len(ch))


def do_item(page, it, wrong=False, locale="en"):
    item = page.get_by_test_id("item")
    expect(item).to_have_attribute("data-kind", {"mcq": "mcq", "names": "names", "midi": "midi", "practice": "practice"}[it["kind"]])
    if it["kind"] == "mcq":
        idx = it["answer"] if not wrong else (it["answer"] + 1) % len(it["options"])
        page.get_by_test_id("option").nth(idx).click()
    elif it["kind"] == "names":
        txt = " ".join(it["expect"]) if not wrong else "C C C"
        page.locator(".names input").fill(txt)
        page.locator(".names input").press("Enter")
    elif it["kind"] == "practice":
        page.get_by_role("button", name="Did it" if locale == "en" else "Uradio sam").click()
    else:
        # let the app's own playback finish (input is muted while it plays to the piano)
        time.sleep(it.get("playSec", 0) + 0.4)
        play_item(it, wrong)
    expect(page.get_by_test_id("feedback")).to_be_visible(timeout=8000)
    fb = page.get_by_test_id("feedback").inner_text()
    page.get_by_test_id("next").click()
    return fb


def run_exercise(page, ex_id, seed, count=None, wrong_items=(), locale="en", advance=True):
    a = answers(ex_id, seed, count)
    fbs = []
    for i, it in enumerate(a["items"]):
        fbs.append(do_item(page, it, wrong=i in wrong_items, locale=locale).split("\n")[0])
    res = page.get_by_test_id("exercise-result")
    expect(res).to_be_visible(timeout=10000)
    txt = res.inner_text()
    log(f"  {ex_id}: {txt.splitlines()[0]}  items={fbs}")
    if advance:
        page.get_by_test_id("next-exercise").click()
    return txt


def api(page, path):
    return page.evaluate("p => fetch(p).then(r => r.json())", path)


with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome", headless=True, args=["--autoplay-policy=no-user-gesture-required"])
    ctx = browser.new_context(viewport={"width": 1100, "height": 900})
    ctx.grant_permissions(["midi", "midi-sysex"])
    page = ctx.new_page()
    console = []
    page.on("console", lambda m: console.append(f"{m.type}: {m.text}"))
    page.on("pageerror", lambda e: console.append(f"pageerror: {e}"))

    page.goto(BASE + "/")
    expect(page.get_by_test_id("start-placement")).to_be_visible()
    page.wait_for_function("navigator.serviceWorker && navigator.serviceWorker.controller !== null || new Promise(r => setTimeout(() => r(false), 100))", timeout=5000)
    page.wait_for_timeout(1500)
    sw = page.evaluate("navigator.serviceWorker.getRegistration().then(r => !!(r && r.active))")
    manifest = page.evaluate("fetch('/manifest.webmanifest').then(r => r.json())")
    midi_inputs = page.evaluate("navigator.requestMIDIAccess().then(a => [...a.inputs.values()].map(i => i.name))")
    midi_outputs = page.evaluate("navigator.requestMIDIAccess().then(a => [...a.outputs.values()].map(i => i.name))")
    log("SW active:", sw, "| manifest:", manifest["name"], len(manifest["icons"]), "icons")
    log("Web MIDI inputs:", midi_inputs, "outputs:", midi_outputs)
    page.screenshot(path=str(OUT / "01-today-placement.png"), full_page=True)

    # --- placement: notation right, theory mostly unknown, some ear right
    date = api(page, "/api/today")["plan"]["date"]
    seed = f"{date}:0"
    page.get_by_test_id("start-placement").click()
    pl = api(page, "/api/lesson/placement")["placement"]
    for s in pl["sections"]:
        log(f"placement section {s['id']}")
        for ex in s["exercises"]:
            a = answers(ex["id"], seed)
            n = len(a["items"])
            wrong = set() if s["id"] == "notation" or ex["id"] in ("P-002-1", "P-003-1", "P-003-4") else set(range(n))
            run_exercise(page, ex["id"], seed, wrong_items=wrong)
    expect(page.get_by_test_id("placement-done")).to_be_visible(timeout=10000)
    log("placement result:", page.get_by_test_id("placement-done").inner_text().replace("\n", " "))
    page.screenshot(path=str(OUT / "02-placement-done.png"), full_page=True)

    # --- today's plan (Tuesday: E/K)
    page.goto(BASE + "/")
    expect(page.get_by_test_id("lesson-link").first).to_be_visible()
    plan = api(page, "/api/today")["plan"]
    log("plan:", plan["weekday"], plan["focusUsed"], [(l["id"], l["status"], l.get("aheadOfTheory")) for l in plan["lessons"]], "maintenance:", bool(plan["maintenance"]))
    page.screenshot(path=str(OUT / "03-today-plan.png"), full_page=True)

    # --- complete the first planned lesson end to end over MIDI
    lesson_id = next(l["id"] for l in plan["lessons"] if l["status"] not in ("passed", "skipped"))
    page.goto(f"{BASE}/lesson/{lesson_id}?date={date}")
    lesson = api(page, f"/api/lesson/{lesson_id}")["lesson"]
    log(f"lesson {lesson_id}: {len(lesson['exercises'])} exercises")
    received.clear()
    for k, ex in enumerate(lesson["exercises"]):
        if k == 0:
            # fail the first exercise on purpose, then retry: the retry gets fresh items (seed :1)
            n = len(answers(ex["id"], seed)["items"])
            run_exercise(page, ex["id"], seed, wrong_items=set(range(n)), advance=False)
            page.get_by_role("button", name="Retry exercise").click()
            run_exercise(page, ex["id"], f"{date}:1")
        else:
            run_exercise(page, ex["id"], seed)
    expect(page.get_by_test_id("lesson-finished")).to_be_visible(timeout=10000)
    log("lesson finished:", page.get_by_test_id("lesson-finished").inner_text().replace("\n", " "))
    st = api(page, f"/api/lesson/{lesson_id}")["status"]
    log("lesson status in DB:", st)
    note_ons = sum(1 for i in range(len(received)) if received[i] & 0xF0 == 0x90 and i + 2 < len(received) and received[i + 2] > 0)
    log(f"MIDI out to virtual piano during lesson: {len(received)} bytes, ~{note_ons} note-ons")
    page.screenshot(path=str(OUT / "04-lesson-finished.png"), full_page=True)

    # --- Serbian UI
    page.goto(BASE + "/")
    page.get_by_role("button", name="Language").click()
    page.wait_for_timeout(300)
    page.screenshot(path=str(OUT / "05-today-sr.png"), full_page=True)
    log("SR heading:", page.locator("h1").inner_text())

    # --- offline: cached lesson page + queued submission, then sync
    nxt = next((l["id"] for l in api(page, "/api/today")["plan"]["lessons"] if l["status"] != "passed"), None)
    page.goto(f"{BASE}/lesson/{nxt}?date={date}")
    page.wait_for_timeout(800)
    ctx.set_offline(True)
    page.reload()
    expect(page.locator("h1")).to_contain_text(nxt, timeout=8000)
    lesson2 = page.evaluate(f"JSON.parse(localStorage.getItem('cache:/api/lesson/{nxt}'))")["lesson"]
    first_open = lesson2["exercises"][0]["id"]
    run_exercise(page, first_open, seed, locale="sr")
    pending = page.evaluate("new Promise(r => { const q = indexedDB.open('music-trainer'); q.onsuccess = () => { const t = q.result.transaction('queue').objectStore('queue').getAll(); t.onsuccess = () => r(t.result.length) } })")
    log("offline: lesson page rendered from cache; queued submissions:", pending)
    page.screenshot(path=str(OUT / "06-offline-queued.png"), full_page=True)
    ctx.set_offline(False)
    page.evaluate("window.dispatchEvent(new Event('online'))")
    page.wait_for_timeout(2000)
    pending2 = page.evaluate("new Promise(r => { const q = indexedDB.open('music-trainer'); q.onsuccess = () => { const t = q.result.transaction('queue').objectStore('queue').getAll(); t.onsuccess = () => r(t.result.length) } })")
    ex_state = api(page, f"/api/lesson/{nxt}")["exercises"]
    log("after reconnect: queued =", pending2, "| server exercise state:", ex_state)

    # --- progress + settings pages
    page.goto(BASE + "/progress")
    page.wait_for_timeout(800)
    page.screenshot(path=str(OUT / "07-progress.png"), full_page=True)
    page.goto(BASE + "/settings")
    expect(page.get_by_test_id("voice-status")).not_to_have_text("…", timeout=8000)
    log("voice-score status:", page.get_by_test_id("voice-status").inner_text())
    page.screenshot(path=str(OUT / "08-settings.png"), full_page=True)

    errs = [c for c in console if c.startswith(("error", "pageerror"))]
    log("console errors:", len(errs), errs[:10])
    browser.close()

(OUT / "e2e-log.txt").write_text("\n".join(log_lines) + "\n")
