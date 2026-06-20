from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

WORKDIR = Path(r"C:\Users\john\src\github.com\johnhalbert\symphony\symphony_workspaces\ENG-404")
LOG_DIR = WORKDIR / ".tmp"
LOG_DIR.mkdir(parents=True, exist_ok=True)
LOG_PATH = LOG_DIR / "eng-404-focused-tests.log"
NODE = Path(r"C:\Program Files\nodejs\node.exe")
VITEST = WORKDIR.parent.parent / "node_modules" / "vitest" / "vitest.mjs"
COMMAND = [
    str(NODE),
    str(VITEST),
    "run",
    "--no-file-parallelism",
    "tests/orchestrator-project-context-dispatch.test.ts",
    "tests/handoff-mcp.test.ts",
]

result = subprocess.run(
    COMMAND,
    cwd=str(WORKDIR),
    capture_output=True,
    text=True,
)
combined = (result.stdout or "") + (("\n" + result.stderr) if result.stderr else "")
LOG_PATH.write_text(combined, encoding="utf-8")
print(json.dumps({
    "command": COMMAND,
    "cwd": str(WORKDIR),
    "exit_code": result.returncode,
    "log_path": str(LOG_PATH),
    "stdout_tail": (result.stdout or "")[-4000:],
    "stderr_tail": (result.stderr or "")[-4000:],
}, ensure_ascii=False))
