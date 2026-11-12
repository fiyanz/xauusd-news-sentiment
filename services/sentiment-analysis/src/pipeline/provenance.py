"""Provenance manifest helpers shared by the sync and retrain stages."""

import json
from datetime import datetime, timezone
from pathlib import Path


def now_str() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S+00:00")


def merge_provenance(manifest_path: str, entries: list[dict]) -> dict:
    """Merge artifact entries into the provenance manifest on disk.

    ``is_simulated`` is True only when *every* artifact is fully simulated;
    partial simulation is reported through ``has_simulated_rows``.
    """
    now = now_str()
    manifest: dict = {"artifacts": {}, "generated_at": now}
    if Path(manifest_path).exists():
        try:
            with open(manifest_path, "r") as f:
                existing = json.load(f)
            manifest["artifacts"] = existing.get("artifacts", {})
        except (json.JSONDecodeError, OSError):
            pass

    for entry in entries:
        artifact = entry.get("artifact")
        if not artifact:
            # Nested provenance (e.g. price artifacts dict)
            for key, value in entry.get("artifacts", {}).items():
                manifest["artifacts"][key] = value
            continue
        manifest["artifacts"][artifact] = entry

    manifest["generated_at"] = entries[-1]["generated_at"] if entries else manifest.get("generated_at")
    all_sim = bool(manifest["artifacts"]) and all(
        v.get("is_simulated", False) for v in manifest["artifacts"].values()
    )
    manifest["is_simulated"] = all_sim
    manifest["has_simulated_rows"] = any(
        v.get("is_simulated", False) or v.get("rows_real", v.get("rows", 0)) < v.get("rows", 0)
        for v in manifest["artifacts"].values()
    )
    return manifest


def write_provenance(manifest_path: str, manifest: dict) -> None:
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)
