"""The rule checks. Each takes a Piece (plus the request) and returns a result dict.

Every check returns {"id", "pass", "score" (0..1), "weight", "detail", "bars"}.
Bar numbers are on the requested meter's grid (pickup = bar 0), which matches
the learner's bar lines whenever the rhythm check passes.
"""

from __future__ import annotations

from typing import Callable

from .parse import EPS, Note, Piece

WEIGHTS = {
    "bars": 1,
    "rhythm": 1,
    "range": 1,
    "key": 1,
    "cadence": 2,
    "half-cadence": 1,
    "leaps": 1,
    "stepwise": 1,
    "augmented": 1,
    "parallels": 2,
}

# Per-violation penalty for the "no X allowed" rules (augmented, parallels):
# one violation costs a third of the check, three or more zero it.
PENALTY = 1 / 3

_ORDINAL = {1: "unison", 2: "2nd", 3: "3rd", 4: "4th", 5: "5th", 6: "6th", 7: "7th", 8: "octave",
            9: "9th", 10: "10th", 11: "11th", 12: "12th", 13: "13th", 14: "14th", 15: "two octaves"}


def _r(x: float) -> float:
    return round(max(0.0, min(1.0, x)), 3)


def _result(cid: str, ok: bool, score: float, detail: str, bars: list[int] | None = None) -> dict:
    return {
        "id": cid,
        "pass": bool(ok),
        "score": _r(score),
        "weight": WEIGHTS.get(cid, 1),
        "detail": detail,
        "bars": sorted(set(bars or [])),
    }


def name(n: Note) -> str:
    return n.pitch.nameWithOctave.replace("-", "b")


def pname(p) -> str:
    return p.nameWithOctave.replace("-", "b")


def _ivl(a: Note, b: Note):
    from music21 import interval

    return interval.Interval(a.pitch, b.pitch)


def _size_words(semis: int) -> str:
    """Rough interval size in words from semitones (for span / leap reports)."""
    generic = {0: 1, 1: 2, 2: 2, 3: 3, 4: 3, 5: 4, 6: 4, 7: 5, 8: 6, 9: 6, 10: 7, 11: 7, 12: 8}
    octs, rem = divmod(abs(semis), 12)
    g = generic[rem] + 7 * octs if not (rem == 0 and octs) else 8 + 7 * (octs - 1)
    return _ORDINAL.get(g, f"{g}th")


def _bars_list(bars: list[int], limit: int = 6) -> str:
    bs = sorted(set(bars))
    s = ", ".join(str(b) for b in bs[:limit])
    return s + (", ..." if len(bs) > limit else "")


# ---------------------------------------------------------------- bars / rhythm


