#!/usr/bin/env bash
# Entrypoint for the optional Blender runner container (FR-6.3).
#
# A manual, one-shot path for a single conversion. The queue does NOT use this: the worker has no
# Docker socket, so it drives the long-running service in `blender-server.py` over HTTP instead.
# Keep the two invocations in step when the optimiser's flags change.
#
# Job files live under $BLENDER_JOB_DIR (the volume shared with the worker) — so pass paths inside it.
# Usage: blender-entrypoint.sh --input "$BLENDER_JOB_DIR/in.blend" --output "$BLENDER_JOB_DIR/out.glb" [--budget 50000]
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: blender-entrypoint.sh --input <file> --output <file> [--budget N] [--format glb]" >&2
  exit 2
fi

exec blender --background --factory-startup --python /opt/void-space/blender-optimize.py -- "$@"
