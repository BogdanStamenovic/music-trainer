"use client";
import { useEffect, useState } from "react";
import type { HarmonizeItem, PlaySpec } from "@/lib/curriculum/items";
import type { Response } from "@/lib/grading";
import { useI18n } from "@/lib/client/i18n";
import { midi } from "@/lib/client/midi";

/** Melody alone, or melody + one chord per slot (null = no chord in that slot). */
export function harmonizePlay(item: HarmonizeItem, picks?: (string | null)[]): PlaySpec {
  const melody: PlaySpec = { mode: "melodic", notes: item.melody, durations: item.durations, tempo: item.tempo };
  if (!picks) return melody;
  const chords: number[][] = [];
  const durations: number[] = [];
  if (item.pickup > 0) {
    chords.push([]);
    durations.push(item.pickup);
  }
  item.slots.forEach((len, i) => {
    chords.push(picks[i] ? item.chordNotes[picks[i]!] : []);
    durations.push(len);
  });
  return { mode: "layers", tempo: item.tempo, layers: [melody, { mode: "chords", chords, durations, tempo: item.tempo }] };
}

/** Slot labels "bar 3" or "bar 3 (2nd half)", counted from the first full bar. */
function slotLabels(item: HarmonizeItem, bar: string, half: string): string[] {
  let t = 0;
  return item.slots.map((len) => {
    const b = Math.floor(t / item.beatsPerBar + 1e-9) + 1;
    const off = t - (b - 1) * item.beatsPerBar;
    t += len;
    return off > 1e-9 ? `${bar} ${b} (${half})` : `${bar} ${b}`;
  });
}

export function HarmonizeInput({ item, onSubmit, disabled }: { item: HarmonizeItem; onSubmit: (r: Response) => void; disabled: boolean }) {
  const { t, l } = useI18n();
  const [picks, setPicks] = useState<(string | null)[]>(() => item.slots.map(() => null));
  useEffect(() => () => midi().stop(), []);
  const labels = slotLabels(item, t("bar"), t("secondHalf"));
  const complete = picks.every((p) => p !== null);
  return (
    <div className="harmonize" data-testid="harmonize">
      <p className="muted small">♪ {l(item.tune)}</p>
      <div className="row">
        <button type="button" className="secondary" onClick={() => void midi().play(harmonizePlay(item))} data-testid="hz-melody">
          ▶ {t("melodyOnly")}
        </button>
        <button type="button" className="secondary" onClick={() => void midi().play(harmonizePlay(item, picks))} disabled={!picks.some(Boolean)} data-testid="hz-mine">
          ▶ {t("withMyChords")}
        </button>
      </div>
      <ol className="hz-slots">
        {item.slots.map((_, i) => (
          <li key={i}>
            <span className="small muted">{labels[i]}</span>
            <span className="hz-choices">
              {item.choices.map((c) => (
                <button
                  type="button"
                  key={c}
                  className={`hz-choice ${picks[i] === c ? "picked" : ""}`}
                  disabled={disabled}
                  onClick={() => setPicks((p) => p.map((x, k) => (k === i ? c : x)))}
                  data-testid={`hz-${i}-${c}`}
                >
                  {c}
                </button>
              ))}
            </span>
          </li>
        ))}
      </ol>
      {!disabled ? (
        <button type="button" className="primary" disabled={!complete} onClick={() => onSubmit({ kind: "harmonize", picks })} data-testid="hz-check">
          {t("check")}
        </button>
      ) : null}
    </div>
  );
}

export function HarmonizeFeedback({ item, detail }: { item: HarmonizeItem; detail: Record<string, unknown> }) {
  const { t } = useI18n();
  const ok = (detail.ok as boolean[] | undefined) ?? [];
  const picks = (detail.picks as (string | null)[] | undefined) ?? [];
  const labels = slotLabels(item, t("bar"), t("secondHalf"));
  return (
    <div className="hz-feedback" data-testid="hz-feedback">
      <table className="small">
        <tbody>
          {item.slots.map((_, i) => (
            <tr key={i} className={ok[i] ? "good" : "bad"}>
              <td>{labels[i]}</td>
              <td>
                {ok[i] ? "✓" : "✗"} {picks[i] ?? "—"}
              </td>
              <td className="muted">
                {t("usual")}: {item.model[i]}
                {item.accept[i].length > 1 ? ` (${t("alsoFits")}: ${item.accept[i].filter((c) => c !== item.model[i]).join(", ")})` : ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row">
        <button type="button" className="secondary" onClick={() => void midi().play(harmonizePlay(item, picks))} data-testid="hz-fb-mine">
          ▶ {t("withMyChords")}
        </button>
        <button type="button" className="secondary" onClick={() => void midi().play(harmonizePlay(item, item.model))} data-testid="hz-fb-model">
          ▶ {t("withUsualChords")}
        </button>
      </div>
    </div>
  );
}
