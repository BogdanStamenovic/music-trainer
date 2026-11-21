// Web Audio fallback "piano": a few decaying partials through a lowpass. A
// synthesized tone instead of samples keeps the PWA small and fully offline;
// real piano sound comes from MIDI out to the Arius when it is connected.

let ctx: AudioContext | null = null;
function ac(): AudioContext {
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

export function synthNote(midi: number, when: number, dur: number, vel = 0.7, c: BaseAudioContext = ac()) {
  const t0 = c.currentTime + Math.max(0, when);
  const f = 440 * Math.pow(2, (midi - 69) / 12);
  const out = c.createGain();
  const lp = c.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = Math.min(12000, f * 8);
  out.connect(lp).connect(c.destination);
  const peak = 0.22 * vel;
  const decay = Math.max(0.6, 2.4 - (midi - 48) / 30); // low notes ring longer
  out.gain.setValueAtTime(0, t0);
  out.gain.linearRampToValueAtTime(peak, t0 + 0.006);
  out.gain.exponentialRampToValueAtTime(peak * 0.35, t0 + 0.25);
  out.gain.exponentialRampToValueAtTime(0.0008, t0 + Math.min(decay, dur + 0.4));
  const partials: [number, number, OscillatorType][] = [[1, 1, "triangle"], [2, 0.35, "sine"], [3, 0.12, "sine"], [4, 0.06, "sine"]];
  for (const [mult, g, type] of partials) {
    const o = c.createOscillator();
    const og = c.createGain();
    o.type = type;
    o.frequency.value = f * mult;
    og.gain.value = g;
    o.connect(og).connect(out);
    o.start(t0);
    o.stop(t0 + Math.min(decay, dur + 0.4) + 0.05);
  }
}

export function unlockAudio() {
  ac();
}

// iOS Safari keeps an AudioContext suspended unless it is created/resumed inside a user
// gesture. The reference for a sung item auto-plays when the item opens (not a gesture),
// so on an iPhone (no Web MIDI, Web Audio fallback) it could stay silent and the learner
// sang the previous exercise's pitch (voice-score-40, 2026-11-21: all four 0.0 takes).
// Unlock on the first touch/click anywhere, with a silent buffer as iOS requires.
if (typeof window !== "undefined") {
  const unlock = () => {
    try {
      const c = ac();
      const b = c.createBuffer(1, 1, 22050);
      const s = c.createBufferSource();
      s.buffer = b;
      s.connect(c.destination);
      s.start(0);
      if (c.state === "running") for (const k of ["pointerdown", "touchend", "keydown"]) window.removeEventListener(k, unlock, true);
    } catch {
      /* no Web Audio */
    }
  };
  for (const k of ["pointerdown", "touchend", "keydown"]) window.addEventListener(k, unlock, true);
}

/** False when audio cannot sound yet (iOS before the first tap): the UI should offer a play button. */
export function audioReady(): boolean {
  return !!ctx && ctx.state === "running";
}

// ---------- iPhone: references through an <audio> element ----------
// Unverified on a real iPhone (no iOS in CI): Web Audio on iOS can be muted by the
// ring/silent switch and by the audio-session change when the mic opens. An <audio>
// element playing a rendered WAV is treated as media playback, which the silent switch
// does not mute (with audioSession "playback"). Used on iOS only.

export function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

/** Safari 16.4+ `navigator.audioSession`: "playback" for references, "play-and-record" while recording. */
export function setAudioSession(type: "playback" | "play-and-record" | "auto") {
  try {
    const as = (navigator as unknown as { audioSession?: { type: string } }).audioSession;
    if (as) as.type = type;
  } catch {
    /* not supported */
  }
}

type Ev = { at: number; notes: number[]; dur: number; vel?: number };

/** Render note events with the same synth into a 16-bit mono WAV. */
export async function renderWav(events: Ev[]): Promise<Blob> {
  const total = events.length ? Math.max(...events.map((e) => e.at + e.dur)) + 1.2 : 0.5;
  const rate = 22050;
  const off = new OfflineAudioContext(1, Math.ceil(total * rate), rate);
  for (const e of events) for (const n of e.notes) synthNote(n, e.at, e.dur, (e.vel ?? 80) / 115, off);
  const buf = await off.startRendering();
  const data = buf.getChannelData(0);
  const out = new DataView(new ArrayBuffer(44 + data.length * 2));
  const str = (o: number, t: string) => [...t].forEach((ch, i) => out.setUint8(o + i, ch.charCodeAt(0)));
  str(0, "RIFF");
  out.setUint32(4, 36 + data.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true);
  out.setUint16(22, 1, true);
  out.setUint32(24, rate, true);
  out.setUint32(28, rate * 2, true);
  out.setUint16(32, 2, true);
  out.setUint16(34, 16, true);
  str(36, "data");
  out.setUint32(40, data.length * 2, true);
  for (let i = 0; i < data.length; i++) out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, data[i])) * 0x7fff, true);
  return new Blob([out], { type: "audio/wav" });
}

let el: HTMLAudioElement | null = null;
/** Play events through an <audio> element; resolves true if playback actually started. */
export async function playViaElement(events: Ev[]): Promise<boolean> {
  stopElement();
  setAudioSession("playback");
  const url = URL.createObjectURL(await renderWav(events));
  el = new Audio(url);
  el.onended = () => URL.revokeObjectURL(url);
  try {
    await el.play();
    return true;
  } catch {
    return false;
  }
}
export function stopElement() {
  if (el) {
    el.pause();
    el = null;
  }
}
