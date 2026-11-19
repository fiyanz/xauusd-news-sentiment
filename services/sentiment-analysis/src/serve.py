"""HTTP service (FastAPI) untuk sentiment-analysis.

Membungkus pipeline sync sebagai service terpisah sesuai kontrak deploy:

    GET  /health       -> status service
    POST /sync         -> mulai run_full_sync di background (single-flight)
    GET  /sync/status  -> status sync terakhir
    GET  /prediction   -> isi data/processed/latest_prediction.json apa adanya

Jalankan dari direktori service:
    uvicorn src.serve:app --host 0.0.0.0 --port 8000

Logika pipeline TIDAK diubah di sini; serve.py hanya wrapper HTTP.
"""

import json
import os
import threading
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import JSONResponse

# Direktori service (services/sentiment-analysis). Pipeline memakai path
# relatif terhadap cwd (config.yaml, data/...), jadi pastikan cwd selalu di
# sini terlepas dari mana uvicorn dijalankan.
_SERVICE_DIR = Path(__file__).resolve().parents[1]
os.chdir(_SERVICE_DIR)

# Artifact prediksi ditulis pipeline ke data/processed (volume di container).
_PREDICTION_PATH = _SERVICE_DIR / "data" / "processed" / "latest_prediction.json"

app = FastAPI(title="XAUUSD Sentiment Analysis Service", version="0.1.0")

# Lock single-flight cross-request: hanya satu run_full_sync yang boleh
# berjalan pada satu waktu. Lock terpisah melindungi state status yang
# dibaca/ditulis dari beberapa request dan thread sekaligus.
_sync_lock = threading.Lock()
_state_lock = threading.Lock()
_sync_state: dict = {
    "running": False,
    "last_started_at": None,
    "last_finished_at": None,
    "last_result": None,
    "last_error": None,
}


def _now_utc() -> str:
    """Timestamp ISO-8601 UTC untuk field status sync."""
    return datetime.now(timezone.utc).isoformat()


def _run_sync_background() -> None:
    """Worker thread: jalankan pipeline penuh, lalu catat hasil akhirnya.

    Import run_full_sync dilakukan lazy di sini supaya module serve tetap
    ringan saat import (dependency pipeline berat: pandas/sklearn/torch).
    """
    result, error = "error", None
    try:
        from src.pipeline.sync import run_full_sync

        run_full_sync(write_prediction=True)
        result = "success"
    except Exception as exc:  # noqa: BLE001 - error apa pun harus tercatat, bukan men-crash service
        error = f"{type(exc).__name__}: {exc}"
    finally:
        with _state_lock:
            _sync_state["running"] = False
            _sync_state["last_finished_at"] = _now_utc()
            _sync_state["last_result"] = result
            _sync_state["last_error"] = error
        # Lepas lock single-flight hanya setelah state selesai di-update,
        # supaya request berikutnya tidak melihat status setengah jadi.
        _sync_lock.release()


@app.get("/health")
def health() -> dict:
    """Liveness sederhana untuk healthcheck container."""
    return {"status": "ok"}


@app.post("/sync", status_code=202)
def trigger_sync():
    """Mulai sync penuh di background thread; 409 kalau sedang berjalan."""
    # Acquire non-blocking: gagal acquire berarti sync lain masih aktif.
    if not _sync_lock.acquire(blocking=False):
        return JSONResponse({"status": "already_running"}, status_code=409)

    with _state_lock:
        _sync_state["running"] = True
        _sync_state["last_started_at"] = _now_utc()

    try:
        threading.Thread(
            target=_run_sync_background, name="pipeline-sync", daemon=True
        ).start()
    except Exception:
        # Gagal start thread: kembalikan state dan lepas lock supaya
        # service tidak terkunci permanen.
        with _state_lock:
            _sync_state["running"] = False
            _sync_state["last_finished_at"] = _now_utc()
            _sync_state["last_result"] = "error"
            _sync_state["last_error"] = "gagal memulai thread sync"
        _sync_lock.release()
        raise

    return {"status": "accepted"}


@app.get("/sync/status")
def sync_status() -> dict:
    """Status sync terakhir; di-poll worker sampai running=false."""
    with _state_lock:
        return dict(_sync_state)


@app.get("/prediction")
def prediction():
    """Kembalikan isi latest_prediction.json apa adanya, atau 503."""
    try:
        with open(_PREDICTION_PATH, "r", encoding="utf-8") as f:
            payload = json.load(f)
    except FileNotFoundError:
        return JSONResponse(
            {
                "status": "unavailable",
                "reason": "latest_prediction.json belum ada; jalankan POST /sync terlebih dahulu.",
            },
            status_code=503,
        )
    except (OSError, json.JSONDecodeError) as exc:
        return JSONResponse(
            {"status": "unavailable", "reason": f"gagal membaca prediksi: {exc}"},
            status_code=503,
        )
    return JSONResponse(payload)
