"""Local server for Vomix Studio. Run: python -m uvicorn server:app --port 8765"""
import json
import re
from pathlib import Path

from fastapi import Body, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

import engine
import plan

app = FastAPI()
HERE = Path(__file__).resolve().parent
DATA = engine.DATA


def _safe_name(name):
    name = Path(name).name  # drop any directory part
    if not name or name.startswith("."):
        raise HTTPException(400, "bad file name")
    return name


# ------------------------------------------------------------------ samples
@app.post("/api/samples")
async def add_sample(file: UploadFile = File(...)):
    name = _safe_name(file.filename or "")
    path = DATA / "samples" / name
    path.write_bytes(await file.read())
    engine._audio.pop(name, None)
    for k in [k for k in engine._voices if k[0] == name]:
        engine._voices.pop(k, None)
    try:
        info = engine.analyze_sample(path)
    except Exception as ex:  # noqa: BLE001
        path.unlink(missing_ok=True)
        raise HTTPException(400, "오디오를 읽을 수 없어요: " + str(ex))
    return {"file": name, **info}


@app.get("/api/samples/{file}/audio")
def sample_audio(file: str):
    p = DATA / "samples" / _safe_name(file)
    if not p.exists():
        raise HTTPException(404)
    return FileResponse(p)


@app.post("/api/sample-contour")
def sample_contour(spec: dict = Body(...)):
    try:
        return engine.contour(spec)
    except Exception as ex:  # noqa: BLE001
        raise HTTPException(400, str(ex))


@app.post("/api/sample-split")
def sample_split(spec: dict = Body(...)):
    try:
        if spec.get("mode") == "syllable":
            return {"parts": engine.split_syllables(spec)}
        return {"parts": engine.split_by_pitch(spec)}
    except Exception as ex:  # noqa: BLE001
        raise HTTPException(400, str(ex))


@app.post("/api/sample-info")
def sample_info(spec: dict = Body(...)):
    try:
        return engine.voice_info(spec)
    except Exception as ex:  # noqa: BLE001
        raise HTTPException(400, str(ex))


# ------------------------------------------------------------------- render
@app.post("/api/export-pack")
def export_pack(payload: dict = Body(...)):
    """Zip for other programs: MIDI, note list, WAV of every line and of the whole song. payload = {render: <render payload>, meta: {bpm, lines:[{id, name, notes}]}, midi, csv, lines, mix}"""
    import exporter
    rp = payload.get("render") or {}

    def render(target):
        try:
            return engine.render({**rp, "target": target})
        except Exception as ex:  # noqa: BLE001
            raise HTTPException(400, "렌더 실패: " + str(ex))
    try:
        data = exporter.make_pack(payload["meta"], render, bool(payload.get("midi", True)), bool(payload.get("csv", True)),
                                  bool(payload.get("lines", True)), bool(payload.get("mix", True)))
    except HTTPException:
        raise
    except Exception as ex:  # noqa: BLE001
        raise HTTPException(400, "내보내기 실패: " + str(ex))
    return Response(data, media_type="application/zip", headers={"Content-Disposition": 'attachment; filename="vomix-export.zip"'})


@app.post("/api/render")
def render(payload: dict = Body(...)):
    try:
        wav = engine.render(payload)
    except Exception as ex:  # noqa: BLE001
        raise HTTPException(400, "렌더 실패: " + str(ex))
    return Response(wav, media_type="audio/wav")


# ---------------------------------------------------------------- reference
# ---------------------------------------------------------------- liveness (the launcher stops the server when the window is gone)
LAST_PING = {"t": None}


@app.get("/api/alive")
def alive(probe: int = 0):
    """The page pings this every few seconds. The launcher asks with probe=1: that does not count as a ping and says how long ago the
    last real ping was, so a second launch can tell whether a window is open."""
    import time as _t
    if probe:
        t = LAST_PING["t"]
        return {"app": "vomix", "ok": True, "age": None if t is None else round(_t.time() - t, 1)}
    LAST_PING["t"] = _t.time()
    return {"app": "vomix", "ok": True}


# ---------------------------------------------------------------- plan (free / pro)
@app.get("/api/plan")
def get_plan():
    return plan.current_plan(DATA)


@app.post("/api/plan/activate")
def plan_activate(body: dict = Body(...)):
    try:
        return plan.activate(DATA, str(body.get("key", "")))
    except ValueError as ex:
        raise HTTPException(400, str(ex))


@app.post("/api/plan/deactivate")
def plan_deactivate():
    return plan.deactivate(DATA)


def _need_precise(model: str):
    if model not in ("htdemucs", "htdemucs_6s") and not plan.current_plan(DATA)["limits"]["precise_hints"]:
        raise HTTPException(403, "정밀 참조곡 힌트는 프로 플랜에서 쓸 수 있어요")


@app.post("/api/reference")
async def add_reference(file: UploadFile = File(...), model: str = Form(engine.DEFAULT_MODEL)):
    _need_precise(model)
    data = await file.read()
    h = engine.start_reference(data, _safe_name(file.filename or "reference.mp3"), model)
    return {"id": h}


