// Web Audio fallback "piano": a few decaying partials through a lowpass. A
// synthesized tone instead of samples keeps the PWA small and fully offline;
// real piano sound comes from MIDI out to the Arius when it is connected.

let ctx: AudioContext | null = null;
function ac(): AudioContext {
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

export function synthNote(midi: number, when: number, dur: number, vel = 0.7) {
  const c = ac();
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
