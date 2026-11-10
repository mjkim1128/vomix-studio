"""Free / Pro plans of Vomix Studio.

The local download app checks a licence key offline. When this becomes a web service, replace `current_plan()` with a lookup of the
signed-in user and use `check_export()` to count WAV exports with tokens (see the notes at the bottom).
"""
import base64
import json
import os
import time
from pathlib import Path

import ed25519

# What each plan allows. None = unlimited.
PLANS = {
    "free": {"name": "무료", "max_lines": 3, "precise_hints": False, "wav_exports_per_month": None},
    "pro": {"name": "프로", "max_lines": None, "precise_hints": True, "wav_exports_per_month": None},
}

# Only the PUBLIC key is in the program. Keys are signed with the author's private key (tools/make_license.py), so nobody who has
# the program can issue one.
PUBLIC_KEY = bytes.fromhex("2c451dbd320528d1e74394367eee05fe7f25dd5131dcf7d144909e568d3da2c3")
_ROOT = Path(__file__).resolve().parent.parent
INSTALLED = (_ROOT / "installed.flag").exists()


def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def _unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def make_key(seed: bytes, plan: str = "pro", owner: str = "", days: int = 0) -> str:
    """Issue a licence key: OTM2.<payload>.<signature>. `seed` is the author's private key. `days` = 0 means it never expires."""
    if plan not in PLANS:
        raise ValueError("unknown plan")
    payload = {"p": plan, "o": owner, "e": int(time.time() + days * 86400) if days else 0}
    body = _b64(json.dumps(payload, separators=(",", ":")).encode())
    return "OTM2.%s.%s" % (body, _b64(ed25519.sign(seed, body.encode())))


def read_key(key: str):
    """-> payload dict or raise ValueError with a message that can be shown to the user."""
    parts = (key or "").strip().split(".")
    if len(parts) != 3 or parts[0] != "OTM2":
        raise ValueError("라이선스 키 모양이 아니에요")
    try:
        ok = ed25519.verify(PUBLIC_KEY, parts[1].encode(), _unb64(parts[2]))
    except Exception:  # noqa: BLE001
        ok = False
    if not ok:
        raise ValueError("라이선스 키가 올바르지 않아요")
    try:
        payload = json.loads(_unb64(parts[1]))
    except Exception as ex:  # noqa: BLE001
        raise ValueError("라이선스 키를 읽지 못했어요") from ex
    if payload.get("p") not in PLANS:
        raise ValueError("알 수 없는 플랜이에요")
    if payload.get("e") and payload["e"] < time.time():
        raise ValueError("라이선스 기간이 끝났어요")
    return payload


def current_plan(data_dir) -> dict:
    """The plan in force on this machine: OTOMAD_PLAN (for development) > saved licence key > free."""
    name, owner = "free", ""
    forced = None if INSTALLED else os.environ.get("OTOMAD_PLAN")  # a development switch: ignored in the installed program
    is_forced = forced in PLANS
    if forced in PLANS:
        name = forced
    else:
        f = data_dir / "license.json"
        if f.exists():
            try:
                p = read_key(json.loads(f.read_text(encoding="utf-8")).get("key", ""))
                name, owner = p["p"], p.get("o", "")
            except Exception:  # noqa: BLE001  (a broken or expired key just means free)
                pass
    return {"plan": name, "owner": owner, "forced": is_forced, "limits": PLANS[name], "all": PLANS}


def activate(data_dir, key: str) -> dict:
    p = read_key(key)
    (data_dir / "license.json").write_text(json.dumps({"key": key.strip()}), encoding="utf-8")
    return current_plan(data_dir)


def deactivate(data_dir) -> dict:
    f = data_dir / "license.json"
    if f.exists():
        f.unlink()
    return current_plan(data_dir)


# --- for the web version (not used locally) --------------------------------------------------------------------------------------
# WAV export limits by token: give each account a monthly token balance (free: a few, pro: more or unlimited), spend one token in
# `check_export(account)` right before the server returns a rendered WAV, and refuse with HTTP 402 when the balance is zero.
def check_export(account) -> bool:  # pragma: no cover
    raise NotImplementedError("web version only")
