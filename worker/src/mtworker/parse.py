"""ABC text -> a small, flat model of the piece that the rule checks work on.

music21 does the heavy lifting (durations, tuplets, ties, accidentals, key
signatures). Two things it does not give us reliably are handled here:

* Written bar lines. music21 re-bars an overfull bar at the meter boundary
  ("CDEF GABc d |" in 4/4 becomes a full bar plus a one-note bar), so the
  bars the learner actually wrote are recovered from music21's ABC tokenizer
  and mapped onto the parsed notes by position.
* Spelling. Notes are respelled into the requested key (G# in C minor becomes
  Ab) so interval qualities reflect the key, not whatever spelling the
  MIDI quantizer or the learner happened to pick. Chromatic notes keep their
  written spelling.
"""

from __future__ import annotations

import io
import re
import warnings
from contextlib import redirect_stderr, redirect_stdout
from dataclasses import dataclass, field
from fractions import Fraction

EPS = 1e-6


class ParseError(Exception):
    pass


@dataclass
class Note:
    offset: float
    dur: float
    pitch: object  # music21.pitch.Pitch, respelled into the key
    written: str  # name as music21 parsed it, before respelling

    @property
    def midi(self) -> int:
        return int(round(self.pitch.ps))

    @property
    def end(self) -> float:
        return self.offset + self.dur


@dataclass
class Voice:
    notes: list[Note]  # sounding notes only, ties merged, chords reduced
    end: float  # end of the last note or rest
    written_bars: list[tuple[float, float]] | None  # (start, content length) per written bar


