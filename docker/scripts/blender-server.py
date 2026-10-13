#!/usr/bin/env python3
"""HTTP wrapper around the Blender optimiser (FR-6.3).

Why this exists: `blender-optimize.py` is a CLI script, and the only things that can drive a CLI
are a shell and a sibling container's entrypoint. The worker *needs* to drive it — that is what
FR-6.3 asks for — and a worker container has no Docker socket, deliberately. So the runner has to
speak something a sibling can reach, and HTTP over the Compose network is that something.

    POST /optimize   {input, output, budget, format, generateLods}  ->  the result JSON
    GET  /health                                                     ->  liveness

`input` and `output` are **filenames inside the shared `blenderjobs` volume**, not absolute paths —
the runner resolves each against its own `BLENDER_JOB_DIR`. The worker writes the source and reads
the derivative directly, so no bytes travel over HTTP, and neither side has to know where the other
has mounted the volume.

That indirection is load-bearing. With absolute paths the worker's value had to be valid in this
container's namespace as well as its own, so the two mounts had to agree *exactly* — and when they
did not (worker `/var/lib/void-space/blender-jobs`, runner `/jobs`), every real conversion failed
with a 400 from the path check, while the simulated path hid it by never calling the runner at all.
Names make the shared thing a filename rather than a mount point, which is a much smaller contract
and the only part either container genuinely needs to agree on.

Deliberately stdlib only — `http.server` and `subprocess`. Adding Flask or FastAPI to an image
whose whole cost is Blender would be a dependency for four lines of routing.

One process at a time, enforced by the lock: Blender is CPU-bound and the queue's
`defaultConcurrency` for `blender-optimize` is 1 for the same reason. Concurrent requests would
thrash a laptop, so the second waits rather than both running slowly.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SCRIPT = os.environ.get("BLENDER_OPTIMIZE_SCRIPT", "/opt/void-space/blender-optimize.py")
JOB_DIR = os.environ.get("BLENDER_JOB_DIR", "/var/lib/void-space/blender-jobs")
PORT = int(os.environ.get("BLENDER_PORT", "8090"))
TIMEOUT_SECONDS = int(os.environ.get("BLENDER_TIMEOUT_SECONDS", "900"))

# The character set the worker's generated names use (`<versionId>-source.glb`, `<versionId>-optimized.glb`):
# letters, digits, dot, underscore, hyphen. No separator, so a match cannot name a path or a file in
# a subdirectory.
_JOB_FILENAME = re.compile(r"^[A-Za-z0-9._-]+$")


def _resolve(field: str, name: object) -> str:
    """Resolve a job filename against JOB_DIR, or raise ValueError.

    Three checks, and each catches something the others cannot:

    1. **The pattern** refuses a separator or an absolute path, so the common traversal shapes never
       reach the filesystem at all.
    2. **`.` and `..`** are refused explicitly, and that is not redundant: a filename may contain
       dots, so both satisfy the pattern above, and both would resolve outside JOB_DIR. They are the
       only two values in that character set that do. Caught here so that every rejection a caller
       sees states the rule it broke — "must be a filename" is true of `..` in a way that "must be
       inside" only implies.
    3. **`realpath`** is the backstop the first two cannot replace: a symlink planted in the volume
       passes any string check, and the volume is writable by the worker. This is also the check that
       makes the guarantee hold when JOB_DIR itself is reached through a symlink.
    """
    if not isinstance(name, str) or not _JOB_FILENAME.match(name) or name in ('.', '..'):
        raise ValueError(f"{field} must be a filename inside {JOB_DIR}, not a path")

    path = os.path.realpath(os.path.join(JOB_DIR, name))
    if not path.startswith(os.path.realpath(JOB_DIR) + os.sep):
        raise ValueError(f"{field} must be inside {JOB_DIR}")
    return path


# One Blender process at a time; see the module docstring.
_blender_lock = threading.Lock()


def _run_optimize(payload: dict) -> tuple[int, dict]:
    """Shell out to the optimiser and return (exit_code, parsed_result)."""
    argv = [
        "blender",
        "--background",
        "--factory-startup",
        "--python",
        SCRIPT,
        "--",
        "--input",
        str(payload["input"]),
        "--output",
        str(payload["output"]),
        "--budget",
        str(int(payload.get("budget") or 0)),
        "--format",
        str(payload.get("format") or "glb"),
    ]
    if payload.get("generateLods"):
        argv.append("--generate-lods")

    completed = subprocess.run(  # noqa: S603 - argv is built here, never interpolated from input
        argv,
        capture_output=True,
        text=True,
        timeout=TIMEOUT_SECONDS,
        check=False,
    )

    # The script prints one machine-readable line; Blender's own chatter shares the same streams,
    # so the result is located by its prefix rather than by assuming it is the last line.
    result = None
    for line in completed.stdout.splitlines():
        if line.startswith("VOID_SPACE_RESULT "):
            try:
                result = json.loads(line[len("VOID_SPACE_RESULT ") :])
            except json.JSONDecodeError:
                result = None

    if result is None:
        result = {
            "ok": False,
            "error": (completed.stderr or completed.stdout or "no result line from the optimiser")[-600:],
        }
    return completed.returncode, result


class Handler(BaseHTTPRequestHandler):
    server_version = "void-space-blender/1.0"

    def _send(self, status: int, body: dict) -> None:
        encoded = json.dumps(body).encode("utf8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler's naming
        if self.path == "/health":
            self._send(200, {"status": "ok", "jobDir": JOB_DIR})
            return
        self._send(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/optimize":
            self._send(404, {"error": "not found"})
            return

        length = int(self.headers.get("content-length") or 0)
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            self._send(400, {"error": "body is not JSON"})
            return

        # `input` and `output` arrive as filenames and are resolved against this container's JOB_DIR.
        # Nothing the caller sends is ever used as a path directly — see `_resolve` for why that is a
        # smaller contract than two containers agreeing on a mount point.
        try:
            payload["input"] = _resolve("input", payload.get("input"))
            payload["output"] = _resolve("output", payload.get("output"))
        except ValueError as exc:
            self._send(400, {"error": str(exc)})
            return

        try:
            with _blender_lock:
                _code, result = _run_optimize(payload)
        except subprocess.TimeoutExpired:
            self._send(504, {"ok": False, "error": f"blender exceeded {TIMEOUT_SECONDS}s"})
            return
        except OSError as exc:
            self._send(500, {"ok": False, "error": f"could not start blender: {exc}"})
            return

        self._send(200 if result.get("ok") else 422, result)

    def log_message(self, fmt: str, *args: object) -> None:
        # Blender is chatty enough; the access log would be noise in `docker compose logs`.
        sys.stderr.write("[blender-server] " + (fmt % args) + "\n")


def main() -> int:
    if not os.path.isfile(SCRIPT):
        print(f"[blender-server] optimiser script missing: {SCRIPT}", file=sys.stderr)
        return 1
    os.makedirs(JOB_DIR, exist_ok=True)
    print(f"[blender-server] listening on :{PORT}, job dir {JOB_DIR}", file=sys.stderr)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
