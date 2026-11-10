"""Build the folder that the installer packs:  dist/VomixStudio/

    python packaging/build_stage.py [--no-precise]

A private copy of Python (so nothing has to be installed on the user's PC) + every package of the dev venv + the program files.
The 53-stem model (models/mega53, 1.3 GB) is included (its MIT notice is in THIRD_PARTY_NOTICES.txt); give --no-precise to leave it out.
"""
import os
import shutil
import stat
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STAGE = ROOT / "dist" / "VomixStudio"
WITH_PRECISE = "--no-precise" not in sys.argv


def _force_remove(func, path, _exc):
    """git pack files are read-only: clear the flag and retry"""
    os.chmod(path, stat.S_IWRITE)
    func(path)


def home_of_base_python():
    for line in (ROOT / ".venv" / "pyvenv.cfg").read_text(encoding="utf-8").splitlines():
        if line.startswith("home"):
            return Path(line.split("=", 1)[1].strip())
    raise SystemExit("pyvenv.cfg has no home")


def copy(src, dst, ignore=None):
    if src.is_dir():
        shutil.copytree(src, dst, ignore=ignore, dirs_exist_ok=True)
    else:
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)


def log(msg):
    print(time.strftime("%H:%M:%S"), msg, flush=True)


def main():
    if STAGE.exists():
        log("removing old stage")
        shutil.rmtree(STAGE, onerror=_force_remove)
    STAGE.mkdir(parents=True)

    base = home_of_base_python()
    log("python from " + str(base))
    skip_py = shutil.ignore_patterns("__pycache__", "site-packages", "test", "tests", "idlelib", "tkinter", "turtledemo", "lib2to3", "ensurepip")
    py = STAGE / "python"
    py.mkdir()
    for name in ("python.exe", "pythonw.exe", "python3.dll", "python310.dll", "vcruntime140.dll", "vcruntime140_1.dll"):
        if (base / name).exists():
            copy(base / name, py / name)
    copy(base / "DLLs", py / "DLLs", ignore=shutil.ignore_patterns("tcl*", "tk*", "_tkinter*", "__pycache__"))
    copy(base / "Lib", py / "Lib", ignore=skip_py)
    log("python copied")

    sp = ROOT / ".venv" / "Lib" / "site-packages"
    skip_sp = shutil.ignore_patterns("__pycache__", "pip", "pip-*", "setuptools", "setuptools-*", "wheel", "wheel-*", "pkg_resources", "_distutils_hack", "distutils-precedence.pth")
    def skip_deep(d, names):
        """skip build-time-only folders: C++ headers of torch have very long names and are never needed to run (Windows paths top out at 260 characters)"""
        out = set(skip_sp(d, names))
        if Path(d).name == "torch" and "include" in names:
            out.add("include")
        if Path(d).name == "lib" and Path(d).parent.name == "torch":
            out.update(n for n in names if n.endswith(".lib"))
        return out

    copy(sp, py / "Lib" / "site-packages", ignore=skip_deep)
    log("site-packages copied")

    skip_app = shutil.ignore_patterns("__pycache__", "data", "*.log", "*.err", "*.pyc")
    copy(ROOT / "app", STAGE / "app", ignore=skip_app)
    for f in ("otomad.py", "separate.py", "separate_mega.py", "launcher.py"):
        copy(ROOT / f, STAGE / f)
    copy(ROOT / "third_party", STAGE / "third_party", ignore=shutil.ignore_patterns("__pycache__", ".git", ".github"))
    copy(ROOT / "assets", STAGE / "assets", ignore=shutil.ignore_patterns("*_512.png"))
    copy(ROOT / "packaging" / "THIRD_PARTY_NOTICES.txt", STAGE / "THIRD_PARTY_NOTICES.txt")

    hf = Path.home() / ".cache" / "huggingface" / "hub"
    for repo in ("models--adefossez--HTDemucs", "models--adefossez--HTDemucs-6s"):
        if not (hf / repo).exists():
            raise SystemExit("separation weights not found: " + str(hf / repo))
        shutil.copytree(hf / repo, STAGE / "models" / "hf" / "hub" / repo, symlinks=False)
    log("separation weights copied")
    if WITH_PRECISE:
        copy(ROOT / "models" / "mega53", STAGE / "models" / "mega53")
        shutil.copy2(ROOT / "packaging" / "THIRD_PARTY_NOTICES.txt", STAGE / "models" / "mega53" / "LICENSE-NOTICE.txt")
        log("53-stem model copied")

    (STAGE / "installed.flag").write_text("1", encoding="utf-8")
    total = sum(f.stat().st_size for f in STAGE.rglob("*") if f.is_file())
    log("done: %.2f GB in %s" % (total / 1e9, STAGE))


if __name__ == "__main__":
    main()
