"""Voice E2E in real Chrome. The microphone is FAKED: getUserMedia returns an
oscillator stream whose pitch the driver sets per item (window.__fakeHz). Everything
after the mic is real: MediaRecorder, upload, voice-score (or the in-browser
voice-score-lite fallback), grading, storage, history playback.

Usage: python e2e_voice.py BASE_URL OUT_DIR [--fallback]
  --fallback: the server under test points at a dead voice-score URL, so analysis
              must happen in the browser (onnxruntime-web WASM); also tests offline.
"""
import json
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright, expect

BASE, OUT = sys.argv[1], Path(sys.argv[2])
FALLBACK = "--fallback" in sys.argv
OUT.mkdir(parents=True, exist_ok=True)
REPO = Path(__file__).resolve().parents[2]
lines: list[str] = []


def log(*a):
    s = " ".join(str(x) for x in a)
    lines.append(s)
    print(s, flush=True)


FAKE_MIC = """
window.__fakeHz = 0;
const realGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
navigator.mediaDevices.getUserMedia = async (c) => {
  if (!c || !c.audio) return realGUM(c);
  const ac = new AudioContext();
  const o = ac.createOscillator(); o.type = "triangle";
  const g = ac.createGain(); g.gain.value = 0;
  const d = ac.createMediaStreamDestination();
  o.connect(g).connect(d); o.start();
  setInterval(() => {
    const hz = window.__fakeHz || 0;
    if (hz > 0) o.frequency.setTargetAtTime(hz, ac.currentTime, 0.01);
    g.gain.setTargetAtTime(hz > 0 ? 0.35 : 0, ac.currentTime, 0.01);
  }, 15);
  return d.stream;
};
"""


def hz(m):
    return 440 * 2 ** ((m - 69) / 12)


def answers(ex_id, seed, ctx):
    out = subprocess.check_output(["npx", "tsx", "scripts/dev/answers.ts", ex_id, seed, "", json.dumps(ctx)], cwd=REPO)
    return json.loads(out)


def sing(page, targets, beats=None, tempo=None, sustain=None, off=0.0):
    """Wait for the reference playback, then 'sing' the targets through the fake mic."""
    time.sleep(1.2 + 0.5 * len(targets))
    page.get_by_test_id("record").click()
    time.sleep(0.3)
    if beats:
        beat = 60.0 / tempo
        for m, b in zip(targets, beats):
            page.evaluate(f"window.__fakeHz = {hz(m + off)}")
            time.sleep(b * beat * 0.92)
            page.evaluate("window.__fakeHz = 0")
            time.sleep(b * beat * 0.08)
    else:
        page.evaluate(f"window.__fakeHz = {hz(targets[0] + off)}")
        time.sleep((sustain or 2) + 0.6)
        page.evaluate("window.__fakeHz = 0")
    time.sleep(0.2)
    if page.get_by_test_id("stop").count():
        page.get_by_test_id("stop").click()
    expect(page.get_by_test_id("feedback")).to_be_visible(timeout=60000)
    fb = page.get_by_test_id("feedback").inner_text().replace("\n", " | ")
    page.get_by_test_id("next").click()
    return fb


def api(page, path):
    return page.evaluate("p => fetch(p).then(r => r.json())", path)


def finish_exercise(page):
    res = page.get_by_test_id("exercise-result")
    expect(res).to_be_visible(timeout=20000)
    t = res.inner_text().splitlines()[0]
    page.get_by_test_id("next-exercise").click()
    return t


def run_lesson(page, lesson_id, date, ctx, sharp_items=()):
    page.goto(f"{BASE}/lesson/{lesson_id}?date={date}")
    lesson = api(page, f"/api/lesson/{lesson_id}")["lesson"]
    k = 0
    for ex in lesson["exercises"]:
        a = answers(ex["id"], f"{date}:0", ctx)
        fbs = []
        for it in a["items"]:
            if it["kind"] == "checkin":
                page.get_by_test_id("checkin-fine").click()
                page.get_by_test_id("next").click()
                fbs.append("checkin fine")
            elif it["kind"] == "practice":
                page.get_by_role("button", name="Did it").click()
                page.get_by_test_id("next").click()
                fbs.append("practice")
            elif it["kind"] == "range":
                for m in (45, 64):  # A2 low glide end, E4 high glide end
                    page.get_by_test_id("record").click()
                    page.evaluate(f"window.__fakeHz = {hz(m)}")
                    time.sleep(2.5)
                    page.evaluate("window.__fakeHz = 0")
                    time.sleep(0.2)
                    page.get_by_role("button", name="■ Stop").click()
                    time.sleep(0.5)
                    page.wait_for_function("!document.body.innerText.includes('Analyzing')", timeout=60000)
                expect(page.get_by_test_id("feedback")).to_be_visible(timeout=60000)
                fbs.append(page.get_by_test_id("range-result").inner_text())
                page.get_by_test_id("next").click()
            elif it["kind"] == "sing":
                off = 1.0 if k in sharp_items else 0.0
                fbs.append(sing(page, it["targets"], it.get("beats"), it.get("tempo"), it.get("sustain"), off))
                k += 1
            else:
                raise RuntimeError(f"unexpected item kind {it['kind']}")
        log(f"  {ex['id']}: {finish_exercise(page)}")
        for f in fbs:
            log(f"      {f}")


