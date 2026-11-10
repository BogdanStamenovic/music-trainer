"use client";
import { useEffect, useState } from "react";
import { midi } from "@/lib/client/midi";

// On-screen keyboard: shows held notes (from MIDI or clicks) and works as an
// input when no MIDI device is present. Pointer down/up inject note on/off.
const BLACK = new Set([1, 3, 6, 8, 10]);

export function Keyboard({ from = 48, to = 84, marks = [] as number[] }: { from?: number; to?: number; marks?: number[] }) {
  const [held, setHeld] = useState<Set<number>>(new Set());
  useEffect(() => {
    const un = midi().subscribe(() => setHeld(new Set(midi().held)));
    return () => void un();
  }, []);
  const whites: number[] = [];
  for (let n = from; n <= to; n++) if (!BLACK.has(n % 12)) whites.push(n);
  const w = 100 / whites.length;
  const down = (n: number) => midi().inject({ t: performance.now(), type: "on", note: n, vel: 80 });
  const up = (n: number) => {
    if (midi().held.has(n)) midi().inject({ t: performance.now(), type: "off", note: n });
  };
  const key = (n: number, style: React.CSSProperties, black: boolean) => (
    <button
      key={n}
      type="button"
      aria-label={`key ${n}`}
      data-note={n}
      className={`key ${black ? "black" : "white"} ${held.has(n) ? "held" : ""} ${marks.includes(n) ? "mark" : ""}`}
      style={style}
      onPointerDown={(e) => {
        e.preventDefault();
        down(n);
      }}
      onPointerUp={() => up(n)}
      onPointerLeave={() => up(n)}
    >
      {n % 12 === 0 && !black ? <span>C{Math.floor(n / 12) - 1}</span> : null}
    </button>
  );
  return (
    <div className="keyboard" role="group" aria-label="keyboard">
      {whites.map((n, i) => key(n, { left: `${i * w}%`, width: `${w}%` }, false))}
      {whites.map((n, i) => (BLACK.has((n + 1) % 12) && n + 1 <= to ? key(n + 1, { left: `${(i + 1) * w - w * 0.3}%`, width: `${w * 0.6}%` }, true) : null))}
    </div>
  );
}
