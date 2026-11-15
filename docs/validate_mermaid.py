"""Validasi semua blok mermaid di docs dengan benar-benar merendernya (mmdc).

Cara pakai:
    python validate_mermaid.py README.md docs/ARCHITECTURE.md
Keluar 0 bila semua diagram valid.
"""

from __future__ import annotations

import re
import subprocess
import sys
import tempfile
from pathlib import Path

CHROME = "/home/kazu/.cache/puppeteer/chrome/linux-154.0.8037.57/chrome-linux64/chrome"
MMDC = "/home/kazu/.nvm/versions/node/v24.21.0/bin/mmdc"
PUPPETEER_CFG = "/home/kazu/.hermes/cache/scratch/puppeteer-config.json"

BLOCK_RE = re.compile(r"```mermaid\n(.*?)```", re.DOTALL)


def render(code: str, out: Path) -> tuple[bool, str]:
    with tempfile.NamedTemporaryFile("w", suffix=".mmd", delete=False) as f:
        f.write(code)
        src = f.name
    env = {
        "PUPPETEER_EXECUTABLE_PATH": CHROME,
        "PATH": "/home/kazu/.nvm/versions/node/v24.21.0/bin:/usr/bin:/bin",
    }
    proc = subprocess.run(
        [MMDC, "-i", src, "-o", str(out), "-p", PUPPETEER_CFG],
        capture_output=True,
        text=True,
        env=env,
        timeout=120,
    )
    ok = proc.returncode == 0 and out.exists() and out.stat().st_size > 0
    return ok, (proc.stderr or proc.stdout)[-500:]


def main(paths: list[str]) -> int:
    total = 0
    failed = 0
    for p in paths:
        text = Path(p).read_text(encoding="utf-8")
        blocks = BLOCK_RE.findall(text)
        if not blocks:
            print(f"[skip] {p}: tidak ada blok mermaid")
            continue
        for i, code in enumerate(blocks, 1):
            total += 1
            out = Path(tempfile.mkdtemp()) / "out.svg"
            ok, err = render(code, out)
            status = "OK  " if ok else "FAIL"
            print(f"[{status}] {p} #{i}")
            if not ok:
                failed += 1
                print("       ", err.replace("\n", " ")[:300])
    print(f"\n{total - failed}/{total} diagram valid.")
    return 1 if failed else 0


if __name__ == "__main__":
    args = sys.argv[1:] or ["README.md", "docs/ARCHITECTURE.md"]
    sys.exit(main(args))
