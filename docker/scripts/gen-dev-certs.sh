#!/usr/bin/env bash
#
# Generates a local TLS certificate for the nginx edge (SRS §6.6 — HTTPS/TLS
# terminated at nginx; a self-signed/development certificate is acceptable
# locally). Never commit the output: docker/certs/ is git-ignored.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CERT_DIR="${ROOT_DIR}/docker/certs"
CERT_FILE="${CERT_DIR}/void-space.crt"
KEY_FILE="${CERT_DIR}/void-space.key"

mkdir -p "${CERT_DIR}"

if [ -f "${CERT_FILE}" ] && [ -f "${KEY_FILE}" ]; then
  echo "[certs] certificate already present at ${CERT_DIR} (delete it to regenerate)"
  exit 0
fi

echo "[certs] generating self-signed development certificate for localhost"

# mkcert produces a browser-trusted cert when available; fall back to openssl.
if command -v mkcert >/dev/null 2>&1; then
  mkcert -install >/dev/null 2>&1 || true
  mkcert -cert-file "${CERT_FILE}" -key-file "${KEY_FILE}" localhost "*.localhost" 127.0.0.1 ::1
else
  openssl req -x509 -nodes -newkey rsa:2048 -days 825 \
    -keyout "${KEY_FILE}" \
    -out "${CERT_FILE}" \
    -subj "/C=IN/ST=Local/L=Local/O=VOID SPACE Dev/CN=localhost" \
    -addext "subjectAltName=DNS:localhost,DNS:*.localhost,IP:127.0.0.1,IP:::1" \
    >/dev/null 2>&1
fi

chmod 600 "${KEY_FILE}"
echo "[certs] wrote ${CERT_FILE} and ${KEY_FILE}"
