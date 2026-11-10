"""Source separation with Demucs. Model weights are downloaded on first use of a model."""
import sys

import librosa
import numpy as np
import soundfile as sf
import torch
from demucs.apply import apply_model
from demucs.pretrained import get_model


def separate(path, out_dir=".", stems=None, model_name="htdemucs_6s"):
    """Split `path` into stems and write <out_dir>/<stem>.wav. Returns {stem: path}.
    htdemucs: vocals/drums/bass/other. htdemucs_6s adds guitar and piano."""
    model = get_model(model_name)
    model.eval()
    y, _ = librosa.load(path, sr=model.samplerate, mono=False)
    if y.ndim == 1:
        y = np.stack([y, y])
    wav = torch.from_numpy(y).float()
    ref = wav.mean(0)
    wav = (wav - ref.mean()) / (ref.std() + 1e-8)
    with torch.no_grad():
        out = apply_model(model, wav[None], device="cpu", split=True, overlap=0.25, progress=False)[0]
    out = out * (ref.std() + 1e-8) + ref.mean()
    paths = {}
    for name in (stems or list(model.sources)):
        i = model.sources.index(name)
        p = f"{out_dir}/{name}.wav"
        sf.write(p, out[i].numpy().T, model.samplerate)
        paths[name] = p
    return paths


if __name__ == "__main__":
    print(separate(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else ".", None, sys.argv[3] if len(sys.argv) > 3 else "htdemucs_6s"))
