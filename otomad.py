"""Otomad prototype: reference melody -> notes -> pitch/length-fitted sample -> WAV.

Pipeline (each step is a function so it can later become a node):
  extract_notes(ref_audio)        reference -> [(start, end, midi)]
  detect_root(sample_audio)       sample -> root pitch (midi float)
  render(notes, sample, root)     notes + sample -> mixed audio
"""
import argparse
import json
import sys

import librosa
import numpy as np
import pyworld as pw
import soundfile as sf
from scipy.ndimage import maximum_filter1d

SR = 44100
HOP = 512  # analysis hop for pyin


# ---------------------------------------------------------------- extraction
def extract_notes(y, sr=SR, fmin="C2", fmax="C7", min_dur=0.08, merge_gap=0.0, gate=0.3):
    """Monophonic melody -> note list. Input should be a single melodic line
    (e.g. separated vocals); polyphonic mixes will give wrong notes."""
    f0, voiced, _ = librosa.pyin(
        y, fmin=librosa.note_to_hz(fmin), fmax=librosa.note_to_hz(fmax),
        sr=sr, frame_length=2048, hop_length=HOP,
    )
    # pyin bridges short silences between repeated notes; cut where loudness
    # drops well below the local peak (re-articulation / gaps).
    rms = librosa.feature.rms(y=y, frame_length=2048, hop_length=HOP)[0][: len(f0)]
    local_max = maximum_filter1d(rms, size=int(1.0 * sr / HOP))
    loud = rms >= gate * local_max
    midi = np.full_like(f0, np.nan)
    ok = voiced & ~np.isnan(f0) & loud
    midi[ok] = librosa.hz_to_midi(f0[ok])
    q = np.round(midi)  # quantise to semitones
    # median smoothing over 5 frames to kill single-frame flicker
    sm = q.copy()
    for i in range(len(q)):
        w = q[max(0, i - 2): i + 3]
        w = w[~np.isnan(w)]
        if ok[i] and len(w):
            sm[i] = np.median(w)
    dt = HOP / sr
    notes, cur = [], None
    for i, m in enumerate(sm):
        if np.isnan(m):
            if cur:
                notes.append(cur); cur = None
            continue
        if cur and cur[2] == m:
            cur[1] = (i + 1) * dt
        else:
            if cur:
                notes.append(cur)
            cur = [i * dt, (i + 1) * dt, float(m)]
    if cur:
        notes.append(cur)
    # merge same-pitch notes separated by tiny gaps, drop very short ones
    merged = []
    for n in notes:
        if merged and n[2] == merged[-1][2] and n[0] - merged[-1][1] <= merge_gap:
            merged[-1][1] = n[1]
        else:
            merged.append(n)
    return [(round(a, 4), round(b, 4), int(m)) for a, b, m in merged if b - a >= min_dur]


def mono_from_events(events, t0=0.0, t1=None, step=0.01, min_dur=0.1, fold=None):
    """Polyphonic note events [(start,end,midi,amp)] -> single line by always
    following the loudest active note. `fold=(lo,hi)` octave-shifts notes into a range."""
    t1 = t1 or max(e[1] for e in events)
    grid = np.arange(t0, t1, step)
    best = np.full(len(grid), np.nan)
    best_amp = np.zeros(len(grid))
    for s, e, p, a in events:
        i, j = int(max(0, (s - t0) / step)), int(min(len(grid), (e - t0) / step))
        if j <= i:
            continue
        m = a > best_amp[i:j]
        best[i:j][m] = p
        best_amp[i:j][m] = a
    notes, cur = [], None
    for k, p in enumerate(best):
        ts = t0 + k * step
        if np.isnan(p):
            if cur: notes.append(cur); cur = None
        elif cur and cur[2] == p:
            cur[1] = ts + step
        else:
            if cur: notes.append(cur)
            cur = [ts, ts + step, int(p)]
    if cur:
        notes.append(cur)
    out = []
    for s, e, p in notes:
        if e - s < min_dur:
            continue
        if fold:
            while p < fold[0]: p += 12
            while p > fold[1]: p -= 12
        out.append((round(s - t0, 4), round(e - t0, 4), p))
    return out


