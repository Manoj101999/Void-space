#!/usr/bin/env bash
#
# Deploy AssetLicenseRegistry.sol to the local Anvil chain and publish the
# resulting address + ABI where api and worker can read them (SRS §9.3).
#
# Runs inside the deploy-contracts container (foundry image), but is equally
# usable from a host with a native Foundry install:
#   CONTRACT_STATE_PATH=/tmp/contracts.json ANVIL_RPC_URL=http://localhost:8545 \
#     bash packages/contracts/scripts/docker-deploy.sh
set -eu

RPC_URL="${ANVIL_RPC_URL:-http://localhost:8545}"
STATE_PATH="${CONTRACT_STATE_PATH:-/shared/contracts.json}"

echo "[deploy] waiting for anvil at ${RPC_URL}"
for _ in $(seq 1 60); do
  if cast block-number --rpc-url "${RPC_URL}" >/dev/null 2>&1; then
    echo "[deploy] anvil is ready"
    break
  fi
  sleep 1
done
cast block-number --rpc-url "${RPC_URL}" >/dev/null

cd "$(dirname "$0")/.."

# Anvil's first deterministic test account is used as the platform signer for
# local development (§3.9.3) — never for anything of value.
DEPLOYER_KEY="${PLATFORM_SIGNER_SEED:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"
PLATFORM_SIGNER_ADDRESS="$(cast wallet address --private-key "${DEPLOYER_KEY}")"

echo "[deploy] forge build"
forge build

echo "[deploy] deploying AssetLicenseRegistry (publisher=${PLATFORM_SIGNER_ADDRESS})"
DEPLOY_OUTPUT="$(DEPLOYER_PRIVATE_KEY="${DEPLOYER_KEY}" \
PUBLISHER_ADDRESS="${PLATFORM_SIGNER_ADDRESS}" \
forge script script/Deploy.s.sol:Deploy \
  --rpc-url "${RPC_URL}" \
  --broadcast \
  --slow 2>&1)"

CONTRACT_ADDRESS="$(echo "${DEPLOY_OUTPUT}" | grep -o 'contract AssetLicenseRegistry 0x[0-9a-fA-F]*' | head -1 | awk '{print $NF}' || true)"

if [ -z "${CONTRACT_ADDRESS}" ] || [ "${CONTRACT_ADDRESS}" = "null" ]; then
  echo "[deploy] ERROR: could not read the deployed address from the broadcast log" >&2
  exit 1
fi

mkdir -p "$(dirname "${STATE_PATH}")"
forge inspect src/AssetLicenseRegistry.sol:AssetLicenseRegistry abi --json > "$(dirname "${STATE_PATH}")/AssetLicenseRegistry.abi.json"

# The contract address travels to api/worker via the shared volume (compose) and
# via .env.contracts for native dev (§9.3 step 3).
# Use printf/cast instead of node (not available in foundry image)
DEPLOYED_AT="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '{\n  "contractAddress": "%s",\n  "chainId": %s,\n  "rpcUrl": "%s",\n  "publisherAddress": "%s",\n  "deployedAt": "%s"\n}\n' \
  "${CONTRACT_ADDRESS}" \
  "${ANVIL_CHAIN_ID:-31337}" \
  "${RPC_URL}" \
  "${PLATFORM_SIGNER_ADDRESS}" \
  "${DEPLOYED_AT}" > "${STATE_PATH}"

echo "[deploy] CONTRACT_ADDRESS=${CONTRACT_ADDRESS}"
echo "[deploy] wrote ${STATE_PATH}"