@app.get("/api/reference/{rid}/status")
def ref_status(rid: str):
    if not re.fullmatch(r"[0-9a-f]{12}", rid):
        raise HTTPException(400)
    job = engine.JOBS.get(rid)
    if job is None:
        if (DATA / "refs" / rid / "analysis.json").exists():
            return {"status": "done", "phase": "완료"}
        raise HTTPException(404)
    import time
    return {"status": job["status"], "phase": job["phase"], "elapsed": round(time.time() - job["started"])}


@app.get("/api/reference/{rid}")
def ref_result(rid: str):
    if not re.fullmatch(r"[0-9a-f]{12}", rid):
        raise HTTPException(400)
    p = DATA / "refs" / rid / "analysis.json"
    if not p.exists():
        raise HTTPException(404)
    return JSONResponse(engine.migrate_levels(rid))


@app.post("/api/reference/{rid}/reanalyze")
def ref_reanalyze(rid: str, model: str = engine.DEFAULT_MODEL):
    _need_precise(model)
    if not re.fullmatch(r"[0-9a-f]{12}", rid):
        raise HTTPException(400)
    try:
        return {"id": engine.restart_reference(rid, model)}
    except ValueError as ex:
        raise HTTPException(400, str(ex))


@app.post("/api/reference/{rid}/analyze/{stem}")
def ref_analyze(rid: str, stem: str):
    if not re.fullmatch(r"[0-9a-f]{12}", rid) or not re.fullmatch(r"[a-z0-9_\-]{1,40}", stem):
        raise HTTPException(400)
    try:
        return JSONResponse(engine.analyze_on_demand(rid, stem))
    except ValueError as ex:
        raise HTTPException(400, str(ex))


@app.post("/api/reference/{rid}/fill/{stem}")
def ref_fill(rid: str, stem: str):
    """Fill the places a stem's transcription missed with notes cut from the measured pitch line."""
    if not re.fullmatch(r"[0-9a-f]{12}", rid) or not re.fullmatch(r"[a-z0-9_\-]{1,40}", stem):
        raise HTTPException(400)
    try:
        return JSONResponse(engine.fill_gaps(rid, stem))
    except ValueError as ex:
        raise HTTPException(400, str(ex))


@app.get("/api/reference/{rid}/audio")
def ref_audio(rid: str):
    if not re.fullmatch(r"[0-9a-f]{12}", rid):
        raise HTTPException(400)
    files = list((DATA / "refs" / rid).glob("orig.*"))
    if not files:
        raise HTTPException(404)
    return FileResponse(files[0])


@app.get("/api/reference/{rid}/note/{stem}")
def ref_note(rid: str, stem: str, t: float, l: float, p: float):
    """One note cut out of a stem (other notes sounding at the same time are turned down)."""
    if not re.fullmatch(r"[0-9a-f]{12}", rid) or not re.fullmatch(r"[a-z0-9_\-]{1,40}", stem):
        raise HTTPException(400)
    try:
        data = engine.isolate_note(rid, stem, t, max(0.05, min(l, 8.0)), p)
    except ValueError as ex:
        raise HTTPException(400, str(ex))
    return Response(data, media_type="audio/wav")


@app.get("/api/reference/{rid}/syllables/{stem}")
def ref_syllables(rid: str, stem: str, t0: float, t1: float):
    """Syllable pieces (speech rhythm) of a stretch of a stem: [{a, b}] in seconds of the song."""
    if not re.fullmatch(r"[0-9a-f]{12}", rid) or not re.fullmatch(r"[a-z0-9_\-]{1,40}", stem):
        raise HTTPException(400)
    if t1 - t0 > 600 or t1 <= t0:
        raise HTTPException(400, "bad range")
    try:
        return {"segs": [{"a": a, "b": b, "pitch": p} for a, b, p in engine.stem_syllables(rid, stem, t0, t1)]}
    except Exception as ex:  # noqa: BLE001
        raise HTTPException(400, str(ex))


@app.get("/api/reference/{rid}/stem/{stem}")
def ref_stem(rid: str, stem: str):
    if not re.fullmatch(r"[0-9a-f]{12}", rid) or not re.fullmatch(r"[a-z0-9_\-]{1,40}", stem):
        raise HTTPException(400)
    p = DATA / "refs" / rid / "stems" / (stem + ".wav")
    if not p.exists():
        raise HTTPException(404)
    return FileResponse(p, media_type="audio/wav")


# ------------------------------------------------------------------ project
@app.get("/api/project")
def get_project():
    p = DATA / "project.json"
    if not p.exists():
        return JSONResponse(None)
    return JSONResponse(json.loads(p.read_text(encoding="utf-8")))


@app.post("/api/project")
def save_project(project: dict = Body(...)):
    (DATA / "project.json").write_text(json.dumps(project, ensure_ascii=False), encoding="utf-8")
    return {"ok": True}


@app.middleware("http")
async def no_cache(request, call_next):
    # the browser must always fetch the newest page code (otherwise an old app.js can keep running after an update)
    resp = await call_next(request)
    if not request.url.path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-store"
    return resp


app.mount("/", StaticFiles(directory=str(HERE / "static"), html=True), name="static")
