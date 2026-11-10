"""Vomix Studio launcher: starts the local server and opens it in its own app window.

Run with pythonw.exe (no console).  Closing the window shuts the server down again.

  dev machine : uses  app/data  next to this file (your existing projects)
  installed   : an  installed.flag  file sits next to this file -> data lives in %LOCALAPPDATA%\\VomixStudio\\data
"""
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
INSTALLED = (ROOT / "installed.flag").exists()
HOME = Path(os.environ.get("LOCALAPPDATA") or Path.home()) / "VomixStudio"
HOME.mkdir(parents=True, exist_ok=True)

# no console when started with pythonw: give stdout / stderr somewhere to go (uvicorn and tqdm write to them)
_log = open(HOME / "vomix.log", "a", encoding="utf-8", buffering=1)
if sys.stdout is None or INSTALLED:
    sys.stdout = _log
if sys.stderr is None or INSTALLED:
    sys.stderr = _log

if INSTALLED:
    os.environ.setdefault("OTOMAD_DATA", str(HOME / "data"))
    os.environ.setdefault("HF_HOME", str(ROOT / "models" / "hf"))     # separation weights are shipped with the program
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ.setdefault("TORCH_HOME", str(ROOT / "models" / "torch"))
sys.path.insert(0, str(ROOT / "app"))
sys.path.insert(0, str(ROOT))

PORT = int(os.environ.get("VOMIX_PORT", "8765"))
URL = "http://127.0.0.1:%d/" % PORT


def _alive(port):
    try:
        with urllib.request.urlopen("http://127.0.0.1:%d/api/alive" % port, timeout=1.5) as r:
            return b"vomix" in r.read()
    except Exception:  # noqa: BLE001
        return False


def _port_free(port):
    with socket.socket() as s:
        return s.connect_ex(("127.0.0.1", port)) != 0


def _find_browser():
    cands = []
    for base in (os.environ.get("ProgramFiles(x86)"), os.environ.get("ProgramFiles"), os.environ.get("LOCALAPPDATA")):
        if base:
            cands += [Path(base) / "Microsoft/Edge/Application/msedge.exe", Path(base) / "Google/Chrome/Application/chrome.exe"]
    return next((c for c in cands if c.exists()), None)


def _open_window(url):
    """Open `url` in a chromeless app window of its own (separate profile, so closing it ends the process we wait for)."""
    exe = _find_browser()
    if exe is None:
        import webbrowser
        webbrowser.open(url)
        return None
    prof = HOME / "window-profile"
    prof.mkdir(parents=True, exist_ok=True)
    return subprocess.Popen([str(exe), "--app=" + url, "--user-data-dir=" + str(prof), "--window-size=1560,980",
                             "--no-first-run", "--no-default-browser-check", "--disable-features=Translate"])


def main():
    if _alive(PORT):                       # already running: just open another window
        _open_window(URL)
        return
    if not _port_free(PORT):
        raise SystemExit("포트 %d 를 다른 프로그램이 쓰고 있어요" % PORT)
    import uvicorn
    import server  # noqa: E402  (app/server.py)
    cfg = uvicorn.Config(server.app, host="127.0.0.1", port=PORT, log_level="warning", log_config=None)
    srv = uvicorn.Server(cfg)
    t = threading.Thread(target=srv.run, daemon=True)
    t.start()
    for _ in range(300):
        if _alive(PORT):
            break
        time.sleep(0.2)
    else:
        raise SystemExit("서버가 시작되지 않았어요. %s 를 확인해 주세요" % (HOME / "vomix.log"))
    proc = _open_window(URL)
    if proc is not None:
        proc.wait()                        # the window process ends when the window is closed
        # a second window may still be open in an already running browser: wait a moment for pings
        time.sleep(3)
    # no managed window (or it handed over to a running browser): stop when the page stops pinging
    while True:
        last = server.LAST_PING["t"]
        if last is not None and time.time() - last > (6 if proc is not None else 120):
            break
        if last is None and proc is not None:
            break
        time.sleep(2)
    srv.should_exit = True
    t.join(timeout=10)


if __name__ == "__main__":
    main()
