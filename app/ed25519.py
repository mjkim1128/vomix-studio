"""Ed25519 signatures (RFC 8032), pure Python, no dependency.

Licence keys are signed with a PRIVATE key that only the author holds (tools/make_license.py); the program ships only the PUBLIC key,
so nobody who has the program can issue a key.
"""
import hashlib

P = 2 ** 255 - 19
Q = 2 ** 252 + 27742317777372353535851937790883648493
D = -121665 * pow(121666, P - 2, P) % P
I = pow(2, (P - 1) // 4, P)


def _inv(x):
    return pow(x, P - 2, P)


def _xrecover(y):
    xx = (y * y - 1) * _inv(D * y * y + 1)
    x = pow(xx, (P + 3) // 8, P)
    if (x * x - xx) % P != 0:
        x = x * I % P
    if x % 2 != 0:
        x = P - x
    return x


_BY = 4 * _inv(5) % P
_B = (_xrecover(_BY) % P, _BY % P)


def _add(a, b):
    x1, y1 = a
    x2, y2 = b
    t = D * x1 * x2 * y1 * y2
    return ((x1 * y2 + x2 * y1) * _inv(1 + t) % P, (y1 * y2 + x1 * x2) * _inv(1 - t) % P)


def _mul(pt, e):
    r = (0, 1)
    while e:
        if e & 1:
            r = _add(r, pt)
        pt = _add(pt, pt)
        e >>= 1
    return r


def _enc(pt):
    x, y = pt
    return (y | ((x & 1) << 255)).to_bytes(32, "little")


def _dec(s):
    if len(s) != 32:
        raise ValueError("bad point")
    y = int.from_bytes(s, "little")
    sign = y >> 255
    y &= (1 << 255) - 1
    if y >= P:
        raise ValueError("bad point")
    x = _xrecover(y)
    if x & 1 != sign:
        x = P - x
    pt = (x, y)
    if (-pt[0] * pt[0] + pt[1] * pt[1] - 1 - D * pt[0] * pt[0] * pt[1] * pt[1]) % P != 0:
        raise ValueError("not on curve")
    return pt


def _h(m):
    return int.from_bytes(hashlib.sha512(m).digest(), "little")


def _secret_scalar(seed):
    h = hashlib.sha512(seed).digest()
    a = int.from_bytes(h[:32], "little")
    a &= (1 << 254) - 8
    a |= 1 << 254
    return a, h[32:]


def public_key(seed: bytes) -> bytes:
    a, _ = _secret_scalar(seed)
    return _enc(_mul(_B, a))


def sign(seed: bytes, msg: bytes) -> bytes:
    a, prefix = _secret_scalar(seed)
    pk = _enc(_mul(_B, a))
    r = _h(prefix + msg) % Q
    rr = _enc(_mul(_B, r))
    s = (r + _h(rr + pk + msg) * a) % Q
    return rr + s.to_bytes(32, "little")


def verify(pk: bytes, msg: bytes, sig: bytes) -> bool:
    try:
        if len(sig) != 64 or len(pk) != 32:
            return False
        r = _dec(sig[:32])
        a = _dec(pk)
        s = int.from_bytes(sig[32:], "little")
        if s >= Q:
            return False
        k = _h(sig[:32] + pk + msg) % Q
        return _mul(_B, s) == _add(r, _mul(a, k))
    except Exception:  # noqa: BLE001
        return False
