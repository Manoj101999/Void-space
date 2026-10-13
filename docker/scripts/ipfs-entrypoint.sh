#!/usr/bin/env sh
#
# Kubo (IPFS) entrypoint for local development (SRS §3.8).
# Idempotent: initialises the repo on first run, then applies the settings the
# platform depends on — HTTP API reachable from the Docker network, gateway
# reachable through nginx, and CORS allowed for browser-side gateway reads.
set -eu

IPFS_PATH="${IPFS_PATH:-/data/ipfs}"
export IPFS_PATH

if [ ! -f "${IPFS_PATH}/config" ]; then
  echo "[ipfs] initialising repo at ${IPFS_PATH}"
  ipfs init --profile=server --empty-repo >/dev/null
else
  echo "[ipfs] existing repo found at ${IPFS_PATH}"
fi

# Serve the API to the whole Docker network (api/worker are separate containers)
ipfs config Addresses.API /ip4/0.0.0.0/tcp/5001
# Gateway is only ever consumed by nginx (FR-8.3 — the node is never exposed raw)
ipfs config Addresses.Gateway /ip4/0.0.0.0/tcp/8080

# Local-only origins, permissive enough for the dev web app and nginx.
ipfs config --json API.HTTPHeaders.Access-Control-Allow-Origin '["http://localhost:3000","http://localhost","https://localhost"]'
ipfs config --json API.HTTPHeaders.Access-Control-Allow-Methods '["PUT","POST","GET"]'
ipfs config --json Gateway.HTTPHeaders.Access-Control-Allow-Origin '["*"]'

# Serve /ipfs/<cid> directly instead of 301-redirecting to <cid>.ipfs.localhost.
# The subdomain form would require wildcard DNS and a wildcard certificate, and
# it would defeat the nginx gateway cache keyed on /ipfs/<cid> (FR-8.3,
# NFR-PERF.4). The gateway is only ever reached through nginx, never by clients.
#
# `DeserializedResponses: true` is required for ordinary (non-trustless) GETs:
# with it disabled, Kubo answers 406 and only serves ?format=raw/CAR requests,
# which no browser or three.js loader issues.
ipfs config --json Gateway.PublicGateways '{
  "localhost": {
    "Paths": ["/ipfs", "/ipns"],
    "UseSubdomains": false,
    "DeserializedResponses": true
  }
}'

# 200 MB asset ceiling (FR-3.1) plus generous chunk sizing for large uploads.
ipfs config --json Datastore.StorageMax '"100GB"'

echo "[ipfs] starting daemon"
exec ipfs daemon --migrate=true
