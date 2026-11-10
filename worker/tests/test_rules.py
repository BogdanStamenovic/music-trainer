"""Rule checks on small hand-made ABC tunes, one passing and one failing case per rule."""

from __future__ import annotations

import pytest

from mtworker.core import run
from mtworker.parse import ParseError, parse_key


def abc(body: str, k: str = "C", m: str = "4/4", length: str = "1/8") -> str:
    return f"X:1\nM:{m}\nL:{length}\nK:{k}\n{body}\n"


def two(mel: str, bass: str, k: str = "C", m: str = "4/4") -> str:
    return f"X:1\nM:{m}\nL:1/8\nK:{k}\nV:1\n{mel}\nV:2 clef=bass\n{bass}\n"


def check(text: str, rule: str, key: str = "C major", meter: str = "4/4", **extra) -> dict:
    res = run({"abc": text, "key": key, "meter": meter, "rules": [rule], **extra})
    assert res["ok"], res
    (c,) = res["checks"]
    assert c["id"] == rule
    assert 0.0 <= c["score"] <= 1.0
    return c


# A well-formed 8-bar C major tune: half cadence on G in bar 4, ends 2-1.
GOOD8 = "E2 D2 C2 D2 | E2 E2 E4 | D2 D2 E2 F2 | E2 D2 G4 | E2 D2 C2 D2 | E2 E2 E2 E2 | D2 D2 E2 D2 | C8 |]"
GOOD8_BASS = "C,8 | C,8 | G,,8 | G,,8 | C,8 | C,8 | G,,8 | C,8 |]"


# ---------------------------------------------------------------- whole request


def test_good_tune_scores_full():
    res = run({"abc": two(GOOD8, GOOD8_BASS), "key": "C major", "meter": "4/4", "bars": 8, "range": [55, 76],
               "rules": ["bars", "range", "key", "cadence", "half-cadence", "leaps", "stepwise", "augmented", "parallels", "rhythm"]})
    assert res["ok"]
    failing = [c for c in res["checks"] if not c["pass"]]
    assert not failing, failing
    assert res["score"] == 1.0
    assert res["parsed"] == {"voices": 2, "notes": 27, "bars": 8, "key_detected": "C major", "meter": "4/4"}


def test_weighted_score_and_unknown_rule():
    res = run({"abc": abc("C2 D2 E2 F2 | G8 |]"), "key": "C major", "meter": "4/4", "rules": ["cadence", "nope"]})
    cad, unk = res["checks"]
    assert unk == {"id": "nope", "pass": False, "score": 0, "weight": 1, "detail": "unknown rule", "bars": []}
    assert cad["score"] == 0.5 and cad["weight"] == 2
    assert res["score"] == pytest.approx((0.5 * 2 + 0) / 3, abs=1e-3)


def test_malformed_abc_is_ok_false():
    res = run({"abc": "this is ((( not { abc", "key": "C major", "meter": "4/4", "rules": ["bars"]})
    assert res["ok"] is False
    assert res["error"].startswith("could not parse ABC")


def test_empty_abc_is_ok_false():
    assert run({"abc": "  ", "rules": ["bars"]})["ok"] is False
    assert run({"abc": "X:1\nK:C\n", "rules": ["bars"]})["ok"] is False


def test_bad_key_is_ok_false():
    res = run({"abc": abc("C8|]"), "key": "H major", "meter": "4/4", "rules": ["key"]})
    assert res["ok"] is False and "key" in res["error"]


def test_missing_headers_are_filled_from_request():
    # No X:, M: or K: at all: meter and key come from the request.
    res = run({"abc": "L:1/4\nA B c B | A4 |]", "key": "A minor", "meter": "4/4", "bars": 2, "rules": ["bars", "cadence"]})
    assert res["ok"], res
    assert res["parsed"]["bars"] == 2
    assert res["checks"][1]["pass"]


@pytest.mark.parametrize(
    "text,tonic,mode",
    [("C major", "C", "major"), ("F# minor", "F#", "minor"), ("Bb major", "B-", "major"),
     ("E-flat minor", "E-", "minor"), ("Am", "A", "minor"), ("g minor", "G", "minor")],
)
def test_parse_key(text, tonic, mode):
    k = parse_key(text)
    assert (k.tonic.name, k.mode) == (tonic, mode)


def test_parse_key_rejects_garbage():
    with pytest.raises(ParseError):
        parse_key("C lydian dominant")


