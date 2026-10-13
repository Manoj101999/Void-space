# ---------------------------------------------------------------------------
# Headless Blender runner (FR-6.3) — OPTIONAL compose profile.
#
# This image is deliberately not part of `pnpm dev:up`: it is large. It is used
# only by the `blender-runner` service (profile "blender") when a
# blender-optimize job needs to convert/optimise a .blend source.
# ---------------------------------------------------------------------------
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
# Where job files live in this container. The worker sends *filenames* and the runner resolves them
# against this directory, so it does not have to match the worker's `BLENDER_JOB_DIR` — the compose
# service aligns them anyway so that a path in a log means the same file in both containers.
ENV BLENDER_JOB_DIR=/var/lib/void-space/blender-jobs

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    blender \
    python3 \
    ca-certificates \
    tini \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/void-space
COPY docker/scripts/blender-optimize.py /opt/void-space/blender-optimize.py
COPY docker/scripts/blender-server.py /opt/void-space/blender-server.py
COPY docker/scripts/blender-entrypoint.sh /opt/void-space/blender-entrypoint.sh
RUN chmod +x /opt/void-space/blender-entrypoint.sh \
  && mkdir -p /var/lib/void-space/blender-jobs \
  && useradd --system --create-home --uid 10001 blender \
  && chown -R blender:blender /opt/void-space /var/lib/void-space

USER blender

# The runner is a *service*, not a one-shot CLI.
#
# `blender-entrypoint.sh` still works for a manual `docker compose run blender-runner --input …`,
# but it cannot be what the worker drives: a worker container has no Docker socket — deliberately —
# so it has no way to exec into a sibling. The queue's job therefore arrives over HTTP, and the
# wrapper in `blender-server.py` is what turns a request into the CLI invocation below.
#
# `EXPOSE` is documentation here; Compose publishes the port on the internal network only.
EXPOSE 8090
ENV BLENDER_PORT=8090
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python3 -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8090/health', timeout=4).status == 200 else 1)"

ENTRYPOINT ["/usr/bin/tini", "--", "python3", "/opt/void-space/blender-server.py"]