def _count_bars(piece: Piece) -> tuple[int, float, float]:
    """(complete bars, pickup length, length of a trailing incomplete bar)."""
    end = max(v.end for v in piece.voices)
    body = end - piece.pickup
    full = int((body + EPS) // piece.bar_len)
    rem = body - full * piece.bar_len
    if rem < EPS:
        rem = 0.0
    complete = full
    if piece.pickup > EPS and rem > EPS and abs(piece.pickup + rem - piece.bar_len) < EPS:
        complete += 1  # pickup + short last bar make one bar between them
    return complete, piece.pickup, rem


def _voice_bars(piece: Piece, v) -> int:
    """Complete bars one voice covers (same pickup / short-last-bar rule as the piece)."""
    body = v.end - piece.pickup
    full = int((body + EPS) // piece.bar_len)
    rem = body - full * piece.bar_len
    if piece.pickup > EPS and rem > EPS and abs(piece.pickup + rem - piece.bar_len) < EPS:
        full += 1
    return full


def check_bars(piece: Piece, req: dict) -> dict:
    want = req.get("bars")
    have, pickup, rem = _count_bars(piece)
    # Two voices: each must cover the piece. A bass written for 1 of 8 bars is not a bass
    # line (the piece length alone comes from the longest voice and would hide it).
    if len(piece.voices) > 1:
        short = [(i, _voice_bars(piece, v)) for i, v in enumerate(piece.voices) if _voice_bars(piece, v) < have]
        if short:
            i, n = short[0]
            label = "melody" if i == 0 else "bass"
            return _result("bars", False, max(0.0, n / max(1, have)) * 0.5, f"the {label} covers only {n} of {have} bars", list(range(n + 1, have + 1)))
    notes = []
    if pickup > EPS:
        notes.append(f"pickup of {pickup:g} beats")
    if rem > EPS:
        notes.append(f"short last bar ({rem:g} of {piece.bar_len:g} beats)")
    extra = f" ({'; '.join(notes)})" if notes else ""
    if not isinstance(want, int) or want <= 0:
        return _result("bars", True, 1.0, f"{have} complete bar{'' if have == 1 else 's'}{extra}; no bar count requested")
    if have == want:
        return _result("bars", True, 1.0, f"{have} complete bars as asked{extra}")
    score = 1 - abs(have - want) / want
    return _result("bars", False, score, f"{have} complete bar{'' if have == 1 else 's'}, project asks for {want}{extra}")


def check_rhythm(piece: Piece, req: dict) -> dict:
    bl = piece.bar_len
    bad: list[int] = []
    msgs: list[str] = []
    total = 0
    multi = len(piece.voices) > 1
    no_lines = []
    for vi, v in enumerate(piece.voices):
        label = ("melody" if vi == 0 else "bass") if multi else ""
        wb = v.written_bars
        if not wb:
            no_lines.append(label or "melody")
            # Without bar lines only the final grid bar can be incomplete.
            n_bars = max(1, int((v.end - piece.pickup + bl - EPS) // bl))
            total += n_bars
            rem = (v.end - piece.pickup) - (n_bars - 1) * bl
            if abs(rem - bl) > EPS and not (piece.pickup > EPS and abs(rem + piece.pickup - bl) < EPS):
                bad.append(n_bars)
                msgs.append(f"{label + ' ' if label else ''}bar {n_bars} has {rem:g} beats")
            continue
        pickup = wb[0][1] < bl - EPS
        for i, (start, length) in enumerate(wb):
            num = i if pickup else i + 1
            total += 1
            if abs(length - bl) < EPS:
                continue
            if i == 0 and pickup:
                continue
            if i == len(wb) - 1 and pickup and abs(length + wb[0][1] - bl) < EPS:
                continue
            bad.append(num)
            msgs.append(f"{label + ' ' if label else ''}bar {num} has {length:g} beats")
    meter_note = ""
    if piece.abc_meter and piece.abc_meter.replace(" ", "") != piece.meter.replace(" ", ""):
        meter_note = f" (ABC says M:{piece.abc_meter}, project asks {piece.meter}; checked against {piece.meter})"
    lines_note = f"; no bar lines written in {', '.join(no_lines)}, checked on the {piece.meter} grid" if no_lines else ""
    if not bad:
        return _result("rhythm", True, 1.0, f"every bar fills {piece.meter}{meter_note}{lines_note}")
    score = 1 - len(bad) / max(1, total)
    detail = f"{'; '.join(msgs[:4])}{' ...' if len(msgs) > 4 else ''}, {piece.meter} needs {bl:g}{meter_note}{lines_note}"
    return _result("rhythm", False, score, detail, bad)


# ---------------------------------------------------------------- range / key


def check_range(piece: Piece, req: dict) -> dict:
    from music21 import pitch

    mel = piece.melody.notes
    lo = min(mel, key=lambda n: n.pitch.ps)
    hi = max(mel, key=lambda n: n.pitch.ps)
    span = hi.midi - lo.midi
    span_ok = span <= 16
    span_score = 1.0 if span_ok else max(0.0, 1 - (span - 16) / 12)
    w = _size_words(span)
    detail = f"span {name(lo)}-{name(hi)} = {span} semitones ({'an' if w[0] in 'o8' or w.startswith(('11', '18')) else 'a'} {w})"
    if not span_ok:
        detail += ", wider than a 10th (16)"
    bars: list[int] = []
    rng = req.get("range")
    in_score, in_ok = 1.0, True
    if isinstance(rng, (list, tuple)) and len(rng) == 2:
        rlo, rhi = int(rng[0]), int(rng[1])
        outside = [n for n in mel if n.midi < rlo or n.midi > rhi]
        in_ok = not outside
        in_score = 1 - len(outside) / len(mel)
        lo_n = pname(pitch.Pitch(midi=rlo))
        hi_n = pname(pitch.Pitch(midi=rhi))
        if in_ok:
            detail += f"; all notes inside {lo_n}-{hi_n}"
        else:
            bars = [piece.bar_of(n.offset) for n in outside]
            ex = ", ".join(f"{name(n)} (bar {piece.bar_of(n.offset)})" for n in outside[:4])
            detail += f"; {len(outside)} note(s) outside {lo_n}-{hi_n}: {ex}"
        score = (span_score + in_score) / 2
    else:
        score = span_score
    if not span_ok:
        bars += [piece.bar_of(lo.offset), piece.bar_of(hi.offset)]
    return _result("range", span_ok and in_ok, score, detail, bars)


def check_key(piece: Piece, req: dict) -> dict:
    mel = piece.melody.notes
    out = [n for n in mel if piece.degree(n) is None]
    frac = 1 - len(out) / len(mel)
    det = f"detected {piece.key_detected}" if piece.key_detected else "key detection failed"
    allowed = " (raised 6th/7th allowed)" if piece.key.mode == "minor" else ""
    if not out:
        return _result("key", True, 1.0, f"all {len(mel)} melody notes are in {piece.key_name}{allowed}; {det}")
    ex = ", ".join(f"{name(n)} (bar {piece.bar_of(n.offset)})" for n in out[:5])
    return _result(
        "key",
        frac >= 0.9,
        frac,
        f"{len(mel) - len(out)}/{len(mel)} melody notes in {piece.key_name}{allowed}; outside: {ex}; {det}",
        [piece.bar_of(n.offset) for n in out],
    )


# ---------------------------------------------------------------- cadences

_DEG_NAME = {1: "tonic", 2: "supertonic", 3: "mediant", 4: "subdominant", 5: "dominant", 6: "submediant", 7: "leading tone"}


def _deg_word(piece: Piece, n: Note) -> str:
    d = piece.degree(n)
    if d is None:
        return f"{name(n)} (not in {piece.key_name})"
    word = _DEG_NAME[d]
    if d == 7 and (n.midi - piece.key.tonic.pitchClass) % 12 == 10:
        word = "subtonic"
    return f"{n.pitch.name.replace('-', 'b')} (degree {d}, {word})"


def check_cadence(piece: Piece, req: dict) -> dict:
    mel = piece.melody.notes
    last = mel[-1]
    bar = piece.bar_of(last.offset)
    d = piece.degree(last)
    tonic = piece.key.tonic.name.replace("-", "b")
    # A repeated final note (D3 D2) is approached from whatever came before the repeat.
    prev = next((n for n in reversed(mel[:-1]) if n.midi != last.midi), None)
    pd = piece.degree(prev) if prev else None
    step_in = prev is not None and 1 <= abs(last.midi - prev.midi) <= 2

    if d == 1:
        if step_in and pd in (2, 7):
            score, how = 1.0, f"ends {pd}-1 on the tonic {tonic}"
        else:
            score, how = 0.8, f"ends on the tonic {tonic}, approached from {_deg_word(piece, prev) if prev else 'nothing'} rather than by step from 2 or 7"
    elif d in (3, 5):
        score, how = 0.5, f"ends on {_deg_word(piece, last)}, a tonic-chord tone but not the tonic {tonic}"
    else:
        score, how = 0.0, f"ends on {_deg_word(piece, last)}, not the tonic {tonic}"
    bars = [bar]
    bass = piece.bass
    if bass is not None and bass.notes:
        bl = bass.notes[-1]
        bp = next((n for n in reversed(bass.notes[:-1]) if n.midi % 12 != bl.midi % 12), None)
        bd, bpd = piece.degree(bl), (piece.degree(bp) if bp else None)
        if bd == 1 and bpd == 5:
            how += "; bass V-I"
        elif bd == 1:
            score *= 0.75
            how += f"; bass ends on the tonic but from {_deg_word(piece, bp) if bp else 'nothing'}, not V-I"
        else:
            score *= 0.5
            how += f"; bass ends on {_deg_word(piece, bl)}, not the tonic"
        bars.append(piece.bar_of(bl.offset))
    return _result("cadence", score >= 0.75, score, f"{how} (bar {bar})", bars)


def _half_cadence_bars(n_bars: int) -> list[int]:
    """Where antecedent phrases end: bar 4 of an 8-bar period; bars 4 and 12 of a 16-bar
    double period (bar 8 there is the first period's full close, not a half cadence)."""
    if n_bars >= 16 and n_bars % 8 == 0:
        return [b for b in range(4, n_bars, 8)]
    return [n_bars // 2]


def check_half_cadence(piece: Piece, req: dict) -> dict:
    want = req.get("bars")
    n_bars = want if isinstance(want, int) and want > 0 else _count_bars(piece)[0]
    if n_bars < 8:
        return _result("half-cadence", True, 1.0, f"{n_bars} bars: half cadence only checked for 8 or more")
    mel = piece.melody.notes
    good: list[str] = []
    bad: list[str] = []
    bad_bars: list[int] = []
    for mid in _half_cadence_bars(n_bars):
        in_bar = [n for n in mel if piece.bar_of(n.offset) == mid]
        note = in_bar[-1] if in_bar else next((n for n in reversed(mel) if piece.bar_of(n.offset) < mid), None)
        if note is None:
            bad.append(f"no melody note in or before bar {mid}")
            bad_bars.append(mid)
            continue
        d = piece.degree(note)
        if d in (2, 5, 7):
            good.append(f"bar {mid} ends on {_deg_word(piece, note)}")
        elif d == 1:
            bad.append(f"bar {mid} ends on the tonic: the phrase closes instead of pausing on V (use 2, 5 or 7)")
            bad_bars.append(mid)
        else:
            bad.append(f"bar {mid} ends on {_deg_word(piece, note)}, not 2, 5 or 7 (no half cadence on V)")
            bad_bars.append(mid)
    total = len(good) + len(bad)
    if not bad:
        return _result("half-cadence", True, 1.0, "; ".join(good) + ": half cadence on V", [int(x.split()[1]) for x in good])
    return _result("half-cadence", False, len(good) / total, "; ".join(bad + good), bad_bars)


# ---------------------------------------------------------------- melodic motion


def _pairs(piece: Piece) -> list[tuple[Note, Note]]:
    mel = piece.melody.notes
    return list(zip(mel, mel[1:]))


def check_leaps(piece: Piece, req: dict) -> dict:
    mel = piece.melody.notes
    leaps = 0
    problems: list[str] = []
    bars: list[int] = []
    for i in range(len(mel) - 1):
        a, b = mel[i], mel[i + 1]
        semis = b.midi - a.midi
        if abs(semis) <= 2:
            continue
        leaps += 1
        where = piece.bar_of(b.offset)
        if abs(semis) > 12:
            problems.append(f"{name(a)}-{name(b)} leaps {abs(semis)} semitones (more than an octave, bar {where})")
            bars.append(where)
            continue
        if abs(semis) >= 8 and i + 2 < len(mel):
            nxt = mel[i + 2].midi - b.midi
            if not (1 <= abs(nxt) <= 2 and (nxt > 0) != (semis > 0)):
                problems.append(
                    f"{name(a)}-{name(b)} ({_size_words(semis)} {'up' if semis > 0 else 'down'}, bar {where}) "
                    f"is not followed by a step back"
                )
                bars.append(where)
    if not leaps:
        return _result("leaps", True, 1.0, "no leaps (all motion by step or repeat)")
    if not problems:
        return _result("leaps", True, 1.0, f"{leaps} leap(s), none over an octave, every 6th or larger recovered by a step back")
    score = 1 - len(problems) / leaps
    more = f" (+{len(problems) - 3} more)" if len(problems) > 3 else ""
    return _result("leaps", False, score, "; ".join(problems[:3]) + more, bars)


def check_stepwise(piece: Piece, req: dict) -> dict:
    moves = [(a, b) for a, b in _pairs(piece) if a.midi != b.midi]
    if not moves:
        return _result("stepwise", False, 0.0, "no melodic motion (single note or only repeats)")
    steps = sum(1 for a, b in moves if abs(b.midi - a.midi) <= 2)
    frac = steps / len(moves)
    pct = round(frac * 100)
    if frac >= 0.5 - EPS:
        return _result("stepwise", True, 1.0, f"{steps}/{len(moves)} moves by step ({pct}%)")
    return _result("stepwise", False, frac / 0.5, f"only {steps}/{len(moves)} moves by step ({pct}%, aim for 50%+)")


def check_augmented(piece: Piece, req: dict) -> dict:
    mel = piece.melody.notes
    problems: list[str] = []
    bars: list[int] = []
    for i in range(len(mel) - 1):
        a, b = mel[i], mel[i + 1]
        if a.midi == b.midi:
            continue
        ivl = _ivl(a, b)
        spec = ivl.diatonic.specifierAbbreviation  # 'A', 'd', 'P', 'M', 'm', 'AA', ...
        simple_generic = ivl.generic.simpleUndirected
        where = piece.bar_of(b.offset)
        label = f"{name(a)}-{name(b)} ({ivl.name}, bar {where})"
        if "A" in spec and simple_generic != 1:
            problems.append(label)
            bars.append(where)
        elif "d" in spec:
            if spec == "d" and simple_generic == 5 and i + 2 < len(mel):
                semis = b.midi - a.midi
                nxt = mel[i + 2].midi - b.midi
                if 1 <= abs(nxt) <= 2 and (nxt > 0) != (semis > 0):
                    continue  # d5 resolving inward is fine
                problems.append(label[:-1] + ", not resolved inward by step)")
            else:
                problems.append(label)
            bars.append(where)
    if not problems:
        return _result("augmented", True, 1.0, "no augmented or diminished melodic intervals (a d5 that resolves inward is allowed)")
    score = 1 - PENALTY * len(problems)
    more = f" (+{len(problems) - 3} more)" if len(problems) > 3 else ""
    return _result("augmented", False, score, "awkward interval(s): " + "; ".join(problems[:3]) + more, bars)


# ---------------------------------------------------------------- two voices


def _sounding(notes: list[Note], t: float) -> Note | None:
    for n in notes:
        if n.offset <= t + EPS and t < n.end - EPS:
            return n
    return None


def check_parallels(piece: Piece, req: dict) -> dict:
    bass = piece.bass
    if bass is None:
        return _result("parallels", True, 1.0, "single voice: not applicable")
    mel = piece.melody.notes
    onsets = sorted({round(n.offset, 6) for n in mel} | {round(n.offset, 6) for n in bass.notes})
    events: list[tuple[float, Note, Note]] = []
    for t in onsets:
        m, b = _sounding(mel, t), _sounding(bass.notes, t)
        if m and b:
            events.append((t, m, b))
    problems: list[str] = []
    bars: list[int] = []
    for (t0, m0, b0), (t1, m1, b1) in zip(events, events[1:]):
        if m0 is m1 or b0 is b1:
            continue  # oblique motion: one voice held
        if m0.midi == m1.midi or b0.midi == b1.midi:
            continue  # repeated note: also oblique
        i0, i1 = (m0.midi - b0.midi) % 12, (m1.midi - b1.midi) % 12
        if i0 == i1 and i0 in (0, 7):
            kind = "5ths" if i0 == 7 else "octaves"
            similar = (m1.midi > m0.midi) == (b1.midi > b0.midi)
            how = "parallel" if similar else "consecutive (contrary)"
            where = piece.bar_of(t1)
            problems.append(f"{how} {kind}: {name(b0)}/{name(m0)} -> {name(b1)}/{name(m1)} (bar {where})")
            bars.append(where)
    if not problems:
        return _result("parallels", True, 1.0, f"no parallel 5ths or octaves across {len(events)} melody/bass pairs")
    score = 1 - PENALTY * len(problems)
    more = f" (+{len(problems) - 3} more)" if len(problems) > 3 else ""
    return _result("parallels", False, score, "; ".join(problems[:3]) + more, bars)


CHECKS: dict[str, Callable[[Piece, dict], dict]] = {
    "bars": check_bars,
    "rhythm": check_rhythm,
    "range": check_range,
    "key": check_key,
    "cadence": check_cadence,
    "half-cadence": check_half_cadence,
    "leaps": check_leaps,
    "stepwise": check_stepwise,
    "augmented": check_augmented,
    "parallels": check_parallels,
}
