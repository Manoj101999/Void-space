#!/usr/bin/env node
/**
 * Publishes the demo catalogue through the real pipeline, so every licence in the database is the
 * mirror of an on-chain token rather than an invented row.
 *
 * Why a script: a licence is not demo decoration. It is the record the platform exists to make
 * verifiable, and a seed that fabricates token ids and transaction hashes puts fiction into it.
 * The seed therefore stops at `approved`, and this drives the same steps a person would:
 *
 *   sign in -> POST /assets/:id/publish -> the chain-license worker submits mintLicense() -> the
 *   API records token id, transaction hash, block and gas from the receipt
 *
 * It finishes by revoking one licence, because "a takedown keeps the history" (FR-9.3, FR-9.5) is
 * a claim worth being able to show — and revocation needs a *different, higher* permission than
 * publishing, so it signs in again as a TenantAdmin to demonstrate that split.
 *
 * Usage: node scripts/demo-publish.mjs [--revoke "<name fragment>"] [--keep-revoked]
 * Needs: the stack up (`pnpm dev:up`) plus the API and worker running (`pnpm dev`), Anvil reachable.
 */
const API = process.env.DEMO_API_URL ?? 'https://localhost/api/v1';
const ASSESSOR = { email: 'assessor@aurora.dev', password: 'VoidSpace!2026' };
const TENANT_ADMIN = { email: 'admin@aurora.dev', password: 'VoidSpace!2026' };
const DEFAULT_REVOKE_TARGET = 'Traffic Cone';

// The edge terminates TLS with a locally generated certificate, so verification would fail here and
// only here. Scoped to this process, which talks to localhost and nothing else.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

let cookies = '';

function readSetCookie(response) {
  for (const entry of response.headers.getSetCookie?.() ?? []) {
    const [pair] = entry.split(';');
    cookies = cookies ? `${cookies}; ${pair}` : pair;
  }
}

async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(cookies ? { cookie: cookies } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  readSetCookie(response);

  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : undefined;
  } catch {
    payload = text;
  }

  if (!response.ok) {
    const detail = payload && typeof payload === 'object' ? payload.message : payload;
    throw new Error(`${method} ${path} -> ${response.status}: ${detail ?? response.statusText}`);
  }
  return payload;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits for the chain worker, by polling the asset the platform itself reports. */
async function waitForLicence(assetId, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;

  while (Date.now() < deadline) {
    const { asset } = await api(`/assets/${assetId}`);
    last = asset;
    if (asset.status === 'published' || asset.license) return asset;
    await sleep(1_500);
  }

  throw new Error(
    `timed out waiting for ${last?.name ?? assetId} to publish (status: ${last?.status}). ` +
      'Is the worker running, and Anvil reachable?',
  );
}

function licenceLine(licence) {
  const tx = licence.txHash ? `${String(licence.txHash).slice(0, 12)}…` : 'tx not observed';
  return `token #${licence.tokenId ?? '?'} · block ${licence.blockNumber ?? '?'} · ${tx}`;
}

async function main() {
  const revokeTarget = process.argv.includes('--revoke')
    ? process.argv[process.argv.indexOf('--revoke') + 1]
    : DEFAULT_REVOKE_TARGET;

  console.log(`\n  Publishing the demo catalogue through ${API}\n  ${'─'.repeat(66)}`);

  await api('/auth/login', { method: 'POST', body: ASSESSOR });
  console.log('  signed in as assessor@aurora.dev');

  // §5.1 precondition: only an approved, pinned asset can be published.
  const { items } = await api('/assets?status=approved&pageSize=100');
  const publishable = items.filter((item) => item.currentVersion?.pinStatus === 'pinned');
  const minted = [];

  for (const asset of publishable) {
    process.stdout.write(`  publishing  ${asset.name.padEnd(28)} `);

    await api(`/assets/${asset.id}/publish`, {
      method: 'POST',
      body: {
        licenseType: asset.tags?.includes('cc0') ? 'CC0' : 'CC-BY',
        licenseTerms: `Demo licence for ${asset.name}: attribution required, XR training use.`,
        publishToXr: true,
      },
    });

    const settled = await waitForLicence(asset.id);
    minted.push({ ...(settled.license ?? {}), name: asset.name, id: asset.id });
    console.log(licenceLine(settled.license ?? {}));
  }

  if (publishable.length === 0) console.log('  nothing awaiting publication');

  // The catalogue as it stands, so the takedown demo also works on a repeat run.
  const { items: live } = await api('/assets?status=published&pageSize=100');
  const catalogue = [
    ...minted,
    ...live.map((item) => ({ ...(item.license ?? {}), name: item.name, id: item.id })),
  ];
  const target = catalogue.find((entry) => entry.name.includes(revokeTarget) && !entry.revokedAt);

  if (target && !process.argv.includes('--keep-revoked')) {
    // Revoking is a different permission, and the more consequential one: it pulls a licence from
    // a marketplace. Signing in as a TenantAdmin is the honest demonstration of that split.
    cookies = '';
    await api('/auth/login', { method: 'POST', body: TENANT_ADMIN });

    const result = await api(`/assets/${target.id}/license/revoke`, {
      method: 'POST',
      body: { reason: 'Takedown requested by the original author (demo of FR-9.3)' },
    });

    const revokedTx = result?.license?.revokedTxHash;
    console.log(
      `  revoked     ${target.name.padEnd(28)} token #${target.tokenId} kept on-chain` +
        (revokedTx ? `, revoke tx ${String(revokedTx).slice(0, 12)}…` : ''),
    );
  }

  console.log(`  ${'─'.repeat(66)}`);
  console.log(
    `  ${minted.length} minted this run · ${catalogue.length} licensed in total`,
  );
  console.log(
    '  verify on-chain:  cast call $CONTRACT_ADDRESS "totalMinted()(uint256)" --rpc-url http://localhost:8545\n',
  );
}

main().catch((error) => {
  console.error(`\n  demo:publish failed — ${error.message}\n`);
  process.exitCode = 1;
});