# ---------------------------------------------------------------- bars


def test_bars_pass():
    c = check(abc(GOOD8), "bars", bars=8)
    assert c["pass"] and c["score"] == 1.0


def test_bars_too_few():
    c = check(abc("C2 D2 E2 F2 | G8 | E2 D2 C2 D2 | E8 | D8 | C8 |]"), "bars", bars=8)
    assert not c["pass"]
    assert c["score"] == 0.75
    assert "6 complete bars" in c["detail"]


def test_bars_pickup_plus_short_last_bar_counts_as_one():
    # 3/4 with a one-beat pickup and a two-beat last bar: 4 bars.
    c = check(abc("G2 | c2 B2 A2 | G2 A2 B2 | c2 d2 e2 | c4 |]", m="3/4"), "bars", meter="3/4", bars=4)
    assert c["pass"], c
    assert "pickup" in c["detail"]


# ---------------------------------------------------------------- rhythm


def test_rhythm_pass_with_pickup():
    c = check(abc("G2 | c2 B2 A2 | G2 A2 B2 | c4 |]", m="3/4"), "rhythm", meter="3/4")
    assert c["pass"], c


def test_rhythm_overfull_bar():
    # Bar 2 has 9 eighths, bar 3 has 7.
    c = check(abc("C2 D2 E2 F2 | G2 A2 G2 F2 E | D2 C2 D2 E | C8 |]"), "rhythm")
    assert not c["pass"]
    assert c["bars"] == [2, 3]
    assert "bar 2 has 4.5 beats" in c["detail"]
    assert c["score"] == 0.5


def test_rhythm_short_last_bar_without_pickup():
    c = check(abc("C2 D2 E2 F2 | G2 A2 B2 c2 | c4 |]"), "rhythm")
    assert not c["pass"] and c["bars"] == [3]


def test_rhythm_no_bar_lines_uses_grid():
    c = check(abc("C2 D2 E2 F2 G2 A2 B2 c2 c8"), "rhythm")
    assert c["pass"], c
    assert "no bar lines" in c["detail"]


def test_rhythm_meter_mismatch_reported():
    c = check(abc("C2 D2 E2 | F2 G2 A2 |]", m="3/4"), "rhythm", meter="4/4")
    assert not c["pass"]
    assert "M:3/4" in c["detail"]


# ---------------------------------------------------------------- range


def test_range_pass():
    c = check(abc(GOOD8), "range", range=[55, 76])
    assert c["pass"], c
    assert "C4-G4" in c["detail"]


def test_range_span_too_wide():
    # C4 to G5 = 19 semitones (a 12th)
    c = check(abc("C2 E2 G2 c2 | e2 g2 c2 C2 |]"), "range")
    assert not c["pass"]
    assert "19 semitones" in c["detail"] and "12th" in c["detail"]
    assert 0 < c["score"] < 1


def test_range_outside_singable_range():
    # A3 (57) is below the requested G4 (67) floor.
    c = check(abc("A,2 C2 D2 E2 | G2 A2 G4 |]"), "range", range=[67, 79])
    assert not c["pass"]
    assert "outside G4-G5" in c["detail"]
    assert c["bars"] == [1]


# ---------------------------------------------------------------- key


def test_key_pass_minor_with_raised_6_and_7():
    # A melodic minor ascending (F# G#) and natural descending (G F).
    c = check(abc("A2 B2 c2 d2 | e2 ^f2 ^g2 a2 | a2 g2 f2 e2 | A8 |]", k="Am"), "key", key="A minor")
    assert c["pass"] and c["score"] == 1.0, c


def test_key_chromatic_notes_fail():
    c = check(abc("C2 ^C2 D2 ^D2 | E2 ^F2 G2 ^G2 | c8 |]"), "key")
    assert not c["pass"]
    assert c["score"] == pytest.approx(5 / 9, abs=1e-3)
    assert "C#4 (bar 1)" in c["detail"]


def test_key_detected_reported():
    res = run({"abc": abc("A2 B2 c2 d2 | e2 d2 c2 B2 | ^G2 B2 e2 ^G2 | A8 |]", k="Am"), "key": "A minor", "meter": "4/4", "rules": ["key"]})
    assert res["parsed"]["key_detected"] == "A minor"


# ---------------------------------------------------------------- cadence


