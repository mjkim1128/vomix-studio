"""Audio engine for Vomix Studio: sample analysis, rendering, reference analysis."""
import hashlib
import io
import json
import sys
import threading
import time
import traceback
from pathlib import Path

import librosa
import numpy as np
import pyworld as pw
import soundfile as sf

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import otomad  # noqa: E402  (extract_notes, mono_from_events)

SR = 44100
import os  # noqa: E402

DATA = Path(os.environ.get("OTOMAD_DATA") or (Path(__file__).resolve().parent / "data"))
for sub in ("samples", "refs"):
    (DATA / sub).mkdir(parents=True, exist_ok=True)


# ------------------------------------------------------------------ samples
def estimate_root(y):
    """Median pitch (MIDI float) of a clip, or None if it is not tonal."""
    if len(y) < 1024:
        return None
    y = y[: SR * 3].astype(np.float64)
    f0, _ = pw.harvest(y, SR, f0_floor=60.0, f0_ceil=1000.0, frame_period=10.0)
    v = f0[f0 > 0]
    if len(v) < max(4, 0.3 * len(f0)):
        return None
    return float(np.median(librosa.hz_to_midi(v)))


def analyze_sample(path):
    y, _ = librosa.load(path, sr=SR, mono=True)
    dur = len(y) / SR
    iv = librosa.effects.split(y, top_db=30, frame_length=2048, hop_length=512)
    segs = []
    for a, b in iv:
        s, e = a / SR, b / SR
        # keep splits even when the gap is a single frame: repeated hits of the same sound
        # are separated by tiny dips and must stay separate clips
        if e - s >= 0.1:
            segs.append({"start": s, "end": e})
    if not segs:
        segs = [{"start": 0.0, "end": dur}]
    segs = segs[:40]
    for sg in segs:
        sg["root"] = estimate_root(y[int(sg["start"] * SR): int(sg["end"] * SR)])
        sg["start"], sg["end"] = round(sg["start"], 3), round(sg["end"], 3)
    # default choice: first tonal segment of a sensible length, else the first one
    default = 0
    for i, sg in enumerate(segs):
        if sg["root"] is not None and 0.12 <= sg["end"] - sg["start"] <= 1.5:
            default = i
            break
    n = 400
    step = max(1, len(y) // n)
    peaks = [float(np.abs(y[i:i + step]).max()) for i in range(0, len(y), step)][:n]
    return {"duration": round(dur, 3), "segments": segs, "default": default, "peaks": peaks}


UNPITCHED_ROOT = 57   # nominal pitch of a sound without a measurable pitch (same default as the screen)


class Voice:
    """One clip that can be re-pitched and length-fitted. Tonal clips use WORLD
    (formant-preserving); non-tonal clips are only time-stretched."""

    def __init__(self, y):
        self.raw = np.asarray(y, dtype=np.float32).copy()      # the cut exactly as chosen, kept for playing it as recorded
        y, _ix = librosa.effects.trim(y, top_db=35)
        self.trim0 = float(_ix[0]) / SR          # where the trimmed clip starts inside the cut (seconds)
        if len(y) < 256:       # a very short cut (or one that is almost silent): keep the cut itself instead of refusing it
            if len(self.raw) < 16:
                raise ValueError("clip is too short")
            y = np.pad(self.raw, (0, max(0, 512 - len(self.raw))))
            self.trim0 = 0.0
        self.y = y.astype(np.float64)
        self.cache = {}
        f0, t = pw.harvest(self.y, SR, f0_floor=60.0, f0_ceil=1000.0, frame_period=5.0)
        v = f0[f0 > 0]
        # a sound counts as pitched when a good part of it carries a pitch AND the pitch holds for at least a few frames in a row
        # (a short word like a burst of consonant + vowel may be only 15-30 % voiced, and must still follow the melody)
        run = best = 0
        for x in f0 > 0:
            run = run + 1 if x else 0
            best = max(best, run)
        self.pitched = len(v) >= max(6, 0.12 * len(f0)) and best >= 5
        self.root = float(np.median(librosa.hz_to_midi(v))) if self.pitched else None
        if self.pitched:
            self.f0 = f0
            self.sp = pw.cheaptrick(self.y, f0, t, SR)
            self.ap = pw.d4c(self.y, f0, t, SR)
            self._prepare()

    def _prepare(self):
        """Find the steady vowel part ("hold" region) that gets sustained when a note is longer than the clip."""
        from scipy.ndimage import binary_closing
        n = len(self.f0)
        voiced = binary_closing(self.f0 > 0, structure=np.ones(5, dtype=bool))   # bridge short voicing dropouts
        self.voiced = voiced
        e = np.log(self.sp.mean(axis=1) + 1e-12)
        ok = voiced & (e >= e[voiced].max() - 1.0)          # within ~4 dB of the loudest voiced frame
        best, cur = (0, 0), None
        for i in range(n + 1):
            if i < n and ok[i]:
                cur = (i, i) if cur is None else (cur[0], i)
            else:
                if cur is not None and cur[1] - cur[0] > best[1] - best[0]:
                    best = cur
                cur = None
        a, b = best
        if b - a < 3:   # too short to average: use a few frames around the loudest voiced one
            c = int(np.argmax(np.where(voiced, e, -1e9)))
            a, b = max(0, c - 2), min(n - 1, c + 2)
        self.hold = (a, b)
        self.hold_sp = np.exp(np.mean(np.log(self.sp[a:b + 1] + 1e-12), axis=0))
        self.hold_ap = np.mean(self.ap[a:b + 1], axis=0)

    def _frames(self, midi, n_out, hold):
        """WORLD frames (f0, spectral envelope, aperiodicity) for a note of n_out frames of 5 ms."""
        n, F = len(self.f0), self.sp.shape[1]
        hz = float(librosa.midi_to_hz(midi))
        if not hold or n_out <= n + 2:
            # shorter than (or about as long as) the clip: play it faster / as is
            src = np.linspace(0, n - 1, n_out)
            idx = np.arange(n)
            vm = (self.voiced if hold else self.f0 > 0)[np.round(src).astype(int)]
            sp = np.stack([np.interp(src, idx, self.sp[:, k]) for k in range(F)], axis=1)
            ap = np.stack([np.interp(src, idx, self.ap[:, k]) for k in range(self.ap.shape[1])], axis=1)
        else:
            # longer: attack and tail at their natural speed, the steady vowel is held in between
            a, b = self.hold
            rel = n - 1 - b
            mid = n_out - a - rel
            sp = np.empty((n_out, F))
            ap = np.empty((n_out, self.ap.shape[1]))
            vm = np.zeros(n_out, dtype=bool)
            sp[:a], ap[:a], vm[:a] = self.sp[:a], self.ap[:a], self.voiced[:a]
            sp[a:a + mid], ap[a:a + mid], vm[a:a + mid] = self.hold_sp, self.hold_ap, True
            if rel:
                sp[a + mid:], ap[a + mid:], vm[a + mid:] = self.sp[b + 1:], self.ap[b + 1:], self.voiced[b + 1:]
        return np.where(vm, hz, 0.0), np.ascontiguousarray(sp), np.ascontiguousarray(ap)

    def note(self, midi, dur, hold=True):
        key = (int(midi), round(dur, 3), hold)
        if key in self.cache:
            return self.cache[key]
        if self.pitched:
            n_out = max(2, int(dur * 1000 / 5.0))
            f0, sp, ap = self._frames(midi, n_out, hold)
            out = pw.synthesize(f0, sp, ap, SR, 5.0)
        else:
            # no pitch to follow: change the pitch by playing the sound faster / slower (relative to the nominal root, A3 = 57,
            # which is also what the screen shows as "semitones moved"), then fit the length
            y = self.y.astype(np.float32)
            shift = (int(midi) - UNPITCHED_ROOT) / 12.0
            if abs(shift) > 1e-6:
                y = librosa.resample(y, orig_sr=SR * 2.0 ** shift, target_sr=SR)
            rate = float(np.clip((len(y) / SR) / dur, 0.1, 10.0))
            out = librosa.effects.time_stretch(y, rate=rate)
        out = out.astype(np.float32)
        want = int(dur * SR)
        out = out[:want] if len(out) >= want else np.pad(out, (0, want - len(out)))
        self.cache[key] = out
        return out

    def source_map(self, midi, dur, hold=True):
        """Where in the CUT (seconds from its start) the sound heard at each moment of a note comes from, as ([note seconds], [cut seconds]).
        A pitched note that is longer than the clip keeps the start and the end of the clip as recorded and holds the steady vowel in
        between, so heard time and cut time are NOT proportional."""
        if self.pitched:
            n = len(self.f0)
            n_out = max(2, int(dur * 1000 / 5.0))
            if not hold or n_out <= n + 2:
                src = np.linspace(0, n - 1, n_out)
            else:
                a, b = self.hold
                rel = n - 1 - b
                mid = n_out - a - rel
                src = np.concatenate([np.arange(a), np.full(mid, (a + b) / 2.0), np.arange(b + 1, n)])[:n_out]
                if len(src) < n_out:
                    src = np.pad(src, (0, n_out - len(src)), mode="edge")
            out_t = np.arange(len(src)) * 0.005
            return out_t, self.trim0 + src * 0.005
        nat = len(self.y) / SR
        return np.array([0.0, dur]), np.array([self.trim0, self.trim0 + nat])

    def shifted(self, midi):
        """The clip at its OWN length with only the pitch moved (no stretching): the whole pitch movement of the clip is kept and
        shifted as one, the voice colour stays. For a clip without a pitch the sound is played faster / slower and put back to its length."""
        key = ("keep", int(midi))
        if key in self.cache:
            return self.cache[key]
        if self.pitched:
            ratio = 2.0 ** ((int(midi) - int(round(self.root))) / 12.0)
            out = pw.synthesize(np.ascontiguousarray(self.f0 * ratio), self.sp, self.ap, SR, 5.0)
        else:
            y = self.y.astype(np.float32)
            shift = (int(midi) - UNPITCHED_ROOT) / 12.0
            out = y
            if abs(shift) > 1e-6:
                out = librosa.resample(y, orig_sr=SR * 2.0 ** shift, target_sr=SR)
                out = librosa.effects.time_stretch(out, rate=float(np.clip(len(out) / max(1, len(y)), 0.1, 10.0)))
        out = out.astype(np.float32)
        self.cache[key] = out
        return out


_audio = {}
_voices = {}


def _load(file):
    if file not in _audio:
        _audio[file], _ = librosa.load(str(DATA / "samples" / file), sr=SR, mono=True)
    return _audio[file]


_stems = {}


def _load_stem(rid, stem):
    key = (rid, stem)
    if key not in _stems:
        if len(_stems) >= 4:
            _stems.pop(next(iter(_stems)))
        _stems[key], _ = librosa.load(str(DATA / "refs" / rid / "stems" / (stem + ".wav")), sr=SR, mono=True)
    return _stems[key]


def _trim_events(events, i0, nd, k, spb):
    """A note may keep only a part of the sound it makes ("ts" .. "te" = beats from the note's start): what comes out of the node is
    cut, what stays keeps its place in time (the part before "ts" is silent)."""
    if k.get("ts") is None and k.get("te") is None:
        return
    base = int((float(nd["s"]) + float(k["s"])) * spb * SR)
    lo = base + int(float(k.get("ts") or 0.0) * spb * SR)
    hi = base + int(float(k["te"]) * spb * SR) if k.get("te") is not None else None
    for i in range(i0, len(events)):
        st, a = events[i]
        a0 = max(st, lo)
        a1 = st + len(a) if hi is None else min(st + len(a), hi)
        if a1 - a0 < 8:
            events[i] = (st, np.zeros(0, dtype=np.float32))
            continue
        seg = a[a0 - st: a1 - st].copy()
        if a0 > st:                                   # a new beginning: a short fade in so it does not click
            f = min(int(0.004 * SR), len(seg) // 2)
            if f:
                seg[:f] *= np.linspace(0, 1, f)
        if hi is not None and a1 < st + len(a):       # a new ending: a short fade out
            f = min(int(0.02 * SR), len(seg) // 2)
            if f:
                seg[-f:] *= np.linspace(1, 0, f)
        events[i] = (a0, seg.astype(np.float32))


def ref_span(spec, a, b, spb, ext=0.0):
    """The original sound of a reference lane over [a, b) beats of the song: the stem is cut out in ONE piece (as recorded, same
    pitch) and only squeezed or stretched to the length the span has in my song. ext = seconds of the sound that go on after b."""
    y = _load_stem(spec["ref"], spec["stem"])
    f = 60.0 / float(spec["bpm"])
    base = float(spec["off"]) + float(spec.get("at") or 0.0) * f
    nat = (b - a) * f
    dur = max(0.05, (b - a) * spb)
    scale = nat / dur
    t0 = base + a * f
    seg = y[max(0, int(t0 * SR)): max(0, int((t0 + nat + ext * scale) * SR))].astype(np.float32)
    if len(seg) < 256:
        return None
    if abs(scale - 1.0) > 0.002:
        seg = librosa.effects.time_stretch(seg, rate=float(np.clip(scale, 0.1, 10.0)))
    want = int((dur + ext) * SR)
    return seg[:want] if len(seg) >= want else np.pad(seg, (0, want - len(seg)))


def keep_track(v, notes, spb):
    """"Keep speed": the clip runs at its own speed from the start of the node (and starts again each time it has ended) while its pitch
    follows the notes of the node at every moment: a 5-beat clip is spread over 5 beats of the melody, whatever notes those are.
    Silence where the node has no note. Returns the audio of the whole node."""
    end = max(float(k["s"]) + float(k["l"]) for k in notes) * spb
    total = int(end * SR)
    if total <= 0:
        return None
    ok_s = np.zeros(total, dtype=np.float32)
    if v.pitched:
        nf = int(end * 200.0) + 2
        pm = np.full(nf, np.nan)
        for k in notes:
            pm[int(round(float(k["s"]) * spb * 200.0)): int(round((float(k["s"]) + float(k["l"])) * spb * 200.0))] = int(k["p"])
        ok = ~np.isnan(pm)
        idx = np.arange(nf) % len(v.f0)
        hz = librosa.midi_to_hz(np.nan_to_num(pm, nan=60.0))
        f0 = np.where((v.f0[idx] > 0) & ok, hz, 0.0)
        y = pw.synthesize(np.ascontiguousarray(f0), np.ascontiguousarray(v.sp[idx]), np.ascontiguousarray(v.ap[idx]), SR, 5.0).astype(np.float32)
        out = y[:total] if len(y) >= total else np.pad(y, (0, total - len(y)))
        ok_s = ok[np.minimum((np.arange(total) / SR * 200.0).astype(int), nf - 1)].astype(np.float32)
    else:
        out = np.zeros(total, dtype=np.float32)
        for k in notes:
            a = int(float(k["s"]) * spb * SR)
            b = min(total, int((float(k["s"]) + float(k["l"])) * spb * SR))
            if b <= a:
                continue
            sh = v.shifted(int(k["p"]))
            out[a:b] = sh[np.arange(a, b) % len(sh)]
            ok_s[a:b] = 1.0
    w = max(1, int(0.008 * SR))
    gate = np.convolve(ok_s, np.ones(w, dtype=np.float32) / w, mode="same")
    return (out * gate).astype(np.float32)


def get_voice(spec):
    key = (spec["file"], round(float(spec["start"]), 3), round(float(spec["end"]), 3))
    if key not in _voices:
        y = _load(spec["file"])
        _voices[key] = Voice(y[int(key[1] * SR): int(key[2] * SR)])
    return _voices[key]


def note_map(spec, p, length_beats, fit, bpm):
    """[[heard seconds, cut seconds], ...] for one note of a cut: which part of the cut is heard when. Used to turn a part chosen on the
    sound that comes out of the node back into a part of the cut."""
    spb = 60.0 / float(bpm)
    v = get_voice(spec)
    dur = max(0.05, float(length_beats) * spb)
    rnat = len(v.raw) / SR
    same_pitch = int(p) == (int(round(v.root)) if v.pitched else UNPITCHED_ROOT)
    if spec.get("bend"):
        ts_, ss_ = np.array([0.0, dur]), np.array([0.0, rnat])
    elif fit == "keep":
        n0 = 0.0 if same_pitch else v.trim0
        ts_, ss_ = np.array([0.0, rnat]), np.array([n0, n0 + rnat])
    elif same_pitch and 0.9 * rnat <= dur <= rnat + spb:
        ts_, ss_ = np.array([0.0, rnat]), np.array([0.0, rnat])
    else:
        nat = len(v.y) / SR
        n_rep = max(1, int(round(dur / nat))) if fit == "repeat" and dur >= 1.5 * nat else 1
        sub = dur / n_rep
        t1, s1 = v.source_map(int(p), sub)
        ts_ = np.concatenate([t1 + r * sub for r in range(n_rep)])
        ss_ = np.concatenate([s1 for _ in range(n_rep)])
    step = max(1, len(ts_) // 400)
    pts = [[round(float(a), 4), round(float(min(b, rnat)), 4)] for a, b in zip(ts_[::step], ss_[::step])]
    return pts


# ---------------------------------------------------------------- pitch curve of a whole cut (drawn and edited in the UI)
FR = 0.005                    # WORLD frame period, seconds
_analysis = {}


def get_analysis(spec):
    """WORLD analysis (f0, spectral envelope, aperiodicity) of the whole cut, exactly as chosen (no silence trimming)."""
    key = (spec["file"], round(float(spec["start"]), 3), round(float(spec["end"]), 3))
    if key not in _analysis:
        if len(_analysis) >= 6:
            _analysis.pop(next(iter(_analysis)))
        y = _load(spec["file"])[int(key[1] * SR): int(key[2] * SR)].astype(np.float64)
        if len(y) < 512:
            raise ValueError("구간이 너무 짧아요")
        f0, t = pw.harvest(y, SR, f0_floor=60.0, f0_ceil=1000.0, frame_period=FR * 1000)
        _analysis[key] = {"y": y.astype(np.float32), "f0": f0, "sp": pw.cheaptrick(y, f0, t, SR), "ap": pw.d4c(y, f0, t, SR)}
    return _analysis[key]


def contour(spec, points=320):
    """Pitch curve of the cut for the editor: [{midi|None}] on an even grid, plus loudness and the median pitch."""
    from scipy.signal import medfilt
    an = get_analysis(spec)
    f0 = an["f0"]
    n = len(f0)
    voiced = f0 > 0
    midi = np.zeros(n)
    midi[voiced] = librosa.hz_to_midi(f0[voiced])
    midi = np.where(voiced, medfilt(midi, 5), 0.0)
    root = float(np.median(midi[voiced])) if voiced.any() else None
    m = min(points, n)
    idx = np.linspace(0, n - 1, m).round().astype(int)
    y = an["y"]
    hop = max(1, len(y) // m)
    env = [float(np.sqrt(np.mean(y[i * hop:(i + 1) * hop] ** 2) + 1e-12)) for i in range(m)]
    mx = max(env) or 1.0
    return {"dur": len(y) / SR, "root": root, "midi": [round(float(midi[i]), 3) if voiced[i] else None for i in idx],
            "env": [round(e / mx, 3) for e in env]}


def _bend_offsets(bend, times):
    """Semitones to add at each time (seconds from the start of the cut): the sum of the bumps the user pulled."""
    off = np.zeros(len(times))
    for a in bend or []:
        s = max(1e-3, float(a.get("s") or 0.05))
        off += float(a.get("a") or 0.0) * np.exp(-0.5 * ((times - float(a["t"])) / s) ** 2)
    return off


def _smooth01(x):
    x = np.clip(x, 0.0, 1.0)
    return x * x * (3 - 2 * x)


def bend_note(spec, k, dur, p_delta):
    """One note of a cut whose pitch curve was edited. The original pitch movement is kept and the pulled amount is added;
    where nothing was pulled the recording itself is used, so only the changed parts are re-synthesized."""
    an = get_analysis(spec)
    cs = float(k.get("cs") or 0.0)
    ce = float(k["ce"]) if k.get("ce") is not None else len(an["y"]) / SR
    a, b = max(0, int(round(cs / FR))), min(len(an["f0"]), int(round(ce / FR)))
    n = b - a
    if n < 4 or not (an["f0"][a:b] > 0).any():
        return None
    f0, sp, ap = an["f0"][a:b], an["sp"][a:b], an["ap"][a:b]
    off = _bend_offsets(spec.get("bend"), (np.arange(n) + a) * FR) + p_delta
    n_out = max(2, int(round(dur / FR)))
    voiced = f0 > 0
    if abs(n_out - n) <= 2:
        n_out = n
        f_o, sp_o, ap_o, off_o, vo = f0, sp, ap, off, voiced
    else:                                   # the note was made longer or shorter than the recording: the frames are stretched evenly
        from scipy.interpolate import interp1d
        src = np.linspace(0, n - 1, n_out)
        idx = np.arange(n)
        vi = np.where(voiced)[0]
        f_o = np.interp(src, vi, f0[vi])
        vo = voiced[np.round(src).astype(int)]
        off_o = np.interp(src, idx, off)
        sp_o = interp1d(idx, sp, axis=0)(src)
        ap_o = interp1d(idx, ap, axis=0)(src)
    f_new = np.where(vo, np.clip(f_o * 2.0 ** (off_o / 12.0), 40.0, 3000.0), 0.0)
    syn = pw.synthesize(np.ascontiguousarray(f_new), np.ascontiguousarray(sp_o), np.ascontiguousarray(ap_o), SR, FR * 1000).astype(np.float32)
    want = int(dur * SR)
    syn = syn[:want] if len(syn) >= want else np.pad(syn, (0, want - len(syn)))
    if n_out == n:                          # same length: keep the recording wherever the pitch was not moved
        raw = an["y"][int(cs * SR): int(cs * SR) + want]
        raw = np.pad(raw, (0, want - len(raw)))
        m = np.where(vo, _smooth01(np.abs(off_o) / 0.35), 0.0)
        mt = np.interp(np.arange(want) / SR / FR, np.arange(len(m)), m)
        return raw * (1 - mt) + syn * mt
    return syn


def split_by_pitch(spec, step=0.8, min_len=0.07):
    """Cut a clip into pieces wherever its pitch moves by more than ~`step` semitones or the voice drops out.
    Returns [{a, b, root}] in absolute seconds; the pieces cover the whole clip. root is None for pieces without a pitch."""
    from scipy.signal import medfilt
    a0, b0 = float(spec["start"]), float(spec["end"])
    y = _load(spec["file"])[int(a0 * SR): int(b0 * SR)].astype(np.float64)
    whole = [{"a": a0, "b": b0, "root": None}]
    if len(y) < int(0.15 * SR):
        return whole
    f0, t = pw.harvest(y, SR, f0_floor=60.0, f0_ceil=1000.0, frame_period=5.0)
    n = len(f0)
    voiced = f0 > 0
    if voiced.sum() < 8:
        return whole
    midi = np.zeros(n)
    midi[voiced] = librosa.hz_to_midi(f0[voiced])
    midi = np.where(voiced, medfilt(midi, 5), 0.0)
    segs, cur, last_v = [], None, -1
    for i in range(n):
        if not voiced[i]:
            continue
        if cur is not None:
            gap = i - last_v - 1
            run = np.median(midi[cur[0]: last_v + 1][-8:])
            if gap >= 8 or abs(midi[i] - run) > step:
                # a real change must hold for a few frames (not a glitch), otherwise it stays in the same piece
                ahead = midi[i: i + 4]
                if gap >= 8 or (np.all(ahead > 0) and np.all(np.abs(ahead - run) > step)):
                    segs.append(cur); cur = None
        if cur is None:
            cur = [i, i]
        cur[1] = i
        last_v = i
    if cur is not None:
        segs.append(cur)
    segs = [s for s in segs if (s[1] - s[0] + 1) * 0.005 >= min_len] or segs
    if len(segs) < 2:
        return whole
    out = []
    for k, (s, e) in enumerate(segs):
        lo = 0.0 if k == 0 else (segs[k - 1][1] + s) / 2 * 0.005       # boundary halfway through the gap between two pieces
        hi = len(y) / SR if k == len(segs) - 1 else (e + segs[k + 1][0]) / 2 * 0.005
        root = float(np.median(midi[s: e + 1][midi[s: e + 1] > 0]))
        out.append({"a": round(a0 + lo, 4), "b": round(a0 + hi, 4), "root": root})
    return out


def segment_syllables(y, sr=SR, min_len=0.06, floor_db=-38.0):
    """Cut a stretch of speech / rap / singing into syllable-like pieces by the way the loudness and the spectrum move (not by pitch,
    so it works for spoken words too). Returns [(a, b)] in seconds from the start of y: a = where the piece starts (its onset),
    b = where it ends (the next onset, or where the sound dies away)."""
    y = np.asarray(y, dtype=np.float32)
    if len(y) < int(0.08 * sr):
        return [(0.0, len(y) / sr)] if len(y) else []
    hop = int(0.01 * sr)
    rms = librosa.feature.rms(y=y, frame_length=1024, hop_length=hop)[0]
    if rms.max() <= 1e-6:
        return []
    edb = 20.0 * np.log10(rms / rms.max() + 1e-9)
    act = edb > floor_db
    mel = librosa.power_to_db(librosa.feature.melspectrogram(y=y, sr=sr, n_fft=1024, hop_length=hop, n_mels=40, fmin=80, fmax=7000), ref=np.max)
    n = min(len(act), mel.shape[1])
    act = act[:n]
    flux = librosa.onset.onset_strength(S=mel[:, :n], sr=sr, hop_length=hop, aggregate=np.mean)
    det = librosa.onset.onset_detect(onset_envelope=flux, sr=sr, hop_length=hop, backtrack=True, pre_max=3, post_max=3, pre_avg=12, post_avg=12, delta=0.2, wait=5)
    # onsets: every start of a sounding stretch, and the detected onsets inside one
    starts = [i for i in range(n) if act[i] and (i == 0 or not act[i - 1])]
    cand = sorted(set(starts) | {int(i) for i in det if i < n and act[min(n - 1, i + 2)]})
    need = max(2, int(min_len / 0.01))
    kept = []
    for i in cand:
        if kept and i - kept[-1] < need and i not in starts:
            continue
        kept.append(i)
    segs = []
    for j, i in enumerate(kept):
        nxt = kept[j + 1] if j + 1 < len(kept) else n
        end = i
        while end < nxt and act[end]:
            end += 1
        # a short dip inside a piece does not end it: it ends where the sound has really died away
        b = min(nxt, max(end, i + need))
        segs.append((i * 0.01, min(b * 0.01, len(y) / sr)))
    return [(a, b) for a, b in segs if b - a >= 0.03]


def stem_syllables(rid, stem, t0, t1):
    """Syllable pieces of a stretch of a reference stem: [(a, b, pitch)] in absolute seconds of the song. pitch is the MIDI note the
    voice sings / speaks on in that piece (median of the voiced part), or None when the piece has no pitch."""
    y = _load_stem(rid, stem)
    a, b = max(0, int(t0 * SR)), min(len(y), int(t1 * SR))
    seg = y[a:b]
    pieces = segment_syllables(seg)
    if not pieces:
        return []
    f0, _ = pw.harvest(seg.astype(np.float64), SR, f0_floor=60.0, f0_ceil=1000.0, frame_period=10.0)
    out = []
    for s, e_ in pieces:
        fr = f0[int(s / 0.01): int(e_ / 0.01) + 1]
        fr = fr[fr > 0]
        pitch = float(np.median(librosa.hz_to_midi(fr))) if len(fr) >= 3 else None
        out.append((round(t0 + s, 4), round(t0 + e_, 4), None if pitch is None else round(pitch, 2)))
    return out


def split_syllables(spec):
    """Syllable pieces of a cut of a sample, in absolute seconds of the sample file. Like split_by_pitch the pieces are returned as
    [{a, b, root}] and cover the sound from the first piece to the last."""
    a0, b0 = float(spec["start"]), float(spec["end"])
    y = _load(spec["file"])[int(a0 * SR): int(b0 * SR)]
    segs = segment_syllables(y)
    if len(segs) < 2:
        return [{"a": round(a0, 4), "b": round(b0, 4), "root": None}]
    out = []
    for k, (s, e) in enumerate(segs):
        lo = 0.0 if k == 0 else (segs[k - 1][1] + s) / 2        # boundary halfway through the gap between two pieces
        hi = len(y) / SR if k == len(segs) - 1 else (e + segs[k + 1][0]) / 2
        out.append({"a": round(a0 + lo, 4), "b": round(a0 + hi, 4), "root": None})
    return out


def voice_info(spec):
    v = get_voice(spec)
    return {"root": v.root, "pitched": v.pitched}


# ---------------------------------------------------------------- mixing helpers
def _biquad(kind, f0, gain_db, q=0.8):
    """RBJ audio-EQ-cookbook coefficients (b, a) for a low shelf / peaking / high shelf filter."""
    A = 10 ** (gain_db / 40.0)
    w = 2 * np.pi * f0 / SR
    cw, sw = np.cos(w), np.sin(w)
    al = sw / (2 * q)
    if kind == "peak":
        b = [1 + al * A, -2 * cw, 1 - al * A]
        a = [1 + al / A, -2 * cw, 1 - al / A]
    else:
        sq = 2 * np.sqrt(A) * al
        if kind == "low":
            b = [A * ((A + 1) - (A - 1) * cw + sq), 2 * A * ((A - 1) - (A + 1) * cw), A * ((A + 1) - (A - 1) * cw - sq)]
            a = [(A + 1) + (A - 1) * cw + sq, -2 * ((A - 1) + (A + 1) * cw), (A + 1) + (A - 1) * cw - sq]
        else:
            b = [A * ((A + 1) + (A - 1) * cw + sq), -2 * A * ((A - 1) + (A + 1) * cw), A * ((A + 1) + (A - 1) * cw - sq)]
            a = [(A + 1) - (A - 1) * cw + sq, 2 * ((A - 1) - (A + 1) * cw), (A + 1) - (A - 1) * cw - sq]
    return np.array(b) / a[0], np.array(a) / a[0]


def _eq(x, lo=0.0, mid=0.0, hi=0.0):
    """3-band tone control, gains in dB (low shelf 200 Hz, peak 1 kHz, high shelf 4 kHz)."""
    from scipy.signal import lfilter
    for kind, f0, g in (("low", 200.0, lo), ("peak", 1000.0, mid), ("high", 4000.0, hi)):
        if abs(g) > 0.05:
            b, a = _biquad(kind, f0, float(np.clip(g, -15, 15)))
            x = lfilter(b, a, x)
    return x


def _comp(x, amount):
    """Simple compressor: amount 0..1 lowers the threshold and raises the ratio; loudness is made up automatically."""
    from scipy.signal import lfilter
    amt = float(np.clip(amount, 0.0, 1.0))
    if amt <= 0.01:
        return x
    thr = -10.0 - 16.0 * amt            # dB
    ratio = 1.0 + 7.0 * amt
    a = np.exp(-1.0 / (0.004 * SR))     # ~4 ms level detector (catches the hit of each note)
    env = np.sqrt(np.maximum(lfilter([1 - a], [1, -a], x.astype(np.float64) ** 2), 1e-12))
    over = np.maximum(20 * np.log10(env + 1e-9) - thr, 0.0)
    gdb = -over * (1 - 1 / ratio)
    r = np.exp(-1.0 / (0.08 * SR))      # gain recovers over ~80 ms
    gdb = -lfilter([1 - r], [1, -r], -gdb)   # smooth (attack is already smooth through the detector)
    makeup = -thr * (1 - 1 / ratio) * 0.45
    return (x * 10 ** ((gdb + makeup) / 20.0)).astype(np.float32)


_IR = {}


def _reverb(x, amount):
    """-> (wet_left, wet_right): the line sent through a synthetic ~1.8 s room, scaled by amount (0..1)."""
    from scipy.signal import fftconvolve
    if "ir" not in _IR:
        rng = np.random.default_rng(7)
        n = int(1.8 * SR)
        t = np.arange(n) / SR
        env = np.exp(-t * 3.6) * np.minimum(1.0, t / 0.012)
        ir = rng.standard_normal((2, n)) * env
        # darker tail: smooth the noise a little, more with time
        from scipy.signal import lfilter
        ir = lfilter([0.35], [1, -0.65], ir, axis=1)
        _IR["ir"] = ir / np.sqrt((ir ** 2).sum(axis=1, keepdims=True))
    ir = _IR["ir"]
    k = float(np.clip(amount, 0, 1)) * 0.55
    return (fftconvolve(x, ir[0])[: len(x) + len(ir[0])] * k).astype(np.float32), (fftconvolve(x, ir[1])[: len(x) + len(ir[1])] * k).astype(np.float32)


def _soft_limit(y, knee=0.8):
    o = np.abs(y)
    over = o > knee
    y = y.copy()
    y[over] = np.sign(y[over]) * (knee + (1 - knee) * np.tanh((o[over] - knee) / (1 - knee)))
    return y


def _active_rms(x):
    """Loudness of a line where it is sounding: the RMS over the parts that are not (nearly) silent."""
    if not len(x):
        return 0.0
    from scipy.ndimage import uniform_filter1d
    env = uniform_filter1d(x.astype(np.float64) ** 2, int(0.05 * SR))
    m = float(env.max())
    if m <= 1e-12:
        return 0.0
    act = env > 0.1 * m
    return float(np.sqrt(np.mean(x[act].astype(np.float64) ** 2)))


LAST = {}          # statistics of the last render (for checking levels)


def render(payload):
    """payload: {bpm, target, master:{vol, fade_in, fade_out}, lines:[{id, sample, vol, pan, mute, solo, eq:{lo,mid,hi}, rev, comp,
    nodes:[{s,l,notes:[{s,l,p}], sample?}]}]} -> stereo wav bytes"""
    spb = 60.0 / float(payload["bpm"])
    target = payload.get("target", "all")
    master = payload.get("master") or {}
    fade = int(0.008 * SR)
    lines = [L for L in payload["lines"] if target == "all" or L["id"] == target]
    if target == "all" and any(L.get("solo") for L in lines):
        lines = [L for L in lines if L.get("solo")]
    elif target == "all":
        lines = [L for L in lines if not L.get("mute")]
    per_line = []
    for L in lines:
        events = []
        # a note may carry a sound of its own ("sample"): such notes are played as little nodes of their own, the rest stays together
        nodes = []
        for nd in L["nodes"]:
            own = [q for q in nd["notes"] if q.get("sample") or abs(float(q.get("g") if q.get("g") is not None else 1.0) - 1.0) > 0.01]
            if not own:
                nodes.append(nd)
                continue
            rest = [q for q in nd["notes"] if not any(q is o_ for o_ in own)]
            if rest or nd.get("fill"):
                # the places of the notes that got a sound of their own are left empty in the original sound of the lane
                nodes.append({**nd, "notes": rest, "hole": [(float(q["s"]), float(q["s"]) + float(q["l"])) for q in own]})
            for q in own:
                nodes.append({**nd, "notes": [q], "sample": q.get("sample") or nd.get("sample"), "fill": False,
                              "gain": float(q.get("g") if q.get("g") is not None else 1.0)})
        for nd in nodes:
            n0 = len(events)
            try:
                spec = nd.get("sample") or L["sample"]
                if not spec:
                    continue
                if spec.get("ref"):                      # the original sound of a reference lane instead of a sample
                    # the sound of the lane is one continuous recording: notes that touch or overlap are played as ONE piece of it
                    # (so nothing is doubled and nothing is joined by a fade); a short gap after a piece keeps the tail of the sound
                    # a note whose pitch was moved ("p" differs from its original pitch "o") is played on its own, shifted by that many
                    # semitones; the rest of the lane plays as recorded
                    def _st(q):
                        return (int(q["p"]) - int(q["o"])) if q.get("o") is not None and q.get("p") is not None else 0
                    moved = [q for q in nd["notes"] if _st(q) != 0]
                    still = [q for q in nd["notes"] if _st(q) == 0]
                    starts = sorted(float(q["s"]) for q in nd["notes"])

                    def _ring_end(q):
                        s0, e0 = float(q["s"]), float(q["s"]) + float(q["l"])
                        nxt = next((x for x in starts if x > s0 + 1e-6), None)
                        if nd.get("tight"):                       # listening to one note: exactly the note, nothing after it
                            return e0
                        cap = e0 + 1.0 / spb                      # at most one second of ring-out
                        return max(e0, min(cap, nxt)) if nxt is not None else cap
                    span = {id(q): (float(q["s"]), _ring_end(q)) for q in moved}
                    cuts = sorted(list(span.values()) + [(float(a), float(b)) for a, b in (nd.get("hole") or [])])
                    runs = []
                    if nd.get("fill") and nd.get("l") and (nd["notes"] or nd.get("hole")):   # a bundle without any note is silent
                        runs = [[0.0, float(nd["l"])]]      # "as the original": the whole range of the node plays, not only where notes were found
                        for c0, c1 in cuts:                 # ... except where a note was moved (that one plays shifted instead)
                            nr = []
                            for r0, r1 in runs:
                                if c1 <= r0 or c0 >= r1:
                                    nr.append([r0, r1])
                                    continue
                                if c0 > r0:
                                    nr.append([r0, c0])
                                if c1 < r1:
                                    nr.append([c1, r1])
                            runs = nr
                    else:
                        for x0, x1 in sorted((float(q["s"]), float(q["s"]) + float(q["l"])) for q in still):
                            if runs and (x0 - runs[-1][1]) * spb <= 0.02:
                                runs[-1][1] = max(runs[-1][1], x1)
                            else:
                                runs.append([x0, x1])
                    for j, (x0, x1) in enumerate(runs):
                        if (x1 - x0) * spb < 0.02:
                            continue
                        gn = (runs[j + 1][0] - x1) * spb if j + 1 < len(runs) else None
                        ext = 0.08 if gn is None else min(gn, 0.12)
                        if nd.get("tight"):
                            ext = 0.0
                        for c0, _c1 in cuts:                         # the tail of a piece never runs into a note that was moved
                            if c0 >= x1 - 1e-9:
                                ext = min(ext, max(0.0, (c0 - x1) * spb))
                                break
                        try:
                            seg = ref_span(spec, x0, x1, spb, ext)
                        except Exception:  # noqa: BLE001
                            seg = None
                        if seg is None:
                            continue
                        seg = seg.copy()
                        f = min(fade, len(seg) // 2)
                        if f:
                            seg[:f] *= np.linspace(0, 1, f)
                        f = min(int(max(0.008, min(ext, 0.03)) * SR), len(seg) // 2)
                        if f:
                            seg[-f:] *= np.linspace(1, 0, f)
                        events.append((int((float(nd["s"]) + x0) * spb * SR), seg))
                    for q in moved:
                        try:
                            q0, q1 = span[id(q)]
                            seg = ref_span(spec, q0, q1, spb, 0.0)
                            if seg is not None:
                                seg = librosa.effects.pitch_shift(seg, sr=SR, n_steps=float(_st(q))).astype(np.float32)
                        except Exception:  # noqa: BLE001
                            seg = None
                        if seg is None:
                            continue
                        f = min(fade, len(seg) // 2)
                        if f:
                            seg[:f] *= np.linspace(0, 1, f)
                        f = min(int(0.03 * SR), len(seg) // 2)
                        if f:
                            seg[-f:] *= np.linspace(1, 0, f)
                        events.append((int((float(nd["s"]) + float(q["s"])) * spb * SR), seg))
                    continue
                v = get_voice(spec)
                fit = nd.get("fit") or L.get("fit") or "stretch"
                v0 = v
                if fit == "keep" and nd["notes"] and not spec.get("bend") and not any(k.get("cs") is not None or k.get("ts") is not None or k.get("te") is not None for k in nd["notes"]):
                    seg = keep_track(v0, nd["notes"], spb)
                    if seg is not None:
                        events.append((int(float(nd["s"]) * spb * SR), seg))
                    continue
                _prev = None
                for k in nd["notes"] + [None]:        # the sound of a note is trimmed once the note is done (None = after the last one)
                    if _prev is not None:
                        _trim_events(events, _prev[1], nd, _prev[0], spb)
                    if k is None:
                        break
                    _prev = (k, len(events))
                    # a note may carry its own piece of the cut ("cs"/"ce" = seconds inside the cut), so one cut can hold several syllables
                    v = v0
                    if k.get("cs") is not None and k.get("ce") is not None:
                        try:
                            v = get_voice({"file": spec["file"], "start": float(spec["start"]) + float(k["cs"]), "end": float(spec["start"]) + float(k["ce"])})
                        except ValueError:
                            v = v0
                    dur = max(0.05, float(k["l"]) * spb)
                    if spec.get("bend"):
                        try:
                            seg = bend_note(spec, k, dur, (int(k["p"]) - int(round(v.root))) if v.pitched else 0)
                        except Exception:  # noqa: BLE001
                            seg = None
                        if seg is not None:
                            seg = seg.copy()
                            f = min(fade, len(seg) // 2)
                            if f:
                                seg[:f] *= np.linspace(0, 1, f)
                                seg[-f:] *= np.linspace(1, 0, f)
                            events.append((int((float(nd["s"]) + float(k["s"])) * spb * SR), seg))
                            continue
                    # "repeat": a note much longer than the clip plays the clip again and again instead of stretching it
                    nat = len(v.y) / SR
                    # a node still at the clip's own pitch and about its own length plays the cut-out sound exactly as recorded
                    # (no re-synthesis, no stretching); a note longer than the clip only gets silence after it
                    same_pitch = int(k["p"]) == (int(round(v.root)) if v.pitched else UNPITCHED_ROOT)
                    if fit == "keep":
                        # keep the clip's own length: only the pitch is moved; a note shorter than the clip cuts it off, a longer one leaves silence
                        seg = (v.raw if same_pitch else v.shifted(int(k["p"])))[: int(dur * SR)].copy()
                        f = min(fade, len(seg) // 2)
                        if f:
                            seg[:f] *= np.linspace(0, 1, f)
                            seg[-f:] *= np.linspace(1, 0, f)
                        events.append((int((float(nd["s"]) + float(k["s"])) * spb * SR), seg))
                        continue
                    rnat = len(v.raw) / SR
                    if same_pitch and 0.9 * rnat <= dur <= rnat + spb:
                        want = int(dur * SR)
                        seg = v.raw[:want].copy()
                        seg = np.pad(seg, (0, want - len(seg)))
                        f = min(fade, len(seg) // 2)
                        if f:
                            seg[:f] *= np.linspace(0, 1, f)
                            seg[-f:] *= np.linspace(1, 0, f)
                        events.append((int((float(nd["s"]) + float(k["s"])) * spb * SR), seg))
                        continue
                    n_rep =max(1, int(round(dur / nat))) if fit == "repeat" and dur >= 1.5 * nat else 1
                    sub = dur / n_rep
                    for r in range(n_rep):
                        seg = v.note(int(k["p"]), sub).copy()
                        f = min(fade, len(seg) // 2)
                        if f:
                            seg[:f] *= np.linspace(0, 1, f)
                            seg[-f:] *= np.linspace(1, 0, f)
                        events.append((int(((float(nd["s"]) + float(k["s"])) * spb + r * sub) * SR), seg))
            finally:
                gn_ = float(nd.get("gain") if nd.get("gain") is not None else 1.0)
                if abs(gn_ - 1.0) > 1e-6:
                    for i_ in range(n0, len(events)):
                        events[i_] = (events[i_][0], (events[i_][1] * gn_).astype(np.float32))
        per_line.append((L, events))
    total = max([s + len(a) for _, ev in per_line for s, a in ev] + [SR // 2]) + SR // 4
    rev_tail = int(1.8 * SR) if any(float(L.get("rev") or 0) > 0.01 for L, _ in per_line) else 0
    left = np.zeros(total + rev_tail, dtype=np.float32)
    right = np.zeros(total + rev_tail, dtype=np.float32)
    # pass 1: every line on its own (events, EQ, compressor)
    strips = []
    for L, events in per_line:
        x = np.zeros(total, dtype=np.float32)
        for s, a in events:
            if s < 0:                      # a sound that would start before the beginning is cut at the beginning
                a, s = a[-s:], 0
            x[s:s + len(a)] += a
        eq = L.get("eq") or {}
        x = _eq(x, float(eq.get("lo") or 0), float(eq.get("mid") or 0), float(eq.get("hi") or 0)).astype(np.float32)
        x = _comp(x, float(L.get("comp") or 0))
        strips.append((L, x))
    # "auto level": a line with this switch on is brought to the loudness that the lines usually have (the median of the loudness of
    # all lines, measured only where a line is sounding), so a quiet sample line is not buried under loud reference lines
    levels = [_active_rms(x) for _, x in strips]
    heard = [r for r in levels if r > 1e-5]
    target = float(np.median(heard)) if len(heard) >= 2 else None
    # pass 2: auto level, volume, pan, reverb, sum
    for (L, x), lv in zip(strips, levels):
        if L.get("auto") and target is not None and lv > 1e-5:
            x = (x * float(np.clip(target / lv, 0.25, 4.0))).astype(np.float32)
        x = x * float(np.clip(L.get("vol", 1.0) if L.get("vol") is not None else 1.0, 0.0, 2.0))
        th = (float(np.clip(L.get("pan") or 0.0, -1, 1)) + 1) * np.pi / 4
        gl, gr = float(np.cos(th)), float(np.sin(th))
        left[:total] += x * gl
        right[:total] += x * gr
        rev = float(L.get("rev") or 0)
        if rev > 0.01:
            wl, wr = _reverb(x, rev)
            left[:len(wl)] += wl[: len(left)] * gl * 1.4
            right[:len(wr)] += wr[: len(right)] * gr * 1.4
    peak = float(max(np.abs(left).max(), np.abs(right).max()))
    LAST["peak_before"] = peak
    LAST["rms_before"] = float(np.sqrt(np.mean(left ** 2 + right ** 2) / 2.0))
    if peak > 0:
        left, right = left / peak * 0.9, right / peak * 0.9
    n = len(left)
    fi, fo = int(float(master.get("fade_in") or 0) * SR), int(float(master.get("fade_out") or 0) * SR)
    if fi > 0:
        fi = min(fi, n)
        left[:fi] *= np.linspace(0, 1, fi); right[:fi] *= np.linspace(0, 1, fi)
    if fo > 0:
        fo = min(fo, n)
        left[-fo:] *= np.linspace(1, 0, fo); right[-fo:] *= np.linspace(1, 0, fo)
    mv = float(np.clip(master.get("vol", 1.0) if master.get("vol") is not None else 1.0, 0.0, 2.0))
    out = _soft_limit(np.stack([left, right], axis=1) * mv)
    bio = io.BytesIO()
    sf.write(bio, np.clip(out, -1, 1), SR, format="WAV", subtype="PCM_16")
    return bio.getvalue()


# ---------------------------------------------------------------- reference
JOBS = {}
DEFAULT_MODEL = "htdemucs_6s"
_ana_lock = threading.Lock()

# Default (Korean) display names. Users can rename any lane in the UI, so unknown stems fall back to their id.
STEM_NAMES = {
    "vocals": "보컬", "drums": "드럼", "bass": "베이스", "other": "그 외 소리", "guitar": "기타", "piano": "피아노",
    "accordion": "아코디언", "acoustic-guitar": "어쿠스틱 기타", "back-vocal": "코러스", "banjo": "밴조",
    "bassoon": "바순", "bells": "벨", "bowed_strings": "현악(활)", "brass": "금관", "cello": "첼로",
    "clarinet": "클라리넷", "congas": "콩가", "digital-piano": "디지털 피아노", "dobro": "도브로",
    "double-bass": "더블베이스", "electric-guitar": "일렉 기타", "flute": "플루트", "french-horn": "호른",
    "glockenspiel": "글로켄슈필", "harmonica": "하모니카", "harp": "하프", "harpsichord": "하프시코드",
    "hh": "하이햇", "keys": "건반", "kick": "킥", "lead-vocal": "리드 보컬", "mandolin": "만돌린",
    "marimba": "마림바", "oboe": "오보에", "organ": "오르간", "percussion": "타악기", "saxophone": "색소폰",
    "sitar": "시타르", "snare": "스네어", "strings": "스트링", "synth": "신스", "tambourine": "탬버린",
    "timpani": "팀파니", "toms": "탐", "triangle": "트라이앵글", "trombone": "트롬본", "trumpet": "트럼펫",
    "tuba": "튜바", "ukulele": "우쿨렐레", "viola": "비올라", "violin": "바이올린", "vocal": "보컬",
    "wind": "관악", "wind-chimes": "윈드차임", "woodwind": "목관",
}
# stems that carry a single melodic line (pitch tracker) vs. several notes at once (polyphonic transcriber)
MONO_STEMS = {"bass", "vocals", "vocal", "lead-vocal", "back-vocal", "flute", "clarinet", "oboe", "trumpet",
              "trombone", "tuba", "saxophone", "bassoon", "french-horn", "harmonica", "violin", "cello",
              "viola", "double-bass"}
DRUM_STEMS = {"drums", "kick", "snare", "hh", "toms", "percussion", "congas", "tambourine", "triangle", "timpani"}
MIN_RMS = 0.004          # quieter than this = empty stem


def _classify_drums(d, force=None):
    on = librosa.onset.onset_detect(y=d, sr=SR, units="time", backtrack=False)
    hits = []
    for t in on:
        s = d[int(t * SR): int(t * SR) + int(0.08 * SR)]
        if len(s) < 512:
            continue
        if force:
            kind = force
        else:
            S = np.abs(np.fft.rfft(s * np.hanning(len(s))))
            f = np.fft.rfftfreq(len(s), 1 / SR)
            cen = (S * f).sum() / (S.sum() + 1e-9)
            low = S[f < 150].sum() / (S.sum() + 1e-9)
            kind = "kick" if low > 0.45 else ("hat" if cen > 5000 else "snare")
        hits.append({"t": round(float(t), 3), "k": kind})
    return hits


def _mark_melody(events, mono):
    """Flag events that belong to the single loudest line."""
    out = []
    for s, e, p, a in events:
        dur = max(e - s, 1e-6)
        m = False
        for ms, me, mp in mono:
            if mp == p and min(e, me) - max(s, ms) >= 0.5 * dur:
                m = True
                break
        out.append({"t": round(float(s), 3), "l": round(float(e - s), 3), "p": int(p), "m": m, "a": round(float(a), 2)})
    return out


def _poly_notes(wav_path, fmin=65, fmax=2100):
    from basic_pitch import ICASSP_2022_MODEL_PATH
    from basic_pitch.inference import predict
    _, _, ev = predict(str(wav_path), ICASSP_2022_MODEL_PATH,
                       minimum_note_length=80, minimum_frequency=fmin, maximum_frequency=fmax)
    events = [(float(s), float(e), int(p), float(a)) for s, e, p, a, _ in ev]
    if not events:
        return []
    mono = otomad.mono_from_events(events, 0.0, max(e for _, e, _, _ in events), min_dur=0.08)
    return _mark_melody(events, mono)


def prune_quiet(wav_path, notes):
    """Drop pitched notes that are practically silent in their own stem (Basic Pitch invents notes on faint bleed).
    A note stays if its loudness (dB, first 0.4 s) is above max(-50 dB, lane's 90th percentile - 22 dB). Kept notes get 'd' (dB)."""
    if not notes:
        return notes
    y, sr = sf.read(str(wav_path), always_2d=True)
    y = y.mean(axis=1)
    cs = np.concatenate([[0.0], np.cumsum(np.square(y, dtype=np.float64))])
    ds = []
    for n in notes:
        a = max(0, min(len(y) - 1, int(n["t"] * sr)))
        b = max(a + int(0.05 * sr), min(len(y), int((n["t"] + min(n.get("l", 0.2), 0.4)) * sr)))
        b = min(b, len(y))
        ds.append(10 * np.log10((cs[b] - cs[a]) / max(1, b - a) + 1e-12))
    ds = np.array(ds)
    floor = max(-50.0, float(np.percentile(ds, 90)) - 22.0)
    out = []
    for n, d in zip(notes, ds):
        if d >= floor:
            n["d"] = round(float(d), 1)
            out.append(n)
    return out


MIN_LANE_NOTES = 3


def migrate_levels(rid):
    """One-time clean-up of an analysis made before level checking existed."""
    rdir = DATA / "refs" / rid
    ap = rdir / "analysis.json"
    a = json.loads(ap.read_text(encoding="utf-8"))
    if a.get("pruned"):
        return a
    with _ana_lock:
        import shutil
        shutil.copy2(ap, rdir / "analysis.before-prune.json")   # keep the untouched result, just in case
        for key in list(a["lanes"]):
            wav = rdir / "stems" / (key + ".wav")
            if not wav.exists():
                continue
            kept = prune_quiet(wav, a["lanes"][key])
            if len(kept) < MIN_LANE_NOTES:
                del a["lanes"][key]
                a.get("meta", {}).pop(key, None)
                if key in a.get("order", []):
                    a["order"].remove(key)
            else:
                a["lanes"][key] = kept
        a["pruned"] = True
        ap.write_text(json.dumps(a, ensure_ascii=False), encoding="utf-8")
    return a


def _analyze_stem(key, wav_path):
    """-> (kind, poly, lane_data) or None when the stem is silent / has nothing to extract."""
    y, _ = librosa.load(str(wav_path), sr=SR, mono=True)
    if float(np.sqrt(np.mean(y ** 2))) < MIN_RMS:
        return None
    if key in DRUM_STEMS:
        force = {"kick": "kick", "snare": "snare", "hh": "hat"}.get(key)
        hits = prune_quiet(wav_path, _classify_drums(y, force))
        return ("drum", False, hits) if len(hits) >= MIN_LANE_NOTES else None
    # Basic Pitch is ~20x faster than a pYIN pitch tracker on a full song, so every stem uses it
    low = key in ("bass", "double-bass", "tuba")
    notes = prune_quiet(wav_path, _poly_notes(wav_path, 30 if low else 65, 450 if low else 2100))
    if len(notes) < MIN_LANE_NOTES:
        return None
    if key in MONO_STEMS:       # a single melodic line: keep only the loudest line
        notes = [n for n in notes if n["m"]]
        return ("pitch", False, notes) if notes else None
    return ("pitch", True, notes) if notes else None


def _levels(sdir):
    out = []
    for p in sorted(sdir.glob("*.wav")):
        y, _ = sf.read(str(p))
        out.append((p.stem, float(np.sqrt(np.mean(np.square(y))))))
    return out


def _run_reference(h, path, name, model):
    import shutil
    job = JOBS[h]
    rdir = DATA / "refs" / h
    try:
        # work in a scratch folder so a failed or interrupted run never destroys the previous result
        sdir = rdir / "stems.new"
        shutil.rmtree(sdir, ignore_errors=True)
        sdir.mkdir(parents=True, exist_ok=True)
        job["phase"] = "소리 분리 중 (몇 분 걸려요)"
        if model in ("htdemucs", "htdemucs_6s"):
            from separate import separate  # heavy import
            separate(str(path), str(sdir), None, model)
        elif model == "mega53":
            import separate_mega  # heavy import
            if not separate_mega.available():
                raise ValueError("53개 소리 모델 파일이 없어요 (models/mega53)")

            def prog(i, n):
                job["phase"] = "소리 분리 중 (%d/%d 조각, 한 조각에 약 2분)" % (i, n)
            job["phase"] = "소리 분리 중 (모델 불러오는 중)"
            separate_mega.separate_mega(path, sdir, progress=prog)
        else:
            raise ValueError("지원하지 않는 분리 모델: " + model)

        levels = [(k, r) for k, r in _levels(sdir) if r >= MIN_RMS]
        loud = sorted(levels, key=lambda kr: -kr[1])
        todo = [k for k, _ in loud]          # every stem that is not silent
        rms_of = dict(levels)
        available = [{"key": k, "name": STEM_NAMES.get(k, k), "rms": round(r, 4)} for k, r in loud]

        job["phase"] = "템포 찾는 중"
        src = next((sdir / (k + ".wav") for k in ("drums", "kick") if (sdir / (k + ".wav")).exists()), path)
        d, _ = librosa.load(str(src), sr=SR, mono=True)
        tempo, beats = librosa.beat.beat_track(y=d, sr=SR)
        tempo = float(np.atleast_1d(tempo)[0])
        if tempo < 85:   # beat trackers often lock onto half-time; most songs sit between 85 and 180 BPM
            tempo *= 2
        bt = librosa.frames_to_time(beats, sr=SR)
        offset = float(bt[0]) if len(bt) else 0.0
        dur = float(librosa.get_duration(path=str(path)))

        lanes, meta = {}, {}
        for i, key in enumerate(todo):
            job["phase"] = "음 뽑는 중: %s (%d/%d)" % (STEM_NAMES.get(key, key), i + 1, len(todo))
            res = _analyze_stem(key, sdir / (key + ".wav"))
            if res is None:
                continue
            kind, poly, data = res
            lanes[key] = data
            meta[key] = {"name": STEM_NAMES.get(key, key), "kind": kind, "poly": poly}
        order = sorted(lanes, key=lambda k: -rms_of.get(k, 0.0))   # loudest first

        result = {"id": h, "name": name, "model": model, "duration": round(dur, 2),
                  "bpm": round(tempo, 1), "offset": round(offset, 3),
                  "order": order, "meta": meta, "lanes": lanes, "available": available}
        shutil.rmtree(rdir / "stems", ignore_errors=True)
        sdir.rename(rdir / "stems")
        (rdir / "analysis.json").write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
        job["status"] = "done"
        job["phase"] = "완료"
    except Exception as ex:  # noqa: BLE001
        traceback.print_exc()
        shutil.rmtree(rdir / "stems.new", ignore_errors=True)
        job["status"] = "error"
        job["phase"] = "실패: " + str(ex)


def analyze_on_demand(rid, key):
    """Transcribe one more stem of an already separated song and add it to analysis.json."""
    rdir = DATA / "refs" / rid
    ap = rdir / "analysis.json"
    wav = rdir / "stems" / (key + ".wav")
    if not ap.exists() or not wav.exists():
        raise ValueError("이 소리 파일을 찾을 수 없어요")
    with _ana_lock:
        a = json.loads(ap.read_text(encoding="utf-8"))
        if key in a["lanes"]:
            return a
        res = _analyze_stem(key, wav)
        if res is None:
            raise ValueError("이 소리에서는 뽑을 음을 찾지 못했어요")
        kind, poly, data = res
        a["lanes"][key] = data
        a.setdefault("meta", {})[key] = {"name": STEM_NAMES.get(key, key), "kind": kind, "poly": poly}
        a.setdefault("order", []).append(key)
        ap.write_text(json.dumps(a, ensure_ascii=False), encoding="utf-8")
        return a


def f0_notes(y, floor_db=-35.0, bridge=8, min_frames=8, jump=0.8):
    """Notes cut from the MEASURED pitch line of one voice / instrument (WORLD harvest, 10 ms frames): [(t, length, midi)].
    The line is cut where it moves by more than `jump` semitones for at least 4 frames; short dropouts (<= 80 ms) are bridged."""
    from scipy.signal import medfilt
    f0, _ = pw.harvest(y.astype(np.float64), SR, f0_floor=60.0, f0_ceil=1000.0, frame_period=10.0)
    rms = librosa.feature.rms(y=y, frame_length=1024, hop_length=441)[0]
    act = 20 * np.log10(rms / max(float(rms.max()), 1e-9) + 1e-9) > floor_db
    n = min(len(f0), len(act))
    f0, act = f0[:n], act[:n]
    voiced = (f0 > 0) & act
    midi = np.zeros(n)
    midi[voiced] = librosa.hz_to_midi(f0[voiced])
    midi = np.where(voiced, medfilt(midi, 5), 0)
    runs, i = [], 0
    while i < n:
        if not voiced[i]:
            i += 1
            continue
        j = i
        while j + 1 < n and (voiced[j + 1] or voiced[j + 1: j + 1 + bridge].any()):
            j += 1
        runs.append((i, j))
        i = j + 1
    out = []

    def put(a, b):
        seg = midi[a:b + 1]
        seg = seg[seg > 0]
        if b - a + 1 >= min_frames and len(seg):
            out.append((a * 0.01, (b - a + 1) * 0.01, float(np.median(seg))))
    for s_, e_ in runs:
        cur = s_
        for k in range(s_ + 1, e_ + 1):
            if midi[k] <= 0 or midi[cur] <= 0:
                continue
            seg = midi[cur:k]
            seg = seg[seg > 0]
            ref_p = np.median(seg) if len(seg) else midi[k]
            if abs(midi[k] - ref_p) > jump and k + 4 <= e_ and np.all(np.abs(midi[k:k + 4] - ref_p) > jump):
                put(cur, k - 1)
                cur = k
        put(cur, e_)
    return out


def fill_gaps(rid, key):
    """Add notes to a pitched stem's lane where the transcriber found none although the stem is sounding with a clear pitch.
    New notes come from the measured pitch line and are marked 'f' so that running it again replaces them."""
    rdir = DATA / "refs" / rid
    ap = rdir / "analysis.json"
    wav = rdir / "stems" / (key + ".wav")
    if not ap.exists() or not wav.exists():
        raise ValueError("이 소리 파일을 찾을 수 없어요")
    if key in DRUM_STEMS:
        raise ValueError("드럼 소리에는 쓸 수 없어요")
    with _ana_lock:
        a = json.loads(ap.read_text(encoding="utf-8"))
        lane = [n for n in a["lanes"].get(key, []) if not n.get("f")]
        if key not in a["lanes"]:
            raise ValueError("먼저 이 소리의 음을 뽑아 주세요")
        y = _load_stem(rid, key)
        cand = f0_notes(y, min_frames=4)
        cov = np.zeros(int(len(y) / SR / 0.01) + 4, bool)
        for n in lane:
            cov[int(n["t"] / 0.01): int((n["t"] + n["l"]) / 0.01) + 1] = True
        new = []
        for t, l, p in cand:
            i0, i1 = int(round(t / 0.01)), int(round((t + l) / 0.01))
            free = ~cov[i0:i1]
            j = 0
            while j < len(free):      # only the part of the candidate that no existing note covers (>= 50 ms)
                if not free[j]:
                    j += 1
                    continue
                k = j
                while k < len(free) and free[k]:
                    k += 1
                q = int(round(p))
                if k - j >= 5 and 30 <= q <= 100:
                    new.append({"t": round((i0 + j) * 0.01, 3), "l": round((k - j) * 0.01, 3), "p": q, "m": True, "a": 0.6, "f": 1})
                j = k
        merged = []
        for x in sorted(new, key=lambda z: z["t"]):     # neighbours that sound on the same pitch are one note
            m = merged[-1] if merged else None
            if m and x["t"] - (m["t"] + m["l"]) <= 0.03 and abs(x["p"] - m["p"]) <= 1:
                m["l"] = round(x["t"] + x["l"] - m["t"], 3)
            else:
                merged.append(x)
        new = prune_quiet(wav, merged)
        a["lanes"][key] = sorted(lane + new, key=lambda n: n["t"])
        a["meta"][key]["filled"] = len(new)
        ap.write_text(json.dumps(a, ensure_ascii=False), encoding="utf-8")
        return a


def restart_reference(rid, model):
    """Analyse an already uploaded song again with another model (the original file is kept on disk)."""
    rdir = DATA / "refs" / rid
    origs = list(rdir.glob("orig.*"))
    if not origs:
        raise ValueError("원본 파일이 없어요. 참조곡을 다시 추가해 주세요")
    if rid in JOBS and JOBS[rid]["status"] == "running":
        return rid
    name = origs[0].name
    ap = rdir / "analysis.json"
    if ap.exists():
        try:
            name = json.loads(ap.read_text(encoding="utf-8")).get("name", name)
        except Exception:  # noqa: BLE001
            pass
    JOBS[rid] = {"status": "running", "phase": "대기 중", "started": time.time()}
    threading.Thread(target=_run_reference, args=(rid, origs[0], name, model), daemon=True).start()
    return rid


def start_reference(data, name, model=DEFAULT_MODEL):
    h = hashlib.sha1(data).hexdigest()[:12]
    rdir = DATA / "refs" / h
    rdir.mkdir(parents=True, exist_ok=True)
    ap = rdir / "analysis.json"
    if ap.exists():
        try:
            if json.loads(ap.read_text(encoding="utf-8")).get("model") == model:
                JOBS[h] = {"status": "done", "phase": "완료", "started": time.time()}
                return h
        except Exception:  # noqa: BLE001
            pass  # unreadable or old format -> analyse again
    if h in JOBS and JOBS[h]["status"] == "running":
        return h
    ext = Path(name).suffix or ".mp3"
    for old in rdir.glob("orig.*"):
        old.unlink()
    path = rdir / ("orig" + ext)
    path.write_bytes(data)
    JOBS[h] = {"status": "running", "phase": "대기 중", "started": time.time()}
    threading.Thread(target=_run_reference, args=(h, path, name, model), daemon=True).start()
    return h


# ------------------------------------------------------------------ one note out of a stem
def isolate_note(rid, key, t, length, pitch):
    """Cut ONE note out of a recorded stem even if other notes of the same stem sound at the same time.

    The note's harmonics (multiples of its pitch) are kept, everything else is turned down. Bins that the
    note shares with an overlapping note are split between the two by their strength. Returns WAV bytes.
    """
    rdir = DATA / "refs" / rid
    wav = rdir / "stems" / (key + ".wav")
    ap = rdir / "analysis.json"
    if not wav.exists() or not ap.exists():
        raise ValueError("이 소리 파일을 찾을 수 없어요")
    notes = json.loads(ap.read_text(encoding="utf-8"))["lanes"].get(key, [])
    pad_a, pad_b = 0.12, 0.35
    # a close / octave / fifth neighbour that starts while this note is still ringing cannot be filtered out of it: end this note where that one begins
    cut = t + length
    was_cut = False
    for n in notes:
        if "p" not in n or n["p"] == pitch and abs(n["t"] - t) < 1e-4:
            continue
        iv = abs(n["p"] - pitch)
        if t + 0.04 < n["t"] < cut and (iv <= 3 or iv % 12 in (0, 5, 7)):
            cut = n["t"]
            was_cut = True
    full_len = length
    length = max(0.05, cut - t)
    t0 = max(0.0, t - pad_a)
    dur = length + pad_a + pad_b
    y, _ = librosa.load(wav, sr=SR, mono=True, offset=t0, duration=dur)
    if len(y) < 2048:
        raise ValueError("구간이 너무 짧아요")
    # low notes sit only a few Hz apart (G#1 52 Hz vs A#1 58 Hz): they need a much longer analysis window to be told apart
    n_fft = 16384 if pitch < 48 else 8192 if pitch < 60 else 4096
    hop = n_fft // 8
    S = librosa.stft(y, n_fft=n_fft, hop_length=hop)
    mag = np.abs(S)
    nb, nf = S.shape
    binhz = SR / n_fft
    times = librosa.frames_to_time(np.arange(nf), sr=SR, hop_length=hop) + t0

    def mask_of(p, start, ln):
        f0 = 440.0 * 2 ** ((p - 69) / 12)
        g = np.zeros(nb)
        h = 1
        while h * f0 < min(12000, SR / 2 - 200):
            c = h * f0 / binhz
            sig = max(1.4, h * f0 * 0.022 / binhz)    # about +-38 cents
            lo, hi = max(0, int(c - 4 * sig)), min(nb, int(c + 4 * sig) + 2)
            idx = np.arange(lo, hi)
            g[idx] = np.maximum(g[idx], np.exp(-0.5 * ((idx - c) / sig) ** 2) / np.sqrt(h) ** 0.0)
            h += 1
        # alive from just before the onset until a short release after the written end
        act = np.clip((times - (start - 0.02)) / 0.02, 0, 1) * np.clip(((start + ln + 0.02) - times) / 0.03, 0, 1)
        return g[:, None] * act[None, :], act

    mt, act_t = mask_of(pitch, t, length)
    others = np.zeros_like(mt)
    n_oth = np.zeros(nf)
    for n in notes:
        if "p" not in n or abs(n["t"] - t) < 1e-4 and abs(n["p"] - pitch) < 1e-6:
            continue
        s, ln = n["t"], n.get("l", 0.2)
        if s > t + length + pad_b or s + ln < t0:
            continue
        mo, ao = mask_of(n["p"], s, ln)
        others += mo
        n_oth += ao
    share = mt / (mt + others + 1e-6)
    m = share * (mt > 0.02)
    # the onset click is not harmonic: keep a part of it, shared with the other notes that start there
    click = np.clip(1 - (times - t) / 0.04, 0, 1) * (times >= t - 0.01)
    m = np.maximum(m, (0.5 / (1.0 + n_oth)) * click[None, :] * act_t[None, :])
    out = librosa.istft(S * m, hop_length=hop, length=len(y))
    a, b = int((t - t0 - 0.005) * SR), int((t - t0 + length + (-0.004 if was_cut else 0.02)) * SR)
    out = out[max(0, a): min(len(out), b)]
    if was_cut and full_len > length + 0.01 and len(out) > 0.05 * SR:
        # keep the note sounding to its written end without the neighbour. The sustain is rebuilt from the note's OWN early steady sound
        # (just after its attack, before anything overlaps): its harmonic make-up and its real pitch are measured there and continued as one
        # perfectly steady tone, lined up in phase with where the recording was cut. Nothing recorded is repeated (no vibrato warble, no flutter).
        guard = int(0.004 * SR)
        base = out[: len(out) - guard].astype(np.float64)
        f_nom = 440.0 * 2 ** ((pitch - 69) / 12)
        W = int(max(0.06, 4.0 / f_nom) * SR)
        tc = min(max(t + 0.10, t + 0.03), max(t + 0.03, cut - 0.04))
        ic = int((tc - t0) * SR)
        lo = max(0, min(ic - W // 2, len(base) - W))
        W = min(W, len(base) - lo)
        x = base[lo: lo + W]
        ti = (np.arange(W) - W / 2) / SR
        hw = np.hanning(W)

        def basis(f0, tt, H):
            k = np.arange(1, H + 1)[None, :] * 2 * np.pi * f0 * tt[:, None]
            return np.concatenate([np.cos(k), np.sin(k)], axis=1)

        H = int(max(1, min(24, min(12000.0, SR / 2 - 300) // f_nom, W // 4 - 1)))
        best = None
        for cents in range(-30, 31, 3):                      # the real pitch can differ a little from the written note
            f0 = f_nom * 2 ** (cents / 1200)
            A = basis(f0, ti, H) * hw[:, None]
            coef, *_ = np.linalg.lstsq(A, x * hw, rcond=None)
            err = float(np.sum((A @ coef - x * hw) ** 2))
            if best is None or err < best[0]:
                best = (err, f0, coef)
        _, f0, coef = best
        need = int((full_len - length + 0.02) * SR)
        xf = int(0.02 * SR)
        u = np.arange(-xf, need) / SR + (len(base) - (lo + W / 2)) / SR      # time relative to the centre of the measured window
        tail = base[-xf:]
        bestd = (-2.0, 0.0)
        for d in np.linspace(0, 1.0 / f0, 64, endpoint=False):   # line the tone up in phase with the recorded end
            c = float(np.dot(tail, (basis(f0, u[:xf] + d, H) @ coef)))
            if c > bestd[0]:
                bestd = (c, d)
        syn = basis(f0, u + bestd[1], H) @ coef
        lv_base = float(np.sqrt(np.mean(base[-int(0.03 * SR):] ** 2))) + 1e-9
        lv_syn = float(np.sqrt(np.mean(syn[:int(0.03 * SR)] ** 2))) + 1e-9
        syn = syn * float(np.clip(lv_base / lv_syn, 0.3, 3.0))
        w = np.linspace(0, 1, xf)
        base[-xf:] = base[-xf:] * (1 - w) + syn[:xf] * w
        out = np.concatenate([base, syn[xf:]]).astype(np.float32)
    fade = min(len(out) // 4, int(0.02 * SR))
    if fade > 0:
        out[:fade] *= np.linspace(0, 1, fade)
        out[-fade:] *= np.linspace(1, 0, fade)
    pk = float(np.max(np.abs(out))) if len(out) else 0.0
    if pk > 0.98:
        out = out * (0.98 / pk)
    buf = io.BytesIO()
    sf.write(buf, out.astype(np.float32), SR, format="WAV", subtype="PCM_16")
    return buf.getvalue()
