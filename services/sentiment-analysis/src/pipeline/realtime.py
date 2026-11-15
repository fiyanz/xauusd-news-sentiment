"""Pipeline realtime: update data + model secara berkala.

Menjalankan siklus pipeline (price -> berita -> bucket -> retrain -> predict)
berulang dengan jeda yang bisa dikonfigurasi, sehingga data dan model selalu
terbaru tanpa menunggu trigger manual.

Mode:
- ``interval``: loop berulang (default), dipakai untuk pemantauan realtime.
- satu kali: cukup panggil ``run_full_sync()`` dari ``src.pipeline.sync``.

Loop berhenti dengan anggun pada KeyboardInterrupt (Ctrl+C) dan mencatat
status terakhir ke ``data/processed/realtime_status.json``.
"""

import json
import sys
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path

_repo_service_dir = Path(__file__).resolve().parents[2]
if str(_repo_service_dir) not in sys.path:
    sys.path.insert(0, str(_repo_service_dir))

from src.pipeline.sync import run_full_sync

STATUS_PATH = "data/processed/realtime_status.json"


def _write_status(payload: dict) -> None:
    try:
        Path(STATUS_PATH).parent.mkdir(parents=True, exist_ok=True)
        with open(STATUS_PATH, "w") as f:
            json.dump(payload, f, indent=2, default=str)
    except OSError:
        pass


def run_realtime_loop(
    interval_seconds: int = 1800,
    max_cycles: int | None = None,
    write_prediction: bool = True,
) -> None:
    """Jalankan pipeline berulang.

    Args:
        interval_seconds: jeda antar siklus (default 30 menit).
        max_cycles: batas siklus (None = tanpa batas).
        write_prediction: tulis prediksi live tiap siklus.
    """
    print("=" * 60)
    print(f"[RealtimePipeline] Mulai. Interval {interval_seconds}s, "
          f"maks siklus={max_cycles or 'tak terbatas'}")
    print("=" * 60)

    cycle = 0
    while max_cycles is None or cycle < max_cycles:
        cycle += 1
        started = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
        print(f"\n[RealtimePipeline] === Siklus {cycle} @ {started} ===")
        _write_status({
            "status": "running",
            "cycle": cycle,
            "started_at": started,
            "interval_seconds": interval_seconds,
        })

        try:
            result = run_full_sync(write_prediction=write_prediction)
            prediction = result.get("prediction") or {}
            _write_status({
                "status": "ok",
                "cycle": cycle,
                "started_at": started,
                "finished_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC"),
                "prediction_status": prediction.get("status"),
                "signal": prediction.get("signal"),
                "predicted_target_price": prediction.get("predicted_target_price"),
            })
            print(f"[RealtimePipeline] Siklus {cycle} selesai: {prediction.get('status')}")
        except Exception as exc:  # noqa: BLE001 - jangan matikan loop
            print(f"[RealtimePipeline] Siklus {cycle} gagal: {type(exc).__name__}: {exc}")
            traceback.print_exc()
            _write_status({
                "status": "error",
                "cycle": cycle,
                "started_at": started,
                "error": f"{type(exc).__name__}: {exc}",
            })

        if max_cycles is not None and cycle >= max_cycles:
            break
        print(f"[RealtimePipeline] Tidur {interval_seconds}s...")
        try:
            time.sleep(interval_seconds)
        except KeyboardInterrupt:
            print("\n[RealtimePipeline] Dihentikan (Ctrl+C).")
            _write_status({
                "status": "stopped",
                "cycle": cycle,
                "stopped_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC"),
            })
            break


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Pipeline realtime XAUUSD")
    parser.add_argument("--interval", type=int, default=1800, help="jeda antar siklus (detik)")
    parser.add_argument("--max-cycles", type=int, default=None, help="batas jumlah siklus")
    args = parser.parse_args()

    run_realtime_loop(interval_seconds=args.interval, max_cycles=args.max_cycles)