def test_cadence_2_to_1():
    c = check(abc("E2 F2 G2 E2 | D4 C4 |]"), "cadence")
    assert c["pass"] and c["score"] == 1.0
    assert c["detail"] == "ends 2-1 on the tonic C (bar 2)"


def test_cadence_7_to_1_in_minor():
    c = check(abc("A2 c2 B2 A2 | ^G4 A4 |]", k="Am"), "cadence", key="A minor")
    assert c["pass"] and c["score"] == 1.0
    assert "7-1" in c["detail"]


def test_cadence_ends_on_leading_tone():
    c = check(abc("C2 D2 E2 D2 | C4 B,4 |]"), "cadence")
    assert not c["pass"] and c["score"] == 0.0
    assert "degree 7, leading tone" in c["detail"]


def test_cadence_ends_on_third_is_half_credit():
    c = check(abc("C2 D2 E2 F2 | D4 E4 |]"), "cadence")
    assert not c["pass"] and c["score"] == 0.5


def test_cadence_tonic_by_leap_is_partial():
    c = check(abc("C2 D2 E2 F2 | G4 C4 |]"), "cadence")
    assert c["pass"] and c["score"] == 0.8


def test_cadence_bass_v_i():
    c = check(two("E2 F2 G2 E2 | D4 C4 |]", "C,4 F,4 | G,,4 C,4 |]"), "cadence")
    assert c["score"] == 1.0 and "bass V-I" in c["detail"]


def test_cadence_bass_plagal_loses_credit():
    c = check(two("E2 F2 G2 E2 | D4 C4 |]", "C,4 E,4 | F,4 C,4 |]"), "cadence")
    assert c["score"] == 0.75
    assert "not V-I" in c["detail"]


def test_cadence_bass_not_on_tonic():
    c = check(two("E2 F2 G2 E2 | D4 C4 |]", "C,4 E,4 | G,4 A,4 |]"), "cadence")
    assert not c["pass"] and c["score"] == 0.5


# ---------------------------------------------------------------- half cadence


def test_half_cadence_pass():
    c = check(abc(GOOD8), "half-cadence", bars=8)
    assert c["pass"] and c["bars"] == [4]


def test_half_cadence_closed_on_tonic_fails():
    body = GOOD8.replace("E2 D2 G4 |", "E2 D2 C4 |", 1)
    c = check(abc(body), "half-cadence", bars=8)
    assert not c["pass"] and c["score"] == 0.0
    assert "bar 4 ends on the tonic" in c["detail"]


def test_half_cadence_not_applicable_under_8_bars():
    c = check(abc("C2 D2 E2 F2 | E2 D2 C4 |]"), "half-cadence", bars=2)
    assert c["pass"] and "only checked" in c["detail"]


# ---------------------------------------------------------------- leaps


def test_leaps_gap_fill_pass():
    # C4 up a 6th to A4, then step down to G4.
    c = check(abc("C2 A2 G2 F2 | E2 D2 C4 |]"), "leaps")
    assert c["pass"], c


def test_leaps_sixth_not_recovered():
    # C4 up a 6th to A4, then further up to B4.
    c = check(abc("C2 A2 B2 c2 | B2 A2 G4 |]"), "leaps")
    assert not c["pass"]
    assert c["score"] == 0.0
    assert "C4-A4 (6th up, bar 1) is not followed by a step back" in c["detail"]


def test_leaps_over_an_octave():
    # C4 to E5 = 16 semitones; also a 3rd elsewhere that is fine.
    c = check(abc("C2 e2 d2 B2 | c2 d2 c4 |]"), "leaps")
    assert not c["pass"]
    assert "more than an octave" in c["detail"]
    assert c["score"] == pytest.approx(0.5)


# ---------------------------------------------------------------- stepwise


def test_stepwise_pass():
    assert check(abc(GOOD8), "stepwise")["pass"]


def test_stepwise_arpeggio_fails_with_partial_credit():
    # C E G c G E C D: 7 moves, 1 step (C-D).
    c = check(abc("C2 E2 G2 c2 | G2 E2 C2 D2 |]"), "stepwise")
    assert not c["pass"]
    assert c["score"] == pytest.approx((1 / 7) / 0.5, abs=1e-3)
    assert "1/7" in c["detail"]


# ---------------------------------------------------------------- augmented / diminished


