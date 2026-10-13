#!/usr/bin/env bash
#
# One-command local bring-up (SRS §9.1).
#
#   1. ensure .env + development TLS certificate exist
#   2. start the infra services (postgres, redis, ipfs, anvil) and the edge
#   3. wait for readiness
#   4. apply Prisma migrations, then the RLS policies/grants
#   5. deploy AssetLicenseRegistry.sol to Anvil and publish its address
#
# Afterwards run `pnpm dev` for api/worker/web in watch mode.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

info() { printf '\033[1;36m[dev:up]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[dev:up]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[dev:up]\033[0m %s\n' "$*" >&2; exit 1; }

# --- 1. environment file ----------------------------------------------------
if [ ! -f .env ]; then
  info "creating .env from .env.example"
  cp .env.example .env
fi

if [ ! -f docker/certs/void-space.crt ]; then
  info "generating development TLS certificate"
  bash docker/scripts/gen-dev-certs.sh
fi

# --- 2. containers ----------------------------------------------------------
info "starting infra + edge (postgres, redis, ipfs, anvil, nginx)"
docker compose --profile infra --profile edge up -d

# --- 3. readiness -----------------------------------------------------------
wait_for_service() {
  local service="$1" probe="$2" attempts="${3:-60}"
  info "waiting for ${service} to become ready"
  for _ in $(seq 1 "${attempts}"); do
    if docker compose exec -T "${service}" sh -c "${probe}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  docker compose logs --tail=40 "${service}" || true
  fail "${service} did not become ready in time"
}

wait_for_service postgres "pg_isready -U ${POSTGRES_USER:-voidspace} -d ${POSTGRES_DB:-voidspace}"
wait_for_service redis "redis-cli ping"
wait_for_service anvil "cast block-number --rpc-url http://localhost:8545"

# --- 4. database ------------------------------------------------------------
info "generating Prisma client"
pnpm --silent db:generate

info "applying database migrations"
pnpm --silent db:migrate

info "applying Row-Level Security policies and grants"
pnpm --silent db:rls

# --- 5. smart contract ------------------------------------------------------
CONTRACT_STATE="${ROOT_DIR}/packages/contracts/.contracts-state.json"
if [ -f "${CONTRACT_STATE}" ] && ! grep -q '^CONTRACT_ADDRESS=$' .env 2>/dev/null; then
  info "contract already deployed (delete ${CONTRACT_STATE##*/} to redeploy)"
else
  if command -v forge >/dev/null 2>&1; then
    info "deploying AssetLicenseRegistry.sol to Anvil (native forge)"
    ANVIL_RPC_URL="http://localhost:${ANVIL_PORT:-8545}" \
      CONTRACT_STATE_PATH="${CONTRACT_STATE}" \
      bash packages/contracts/scripts/docker-deploy.sh
  else
    info "deploying AssetLicenseRegistry.sol to Anvil (foundry container)"
    docker compose run --rm deploy-contracts
    # The container writes to the shared volume; mirror it into the repo.
    docker compose run --rm --entrypoint sh deploy-contracts \
      -c "cat /shared/contracts.json" > "${CONTRACT_STATE}"
  fi
fi

# Publish the address into .env for native api/worker (§9.3 step 3).
if [ -f "${CONTRACT_STATE}" ]; then
  CONTRACT_ADDRESS="$(node -e "process.stdout.write(require('${CONTRACT_STATE}').contractAddress || '')")"
  if [ -n "${CONTRACT_ADDRESS}" ]; then
    tmp="$(mktemp)"
    awk -v v="${CONTRACT_ADDRESS}" '
      BEGIN { done = 0 }
      /^CONTRACT_ADDRESS=/ { print "CONTRACT_ADDRESS=" v; done = 1; next }
      { print }
      END { if (!done) print "CONTRACT_ADDRESS=" v }
    ' .env > "${tmp}"
    mv "${tmp}" .env
    info "CONTRACT_ADDRESS=${CONTRACT_ADDRESS} written to .env"
  fi
fi

cat <<'EOF'

  ✔ local stack is up.

    next:  pnpm dev         # api + worker + web in watch mode
           pnpm db:seed     # demo tenant, users and sample assets

    edge:  https://localhost            (self-signed certificate)
           https://localhost/api/v1/health
    ipfs:  http://localhost:8080/ipfs/<cid>   (cached by nginx)

EOF
