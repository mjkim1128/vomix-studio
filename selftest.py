"""Self-test with synthetic audio: ground-truth melody in -> check notes out and output pitch."""
import numpy as np
import soundfile as sf
import librosa
from scipy.signal import lfilter

import otomad
from otomad import SR

# Twinkle Twinkle (C major), MIDI numbers, durations in beats at 120 bpm (0.5 s/beat)
tune = [(60, 1), (60, 1), (67, 1), (67, 1), (69, 1), (69, 1), (67, 2),
        (65, 1), (65, 1), (64, 1), (64, 1), (62, 1), (62, 1), (60, 2)]
GAP = 0.06


def tone(midi, dur, harmonics=8):
    t = np.arange(int(dur * SR)) / SR
    f = librosa.midi_to_hz(midi)
    y = sum(np.sin(2 * np.pi * f * k * t) / k for k in range(1, harmonics + 1))
    env = np.minimum(1, t / 0.02) * np.minimum(1, (dur - t) / 0.03)
    return y * env


# reference melody
parts, truth, t0 = [], [], 0.0
for m, b in tune:
    d = b * 0.5
    seg = tone(m, d - GAP)
    parts.append(np.concatenate([seg, np.zeros(int(GAP * SR))]))
    truth.append((t0, t0 + d - GAP, m))
    t0 += d
ref = np.concatenate(parts).astype(np.float32)
sf.write("test_ref.wav", ref / np.abs(ref).max() * 0.8, SR)

# fake "voice" sample: harmonic tone at ~A3 filtered through an /a/-like resonance, 0.5 s
f0 = 220.0
t = np.arange(int(0.5 * SR)) / SR
src = sum(np.sin(2 * np.pi * f0 * k * t) / k for k in range(1, 40))
for fc, bw in [(800, 100), (1200, 120), (2600, 200)]:
    r = np.exp(-np.pi * bw / SR)
    th = 2 * np.pi * fc / SR
    src = lfilter([1 - r], [1, -2 * r * np.cos(th), r * r], src)
src *= np.minimum(1, t / 0.02) * np.minimum(1, (0.5 - t) / 0.05)
sf.write("test_sample.wav", (src / np.abs(src).max() * 0.8).astype(np.float32), SR)

# --- run pipeline
y, _ = librosa.load("test_ref.wav", sr=SR)
notes = otomad.extract_notes(y)
print(f"truth notes: {len(truth)}  extracted: {len(notes)}")
ok_pitch = sum(1 for a, b in zip(truth, notes) if a[2] == b[2])
onset_err = [abs(a[0] - b[0]) for a, b in zip(truth, notes)]
print(f"pitch correct: {ok_pitch}/{min(len(truth), len(notes))}   "
      f"onset error: mean {np.mean(onset_err)*1000:.0f} ms, max {np.max(onset_err)*1000:.0f} ms")

ys, _ = librosa.load("test_sample.wav", sr=SR)
smp = otomad.Sample(ys)
print(f"sample root: MIDI {smp.root:.2f} (expected {librosa.hz_to_midi(220.0):.2f})")
out = otomad.render(notes, smp)
sf.write("test_out.wav", out, SR)

# --- verify output: re-extract the melody from the rendered audio
re_notes = otomad.extract_notes(out)
ok2 = sum(1 for a, b in zip(notes, re_notes) if a[2] == b[2])
print(f"output re-extracted: {len(re_notes)} notes, pitch matches input notes: {ok2}/{len(notes)}")