# ------------------------------------------------------------------- sample
class Sample:
    """Holds a sample's WORLD analysis so pitch/length changes are cheap."""

    def __init__(self, y, sr=SR):
        y, _ = librosa.effects.trim(y, top_db=35)
        self.y = y.astype(np.float64)
        self.sr = sr
        f0, t = pw.harvest(self.y, sr, f0_floor=60.0, f0_ceil=1000.0, frame_period=5.0)
        self.sp = pw.cheaptrick(self.y, f0, t, sr)
        self.ap = pw.d4c(self.y, f0, t, sr)
        self.f0 = f0
        voiced = f0[f0 > 0]
        if len(voiced) == 0:
            raise ValueError("sample has no detectable pitch (not a voiced/tonal sound)")
        self.root = float(np.median(librosa.hz_to_midi(voiced)))
        self._cache = {}

    def note(self, midi, dur):
        """Sample re-pitched to `midi`, time-fitted to `dur` seconds."""
        key = (int(midi), round(dur, 3))
        if key in self._cache:
            return self._cache[key]
        n_out = max(2, int(dur * 1000 / 5.0))
        src = np.linspace(0, len(self.f0) - 1, n_out)
        idx = np.arange(len(self.f0))
        f0 = np.interp(src, idx, self.f0)
        # keep unvoiced frames unvoiced (nearest-neighbour on the voiced mask)
        vmask = self.f0[np.round(src).astype(int)] > 0
        # re-pitch: flatten natural intonation to the target note, voiced frames only
        f0 = np.where(vmask, librosa.midi_to_hz(midi), 0.0)
        sp = np.stack([np.interp(src, idx, self.sp[:, k]) for k in range(self.sp.shape[1])], axis=1)
        ap = np.stack([np.interp(src, idx, self.ap[:, k]) for k in range(self.ap.shape[1])], axis=1)
        out = pw.synthesize(f0, np.ascontiguousarray(sp), np.ascontiguousarray(ap), self.sr, 5.0)
        out = out.astype(np.float32)
        self._cache[key] = out
        return out


def render(notes, sample, total=None, fade=0.008):
    total = total or (max(e for _, e, _ in notes) + 0.5)
    buf = np.zeros(int(total * sample.sr) + sample.sr, dtype=np.float32)
    for s, e, m in notes:
        seg = sample.note(m, e - s).copy()
        f = min(int(fade * sample.sr), len(seg) // 2)
        if f:
            seg[:f] *= np.linspace(0, 1, f)
            seg[-f:] *= np.linspace(1, 0, f)
        i = int(s * sample.sr)
        buf[i:i + len(seg)] += seg
    peak = np.abs(buf).max()
    return buf / peak * 0.9 if peak > 0 else buf


# ---------------------------------------------------------------------- CLI
def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--ref", help="reference audio (monophonic melody)")
    ap.add_argument("--notes", help="notes JSON instead of --ref: [[start,end,midi],...]")
    ap.add_argument("--sample", required=True, help="short voice/sound clip to use as the instrument")
    ap.add_argument("--out", default="out.wav")
    ap.add_argument("--notes-out", help="save extracted notes as JSON")
    a = ap.parse_args()

    if a.ref:
        ref, _ = librosa.load(a.ref, sr=SR, mono=True)
        notes = extract_notes(ref)
    elif a.notes:
        notes = [tuple(n) for n in json.load(open(a.notes))]
    else:
        sys.exit("need --ref or --notes")
    print(f"{len(notes)} notes")
    if a.notes_out:
        json.dump(notes, open(a.notes_out, "w"))

    y, _ = librosa.load(a.sample, sr=SR, mono=True)
    smp = Sample(y)
    print(f"sample root pitch: MIDI {smp.root:.2f}")
    out = render(notes, smp)
    sf.write(a.out, out, SR)
    print("wrote", a.out)


if __name__ == "__main__":
    main()
