"""Export for other programs: a MIDI file (one track per line), a note list (CSV), the sound of every line and of the whole song (WAV),
packed in one zip. The notes come from the page as {bpm, lines:[{id, name, notes:[...]}]}; the WAV files are rendered by the engine."""
import csv
import io
import re
import zipfile

NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
PPQ = 480


def note_name(p):
    return NOTE_NAMES[int(p) % 12] + str(int(p) // 12 - 1)


def _vlq(n):
    n = max(0, int(n))
    out = [n & 0x7F]
    n >>= 7
    while n:
        out.append((n & 0x7F) | 0x80)
        n >>= 7
    return bytes(reversed(out))


def _meta(kind, data):
    return bytes([0xFF, kind]) + _vlq(len(data)) + data


def _track(events):
    """events: [(tick, order, bytes)] -> track chunk (order puts note-offs before note-ons at the same tick)"""
    body = b""
    last = 0
    for tick, _, data in sorted(events, key=lambda e: (e[0], e[1])):
        body += _vlq(tick - last) + data
        last = tick
    body += _vlq(0) + _meta(0x2F, b"")
    return b"MTrk" + len(body).to_bytes(4, "big") + body


def _vel(n):
    """velocity from the node's own volume (100% = 100)"""
    return max(1, min(127, int(round(100 * float(n["g"]))))) if n.get("g") is not None else 100


def _clean(notes):
    """playable notes: a start, a length, a MIDI pitch (a note that was cut away has no sound left)"""
    out = []
    for n in notes:
        t = float(n["t"]) + float(n.get("ts") or 0.0)
        end = float(n["t"]) + (float(n["te"]) if n.get("te") is not None else float(n["l"]))
        l = end - t
        if l < 0.01:
            continue
        out.append({**n, "start": max(0.0, t), "len": l})
    return out


def make_midi(bpm, lines):
    head = b"MThd" + (6).to_bytes(4, "big") + (1).to_bytes(2, "big") + (len(lines) + 1).to_bytes(2, "big") + PPQ.to_bytes(2, "big")
    tempo = int(round(60_000_000 / float(bpm)))
    ev0 = [(0, 0, _meta(0x03, "Vomix Studio".encode("utf-8"))),
           (0, 1, _meta(0x51, tempo.to_bytes(3, "big"))),
           (0, 2, _meta(0x58, bytes([4, 2, 24, 8])))]
    chunks = [_track(ev0)]
    chan_pool = [c for c in range(16) if c != 9]       # channel 10 is the drum channel
    for i, L in enumerate(lines):
        ch = chan_pool[i % len(chan_pool)]
        ev = [(0, 0, _meta(0x03, str(L.get("name") or "line %d" % (i + 1)).encode("utf-8")))]
        for n in _clean(L.get("notes") or []):
            p = max(0, min(127, int(round(float(n["p"])))))
            vel = _vel(n)
            a = int(round(n["start"] * PPQ))
            b = max(a + 1, int(round((n["start"] + n["len"]) * PPQ)))
            ev.append((a, 1, bytes([0x90 | ch, p, vel])))
            ev.append((b, 0, bytes([0x80 | ch, p, 0])))
        chunks.append(_track(ev))
    return head + b"".join(chunks)


def make_csv(bpm, lines):
    spb = 60.0 / float(bpm)
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["line", "start_beat", "length_beats", "start_sec", "length_sec", "midi_note", "note_name", "velocity", "sound",
                "cut_from_beat", "cut_to_beat"])
    rows = []
    for L in lines:
        for n in _clean(L.get("notes") or []):
            p = int(round(float(n["p"])))
            vel = _vel(n)
            rows.append((n["start"], [L.get("name"), round(n["start"], 4), round(n["len"], 4), round(n["start"] * spb, 4), round(n["len"] * spb, 4),
                                      p, note_name(p), vel, n.get("sound") or "", n.get("ts") if n.get("ts") is not None else "",
                                      n.get("te") if n.get("te") is not None else ""]))
    for _, r in sorted(rows, key=lambda x: x[0]):
        w.writerow(r)
    return ("﻿" + buf.getvalue()).encode("utf-8")        # BOM: spreadsheets read the Korean / Japanese names right


README = """Vomix Studio export / 내보내기 / エクスポート
=================================================

song.mid     MIDI file. Track 1 = tempo, then one track per line (the track name is the line name). Note velocity = the node's volume.
             MIDI 파일. 첫 트랙은 템포, 그 다음부터 라인마다 트랙 하나(트랙 이름 = 라인 이름). 벨로시티 = 노드의 소리 크기.
notes.csv    Every note: start / length (beats and seconds), MIDI pitch, the sound used, the part kept (cut_from/cut_to).
             모든 음의 목록: 시작·길이(박, 초), MIDI 음높이, 쓰는 소리, 남긴 구간(cut_from/cut_to).
lines/*.wav  The sound of each line alone (with its own volume / pan / effects).
             라인별 소리(그 라인의 볼륨, 팬, 효과 포함).
mix.wav      The whole song as in "WAV 내보내기".
             곡 전체(WAV 내보내기와 같음).

Time 0 of every file is the beginning of the song (beat 1). / 모든 파일의 0초는 곡의 시작(1박째)입니다.
MIDI does not carry which sound a note plays or how it was cut: see notes.csv. / MIDI에는 쓰는 소리와 자른 구간이 담기지 않으니 notes.csv를 보세요.
"""


def _safe(name, i):
    s = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", str(name or "")).strip(" .") or "line"
    return "%02d_%s" % (i + 1, s[:40])


def make_pack(meta, render, with_midi=True, with_csv=True, with_lines=True, with_mix=True):
    """meta: {bpm, lines:[{id, name, notes}]}; render(target) -> wav bytes"""
    bpm = float(meta["bpm"])
    lines = [L for L in meta["lines"] if L.get("notes")]
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("README.txt", README)
        if with_midi:
            z.writestr("song.mid", make_midi(bpm, lines))
        if with_csv:
            z.writestr("notes.csv", make_csv(bpm, lines))
        if with_lines:
            for i, L in enumerate(lines):
                z.writestr("lines/%s.wav" % _safe(L.get("name"), i), render(L["id"]))
        if with_mix:
            z.writestr("mix.wav", render("all"))
    return out.getvalue()