def test_augmented_second_in_harmonic_minor():
    # C harmonic minor: Ab4 -> B4 is an A2.
    c = check(abc("c2 _A2 =B2 c2 | G4 c4 |]", k="Cm"), "augmented", key="C minor")
    assert not c["pass"]
    assert "Ab4-B4 (A2, bar 1)" in c["detail"]


def test_augmented_second_detected_through_enharmonic_spelling():
    # Same sounds written G#4 -> B4 (a m3 as written); in C minor G# is Ab.
    c = check(abc("c2 ^G2 =B2 c2 | G4 c4 |]", k="Cm"), "augmented", key="C minor")
    assert not c["pass"]
    assert "Ab4-B4 (A2" in c["detail"]


def test_tritone_leap_fails():
    c = check(abc("F2 B2 c2 G2 | E4 C4 |]"), "augmented")
    assert not c["pass"] and "A4" in c["detail"]


def test_diminished_fifth_resolving_inward_is_fine():
    # B4 up to F5 then down a step to E5.
    c = check(abc("c2 B2 f2 e2 | d2 B2 c4 |]"), "augmented")
    assert c["pass"], c


def test_diminished_fifth_not_resolved_fails():
    # B4 up to F5 then up to G5.
    c = check(abc("c2 B2 f2 g2 | e2 d2 c4 |]"), "augmented")
    assert not c["pass"]
    assert "not resolved inward" in c["detail"]


def test_clean_major_melody_has_no_awkward_intervals():
    c = check(abc(GOOD8), "augmented")
    assert c["pass"] and c["score"] == 1.0


# ---------------------------------------------------------------- parallels


def test_parallels_single_voice():
    c = check(abc(GOOD8), "parallels")
    assert c == {"id": "parallels", "pass": True, "score": 1.0, "weight": 2,
                 "detail": "single voice: not applicable", "bars": []}


def test_parallel_fifths_detected():
    # G4/C3 -> A4/D3 -> B4/E3: two consecutive parallel 5ths (compound 12ths; octave-equivalent).
    c = check(two("G4 A4 | B4 c4 |]", "C,4 D,4 | E,4 C,4 |]"), "parallels")
    assert not c["pass"]
    assert "parallel 5ths: C3/G4 -> D3/A4 (bar 1)" in c["detail"]
    assert c["bars"] == [1, 2]
    assert c["score"] == pytest.approx(1 / 3, abs=1e-3)


def test_parallel_octaves_detected():
    c = check(two("c4 d4 | e4 c4 |]", "C,4 D,4 | C,4 E,4 |]"), "parallels")
    assert not c["pass"]
    assert "parallel octaves" in c["detail"]


def test_consecutive_fifths_by_contrary_motion_detected():
    # G4/C4 (5th) -> D5/G3 (12th = 5th): contrary motion, still consecutive 5ths.
    c = check(two("G4 d4 | c8 |]", "C4 G,4 | C8 |]"), "parallels")
    assert not c["pass"]
    assert "consecutive (contrary) 5ths" in c["detail"]


def test_contrary_and_oblique_motion_pass():
    c = check(two(GOOD8, GOOD8_BASS), "parallels")
    assert c["pass"], c
    c = check(two("e4 f4 | g4 c4 |]", "C4 A,4 | B,4 C4 |]"), "parallels")
    assert c["pass"], c


def test_unequal_fifths_are_not_parallels():
    # B3/F4 (d5) -> C4/G4 (P5): pitch-class 6 then 7, not flagged.
    c = check(two("F4 G4 | c8 |]", "B,4 C4 | C8 |]"), "parallels")
    assert c["pass"], c


def test_cadence_repeated_tonic_looks_past_the_repeat():
    # 6/8 with pickup, ends "e2 d c2 e | d3 d2": approach is E -> D (2-1).
    c = check(abc("A | d2 e f2 g | a3 f3 | e2 d c2 e | d3 d2 |]", k="D", m="6/8"), "cadence", key="D major", meter="6/8")
    assert c["score"] == 1.0 and "2-1" in c["detail"], c


def test_range_octave_wording():
    c = check(abc("A2 B2 c2 d2 | e2 f2 g2 a2 |]"), "range")
    assert "(an octave)" in c["detail"]


# ---------------------------------------------------------------- imperfect input