with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome", headless=True, args=["--autoplay-policy=no-user-gesture-required"])
    ctxb = browser.new_context(viewport={"width": 1000, "height": 900})
    ctxb.grant_permissions(["microphone", "midi"])
    ctxb.add_init_script(FAKE_MIC)
    page = ctxb.new_page()
    console = []
    page.on("console", lambda m: console.append(f"{m.type}: {m.text}"))
    page.on("pageerror", lambda e: console.append(f"pageerror: {e}"))

    page.goto(BASE + "/")
    page.evaluate("fetch('/api/settings', {method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({placementSkipped: true})})")
    date = api(page, "/api/today")["plan"]["date"]
    log("voice-score as seen by the server:", api(page, "/api/voice-score/health"))

    if not FALLBACK:
        log("V-003 (range):")
        run_lesson(page, "V-003", date, {})
        vr = api(page, "/api/settings")["voiceRange"]
        log("stored voiceRange:", vr)
        ctx = {"voiceRange": [vr["comfortLow"], vr["comfortHigh"]]}
        log("V-004 (pitch matching; item 2 sung a semitone sharp on purpose):")
        run_lesson(page, "V-004", date, ctx, sharp_items={1})
        log("V-009 (phrases):")
        run_lesson(page, "V-009", date, ctx)
        st = api(page, "/api/lesson/V-004")["status"]
        log("V-004 status:", st)
        # consent gate for voice-score validation
        r0 = page.evaluate("fetch('/api/voice/validation-set').then(r => r.status)")
        page.goto(BASE + "/voice")
        page.get_by_test_id("share-toggle").click()
        expect(page.get_by_test_id("share-toggle")).to_be_checked(timeout=5000)
        vs = api(page, "/api/voice/validation-set?limit=3")
        log(f"validation-set: before consent HTTP {r0}; after consent {len(vs['recordings'])} recordings, first path {vs['recordings'][0]['path']}")
        page.get_by_test_id("share-toggle").click()
        expect(page.get_by_test_id("share-toggle")).not_to_be_checked(timeout=5000)
        r1 = page.evaluate("fetch('/api/voice/validation-set').then(r => r.status)")
        log(f"validation-set after consent withdrawn: HTTP {r1}")
        page.reload()
        n = page.get_by_test_id("recording").count()
        audio_ok = page.evaluate("fetch(document.querySelector('audio').src, {headers: {Range: 'bytes=0-99'}}).then(r => [r.status, r.headers.get('content-type')])")
        log(f"/voice history: {n} recordings listed; audio range request -> {audio_ok}")
        page.screenshot(path=str(OUT / "voice-history.png"), full_page=True)
        # check-in "hoarse" ends the block
        page.goto(f"{BASE}/lesson/V-005?date={date}")
        page.get_by_test_id("checkin-hoarse").click()
        page.get_by_test_id("next").click()
        # the queue switches straight to the rest notice once the check-in is saved
        expect(page.get_by_test_id("voice-rest")).to_be_visible(timeout=5000)
        log("check-in hoarse -> voice rest shown:", page.get_by_test_id("voice-rest").inner_text()[:80])
        page.goto(f"{BASE}/lesson/V-006?date={date}")
        expect(page.get_by_test_id("voice-rest")).to_be_visible(timeout=5000)
        log("other voice lesson same day -> also blocked")
        page.screenshot(path=str(OUT / "voice-rest.png"), full_page=True)
    else:
        log("FALLBACK run (server points at a dead voice-score):")
        t0 = time.time()
        run_lesson(page, "V-004", date, {})
        log(f"  V-004 done in {time.time() - t0:.0f}s with browser analysis")
        recs = api(page, "/api/voice/recordings")["recordings"]
        log("  recordings:", [(r["status"], (r["browserAnalysis"] or {}).get("tracker"), r["serverAnalysis"] is not None) for r in recs[:6]])
        # offline: the trainer server is unreachable too -> analyze locally, queue the take
        page.goto(f"{BASE}/lesson/V-007?date={date}")
        page.wait_for_timeout(1000)
        ctxb.set_offline(True)
        page.get_by_test_id("checkin-fine").click()
        page.get_by_test_id("next").click()
        finish_exercise(page)
        page.get_by_role("button", name="Did it").click()
        page.get_by_test_id("next").click()
        finish_exercise(page)
        lesson7 = page.evaluate("JSON.parse(localStorage.getItem('cache:/api/lesson/V-007'))")["lesson"]
        ex3 = next(e for e in lesson7["exercises"] if e["type"] == "generated")
        it = answers(ex3["id"], f"{date}:0", {})["items"][0]
        fb = sing(page, it["targets"], it.get("beats"), it.get("tempo"), it.get("sustain"))
        log("  offline sing item:", fb)
        q = page.evaluate("new Promise(r => { const o = indexedDB.open('music-trainer-voice'); o.onsuccess = () => { const t = o.result.transaction('uploads').objectStore('uploads').count(); t.onsuccess = () => r(t.result) } })")
        log("  queued uploads while offline:", q)
        ctxb.set_offline(False)
        page.evaluate("window.dispatchEvent(new Event('online'))")
        page.wait_for_timeout(3000)
        q2 = page.evaluate("new Promise(r => { const o = indexedDB.open('music-trainer-voice'); o.onsuccess = () => { const t = o.result.transaction('uploads').objectStore('uploads').count(); t.onsuccess = () => r(t.result) } })")
        recs2 = api(page, "/api/voice/recordings")["recordings"]
        log(f"  after reconnect: queued uploads {q2}; server has {len(recs2)} recordings (was {len(recs)})")

    errs = [c for c in console if c.startswith(("error", "pageerror"))]
    log("console errors:", len(errs), errs[:8])
    browser.close()

(OUT / ("e2e-voice-fallback.log" if FALLBACK else "e2e-voice.log")).write_text("\n".join(lines) + "\n")
