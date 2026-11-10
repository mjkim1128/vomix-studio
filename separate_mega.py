"""53-stem separation with MVSep "Mega" (BS-RoFormer), from ZFTurbo/Music-Source-Separation-Training v1.0.21.

Files expected (downloaded by the user's OK, see models/mega53 and third_party/MSST):
  models/mega53/mvsep_mega_model_bs_roformer_53_stems.yaml
  models/mega53/mvsep_mega_model_bs_roformer_53_stems_v1.ckpt
  third_party/MSST/                (model code, MIT)
Usage: python separate_mega.py song.mp3 out_dir [--seconds 20] [--start 60]
"""
import sys
import time
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf
import torch
import yaml

ROOT = Path(__file__).resolve().parent
MSST = ROOT / "third_party" / "MSST"
CFG = ROOT / "models" / "mega53" / "mvsep_mega_model_bs_roformer_53_stems.yaml"
CKPT = ROOT / "models" / "mega53" / "mvsep_mega_model_bs_roformer_53_stems_v1.ckpt"
SR = 44100
_model = None


def available():
    return CFG.exists() and CKPT.exists() and (MSST / "models" / "bs_roformer").exists()


def _config():
    class Loader(yaml.SafeLoader):  # the config uses !!python/tuple: allow that tag only
        pass
    Loader.add_constructor("tag:yaml.org,2002:python/tuple", lambda l, n: tuple(l.construct_sequence(n)))
    with open(CFG, encoding="utf-8") as f:
        return yaml.load(f, Loader=Loader)


def load_model():
    global _model
    if _model is None:
        if str(MSST) not in sys.path:
            sys.path.insert(0, str(MSST))
        from models.bs_roformer import BSRoformer  # noqa: E402  (third_party/MSST)
        cfg = _config()
        model = BSRoformer(**cfg["model"])
        state = torch.load(str(CKPT), map_location="cpu", weights_only=True)  # tensors only: no pickled code
        if isinstance(state, dict) and "state_dict" in state:
            state = state["state_dict"]
        model.load_state_dict(state)
        model.eval()
        _model = (model, cfg["training"]["instruments"])
    return _model


def separate_mega(path, out_dir, stems=None, chunk_s=20.0, start_s=0.0, seconds=None, progress=None, device="cpu",
                  overlap=0.25):
    """Write <out_dir>/<stem>.wav for every requested stem (default all 53); returns the stem names written.
    chunk_s / overlap trade speed for quality: the model was trained on 20 s chunks."""
    model, names = load_model()
    pick = [i for i, n in enumerate(names) if stems is None or n in stems]
    model = model.to(device)
    y, _ = librosa.load(str(path), sr=SR, mono=False, offset=start_s, duration=seconds)
    if y.ndim == 1:
        y = np.stack([y, y])
    y = y.astype(np.float32)
    n = y.shape[1]
    C = int(chunk_s * SR)
    R = max(1, int(C * overlap))     # overlap (cross-fade) length
    step = C - R
    n_chunks = max(1, int(np.ceil(max(n - C, 0) / step)) + 1)
    total = (n_chunks - 1) * step + C
    y = np.pad(y, ((0, 0), (0, total - n)))
    acc = np.zeros((len(pick), 2, total), dtype=np.float32)
    wsum = np.zeros(total, dtype=np.float32)
    with torch.no_grad():
        for i in range(n_chunks):
            s = i * step
            x = torch.from_numpy(y[:, s:s + C])[None].to(device)
            out = model(x, active_stem_ids=pick)[0].float().cpu().numpy()      # (stems, 2, C)
            w = np.ones(C, dtype=np.float32)
            if i > 0:
                w[:R] = np.linspace(0, 1, R, dtype=np.float32)
            if i < n_chunks - 1:
                w[-R:] = np.linspace(1, 0, R, dtype=np.float32)
            acc[:, :, s:s + C] += out * w
            wsum[s:s + C] += w
            if progress:
                progress(i + 1, n_chunks)
    acc /= np.maximum(wsum, 1e-6)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    written = []
    for k, idx in enumerate(pick):
        if float(np.sqrt(np.mean(np.square(acc[k, :, :n])))) < 0.003:
            continue  # silent stem: do not waste ~16 MB of disk per minute on it
        sf.write(str(out_dir / (names[idx] + ".wav")), acc[k, :, :n].T, SR)
        written.append(names[idx])
    return written


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("audio")
    ap.add_argument("out")
    ap.add_argument("--seconds", type=float, default=None)
    ap.add_argument("--start", type=float, default=0.0)
    ap.add_argument("--device", default="cpu")
    a = ap.parse_args()
    t0 = time.time()
    t = load_model()
    print("model loaded in %.1fs" % (time.time() - t0), flush=True)
    t1 = time.time()
    names = separate_mega(a.audio, a.out, seconds=a.seconds, start_s=a.start, device=a.device,
                          progress=lambda i, n: print("chunk %d/%d  %.1fs elapsed" % (i, n, time.time() - t1), flush=True))
    print("done: %d stems in %.1fs" % (len(names), time.time() - t1))