def test_header_voice_declarations_do_not_create_empty_voices():
    text = ('X:1\nT:t\n%%score 1 2\nM:3/4\nL:1/4\nV:1 name="Mel" clef=treble\nV:2 name="Bass" clef=bass\nK:F\n'
            "V:1\nF G A | B A G | F3 |]\nV:2\nF, C, F, | G, C, C, | F,3 |]\n")
    res = run({"abc": text, "key": "F major", "meter": "3/4", "rules": ["cadence", "rhythm"]})
    assert res["parsed"]["voices"] == 2
    assert res["parsed"]["key_detected"] == "F major"
    assert all(c["pass"] for c in res["checks"]), res["checks"]


def test_inline_voice_fields():
    text = "X:1\nM:4/4\nL:1/4\nK:D\n[V:1] d c B A | d4 |]\n[V:2] D, E, F, A,, | D,4 |]\n"
    res = run({"abc": text, "key": "D major", "meter": "4/4", "rules": ["rhythm"]})
    assert res["parsed"]["voices"] == 2
    assert res["checks"][0]["pass"] and "no bar lines" not in res["checks"][0]["detail"]


def test_ties_rests_chords_triplets():
    text = abc("z2 G2 A2 B2- | B2 (3ABc d4 | [GB]4 A2 F2 | G8", k="G")
    res = run({"abc": text, "key": "G major", "meter": "4/4", "bars": 4, "rules": ["bars", "rhythm", "cadence"]})
    assert res["parsed"]["notes"] == 11  # tied B merged, chord reduced to its top note
    assert all(c["pass"] for c in res["checks"]), res["checks"]


def test_more_than_two_voices_uses_first_and_last():
    text = "X:1\nM:4/4\nL:1/4\nK:C\nV:1\ne d e c|\nV:2\nG G G E|\nV:3\nC, G,, C, C,|\n"
    res = run({"abc": text, "key": "C major", "meter": "4/4", "rules": ["rhythm", "cadence"]})
    assert res["parsed"]["voices"] == 2
    assert "bass V-I" in res["checks"][1]["detail"]
    assert "no bar lines" not in res["checks"][0]["detail"]


def test_unreadable_note_is_reported_as_warning():
    res = run({"abc": abc("C2 D2 ^2 F2 | G8 |]"), "key": "C major", "meter": "4/4", "rules": ["key"]})
    assert res["ok"]
    assert any("read as C" in w for w in res.get("warnings", [])), res


def test_chord_symbols_are_not_melody_notes():
    """Lead sheets: "C"E2 ... must count only the melody (regression, PC-008)."""
    abc = 'X:1\nM:4/4\nL:1/4\nK:C\n"C"C D E C | "F"F A "G"G2 | "Am"A G E C | "G7"D2 "C"C2 |]'
    r = run({"abc": abc, "key": "C major", "meter": "4/4", "bars": 4, "rules": ["bars", "rhythm", "range", "leaps", "cadence"]})
    assert r["ok"], r
    assert r["parsed"]["notes"] == 13  # 4 + 3 + 4 + 2
    by = {c["id"]: c for c in r["checks"]}
    assert by["rhythm"]["pass"] and by["bars"]["pass"] and by["range"]["pass"], by
    assert by["cadence"]["score"] == 1.0


def test_short_bass_fails_bars():
    """A bass written for 1 of 4 bars is not a bass line (regression, C-007 review)."""
    abc = "X:1\nM:4/4\nL:1/4\nK:C\nV:1\nC D E F | G A B c | c B A G | E D C2 |]\nV:2 clef=bass\nC,4 |]"
    r = run({"abc": abc, "key": "C major", "meter": "4/4", "bars": 4, "rules": ["bars"]})
    assert r["ok"], r
    assert not r["checks"][0]["pass"]
    assert "bass covers only 1 of 4" in r["checks"][0]["detail"]


def test_half_cadence_16_bars_checks_4_and_12():
    """Double period: half cadences at 4 and 12; bar 8 may close on the tonic."""
    a = "C D E F | G A G E | F E D C | D4 |"   # bar 4 on D (2): half cadence
    b = "C D E F | G A G E | F E D B, | C4 |"  # bar 8 on C: full close
    abc = f"X:1\nM:4/4\nL:1/4\nK:C\n{a} {b} {a} {b}]"
    r = run({"abc": abc, "key": "C major", "meter": "4/4", "bars": 16, "rules": ["half-cadence"]})
    assert r["ok"], r
    assert r["checks"][0]["pass"], r["checks"][0]