@dataclass
class Piece:
    voices: list[Voice]
    key: object  # music21.key.Key requested by the project
    key_name: str
    bar_len: float
    meter: str  # requested meter
    abc_meter: str | None  # M: as written in the ABC, if any
    pickup: float
    degree_of_pc: dict[int, int] = field(default_factory=dict)
    spelling_of_pc: dict[int, str] = field(default_factory=dict)
    key_detected: str | None = None
    warnings: list[str] = field(default_factory=list)

    @property
    def melody(self) -> Voice:
        return self.voices[0]

    @property
    def bass(self) -> Voice | None:
        return self.voices[-1] if len(self.voices) > 1 else None

    def bar_of(self, offset: float) -> int:
        """1-based bar number on the meter grid; a pickup is bar 0."""
        if self.pickup > EPS and offset < self.pickup - EPS:
            return 0
        return int((offset - self.pickup + EPS) // self.bar_len) + 1

    def degree(self, note: Note) -> int | None:
        return self.degree_of_pc.get(note.midi % 12)


# ---------------------------------------------------------------- key / meter

_KEY_RE = re.compile(
    r"^\s*([A-Ga-g])\s*(#|♯|b|♭|-|sharp|flat|-sharp|-flat|\s+sharp|\s+flat)?\s*(major|minor|maj|min|m)?\s*$",
    re.IGNORECASE,
)


def parse_key(text: str):
    """'C major', 'F# minor', 'Bb major', 'E-flat minor', 'Am' -> music21 Key."""
    from music21 import key

    m = _KEY_RE.match(text or "")
    if not m:
        raise ParseError(f"unrecognised key {text!r} (expected e.g. 'C major', 'F# minor')")
    letter, acc, mode = m.groups()
    acc = (acc or "").strip().lower().lstrip("-")
    accidental = {"": "", "#": "#", "♯": "#", "sharp": "#", "b": "-", "♭": "-", "flat": "-"}[acc]
    mode = (mode or "major").lower()
    mode = "minor" if mode in ("minor", "min", "m") else "major"
    return key.Key(letter.upper() + accidental, mode)


def key_label(k) -> str:
    return f"{k.tonic.name.replace('-', 'b')} {k.mode}"


def abc_key_field(k) -> str:
    return k.tonic.name.replace("-", "b") + ("m" if k.mode == "minor" else "")


def parse_meter(text: str) -> float:
    m = re.fullmatch(r"\s*(\d+)\s*/\s*(\d+)\s*", text or "")
    if not m or int(m.group(1)) == 0 or int(m.group(2)) == 0:
        raise ParseError(f"unrecognised meter {text!r} (expected e.g. '4/4')")
    return float(Fraction(int(m.group(1)), int(m.group(2))) * 4)


def key_tables(k) -> tuple[dict[int, int], dict[int, str]]:
    """Pitch class -> scale degree, and pitch class -> spelling, for the key.

    Minor admits the raised 6th and 7th (melodic / harmonic minor) alongside
    the natural ones, so both Bb and B count as degree 7 in C minor.
    """
    from music21 import interval

    tonic = k.tonic
    degrees: dict[int, int] = {}
    spell: dict[int, str] = {}
    for deg, p in enumerate(k.getScale(k.mode).getPitches(tonic.name + "4", None)[:7], start=1):
        degrees[p.pitchClass] = deg
        spell[p.pitchClass] = p.name
    if k.mode == "minor":
        for deg, ivl in ((6, "M6"), (7, "M7")):
            p = interval.Interval(ivl).transposePitch(tonic)
            degrees.setdefault(p.pitchClass, deg)
            spell.setdefault(p.pitchClass, p.name)
    return degrees, spell


def respell(p, spell: dict[int, str]):
    """Return a copy of pitch p spelled as the key spells its pitch class."""
    from music21 import pitch

    name = spell.get(p.pitchClass)
    if name is None or name == p.name:
        return p
    q = pitch.Pitch(name)
    q.octave = p.octave
    # B#3 == C4 and Cb4 == B3: fix the octave so the sounding pitch is unchanged
    while q.ps < p.ps - 0.5:
        q.octave += 1
    while q.ps > p.ps + 0.5:
        q.octave -= 1
    return q


# ---------------------------------------------------------------- ABC text


_HEADER_RE = re.compile(r"^[A-Za-z]:")


def normalise_abc(abc: str, key_field: str, meter: str) -> tuple[str, str | None]:
    """Add the header fields music21 needs (X:, M:, K:) when they are missing.

    Returns the ABC text and the M: value the learner wrote (None if absent).
    """
    text = abc.replace("\r\n", "\n").replace("\r", "\n").strip("\n")
    # music21 does not understand inline voice fields ("[V:1] abc|"); split them onto their own line.
    text = re.sub(r"^\[V:\s*([^\]]*)\]\s*", lambda m: f"V:{m.group(1)}\n", text, flags=re.MULTILINE)
    lines = text.split("\n")
    hdr_end = 0
    while hdr_end < len(lines) and (_HEADER_RE.match(lines[hdr_end]) or not lines[hdr_end].strip() or lines[hdr_end].startswith("%")):
        if lines[hdr_end].startswith("K:"):
            hdr_end += 1
            break
        hdr_end += 1
    header, body = lines[:hdr_end], lines[hdr_end:]
    fields = {ln[0] for ln in header if _HEADER_RE.match(ln)}
    m_written = next((ln[2:].strip() for ln in header if ln.startswith("M:")), None)
    if "K" not in fields:
        # Voice headers (V:) may sit before K:, which must close the header.
        header = [ln for ln in header if ln.strip()]
        header.append(f"K:{key_field}")
    if "M" not in fields:
        header.insert(len(header) - 1, f"M:{meter}")
    if "X" not in fields:
        header.insert(0, "X:1")
    return "\n".join(header + body) + "\n", m_written


def _voice_bar_sizes(abc: str) -> list[tuple[list[int], bool]]:
    """Per voice with notes: number of (non-grace) notes/chords/rests in each written bar."""
    from music21 import abcFormat

    h = abcFormat.ABCHandler()
    h.process(abc)
    handlers = h.splitByVoice()
    out = []
    for vh in handlers:
        bars: list[int] = [0]
        grace = False
        has_notes = False
        had_bar = False
        for t in vh.tokens:
            name = type(t).__name__
            if name == "ABCGraceStart":
                grace = True
            elif name == "ABCGraceStop":
                grace = False
            elif name in ("ABCNote", "ABCChord") and not grace:
                bars[-1] += 1
                has_notes = True
            elif name == "ABCBar":
                had_bar = had_bar or has_notes
                if bars[-1]:
                    bars.append(0)
        if bars and bars[-1] == 0:
            bars.pop()
        if has_notes:
            out.append((bars, had_bar))
    if len(out) > 2:
        out = [out[0], out[-1]]
    return out


def parse(req_abc: str, key_text: str, meter_text: str) -> Piece:
    from music21 import converter, chord as m21chord

    k = parse_key(key_text)
    bar_len = parse_meter(meter_text)
    abc, m_written = normalise_abc(req_abc or "", abc_key_field(k), meter_text.strip())
    degrees, spell = key_tables(k)

    sink = io.StringIO()
    try:
        with warnings.catch_warnings(), redirect_stdout(sink), redirect_stderr(sink):
            warnings.simplefilter("ignore")
            score = converter.parse(abc, format="abc", forceSource=True)
    except Exception as e:  # music21 raises a zoo of exception types on bad ABC
        raise ParseError(f"could not parse ABC: {type(e).__name__}: {e}") from None

    parts = list(getattr(score, "parts", [])) or [score]
    # V: lines in the header create note-less parts; drop them.
    parts = [p for p in parts if any(not e.duration.isGrace for e in p.flatten().notes)]
    if len(parts) > 2:
        parts = [parts[0], parts[-1]]
    try:
        with warnings.catch_warnings(), redirect_stdout(sink), redirect_stderr(sink):
            warnings.simplefilter("ignore")
            bar_sizes = _voice_bar_sizes(abc)
    except Exception:
        bar_sizes = []

    voices: list[Voice] = []
    for vi, part in enumerate(parts):
        raw = [e for e in part.flatten().notesAndRests if not e.duration.isGrace]
        offs = [float(e.getOffsetInHierarchy(part)) for e in raw]
        end = max(o + float(e.quarterLength) for o, e in zip(offs, raw))

        # Written bar lines: map token counts onto the parsed elements.
        written = None
        sizes, had_bar = bar_sizes[vi] if len(bar_sizes) == len(parts) else ([], False)
        if had_bar and sum(sizes) == len(raw):
            written, i = [], 0
            for n in sizes:
                chunk = raw[i : i + n]
                written.append((offs[i], sum(float(e.quarterLength) for e in chunk)))
                i += n

        # Merge ties, reduce chords: top note for the melody, bottom for the bass.
        stripped = part.stripTies()
        is_bass = vi > 0 and vi == len(parts) - 1
        notes = []
        for e in stripped.flatten().notes:
            if e.duration.isGrace:
                continue
            if isinstance(e, m21chord.Chord):
                ps = sorted(e.pitches, key=lambda p: p.ps)
                p = ps[0] if is_bass else ps[-1]
            else:
                p = e.pitch
            notes.append(
                Note(
                    offset=float(e.getOffsetInHierarchy(stripped)),
                    dur=float(e.quarterLength),
                    pitch=respell(p, spell),
                    written=p.nameWithOctave,
                )
            )
        notes.sort(key=lambda n: n.offset)
        voices.append(Voice(notes=notes, end=end, written_bars=written))

    if not voices:
        raise ParseError("could not parse ABC: no notes found")

    mel = voices[0]
    pickup = 0.0
    if mel.written_bars and len(mel.written_bars) > 1 and mel.written_bars[0][1] < bar_len - EPS:
        pickup = mel.written_bars[0][1]

    piece = Piece(
        voices=voices,
        key=k,
        key_name=key_label(k),
        bar_len=bar_len,
        meter=meter_text.strip(),
        abc_meter=m_written,
        pickup=pickup,
        degree_of_pc=degrees,
        spelling_of_pc=spell,
    )
    try:
        with warnings.catch_warnings(), redirect_stdout(sink), redirect_stderr(sink):
            warnings.simplefilter("ignore")
            piece.key_detected = key_label(score.analyze("key"))
    except Exception:
        piece.key_detected = None
    # music21 guesses C for note tokens it cannot read; surface that instead of hiding it.
    seen = set()
    for ln in sink.getvalue().splitlines():
        m = re.search(r"Could not get pitch information from note:\s*(.*?), assuming C", ln)
        if m and m.group(1) not in seen:
            seen.add(m.group(1))
            piece.warnings.append(f"unreadable note {m.group(1)!r} read as C")
    return piece
