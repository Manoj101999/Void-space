#!/usr/bin/env node
/**
 * Regenerates the typed ABI consumed by api/worker/web (SRS §3.9.4).
 *
 * Source of truth: packages/contracts/src/AssetLicenseRegistry.sol
 * Output:          packages/types/src/contracts/abi.generated.ts
 *
 * Run with: pnpm contracts:abi
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const contractsDir = resolve(here, '..');
const outputPath = resolve(contractsDir, '../types/src/contracts/abi.generated.ts');

function forgeInspectAbi() {
  const raw = execFileSync(
    'forge',
    ['inspect', 'src/AssetLicenseRegistry.sol:AssetLicenseRegistry', 'abi', '--json'],
    { cwd: contractsDir, encoding: 'utf8' },
  );
  return JSON.parse(raw);
}

const abi = forgeInspectAbi();
if (!Array.isArray(abi) || abi.length === 0) {
  throw new Error('forge inspect returned an empty ABI — did `forge build` succeed?');
}

const body = `/**
 * GENERATED FILE — do not edit by hand.
 * Regenerate with:  pnpm contracts:abi
 * Source of truth:  packages/contracts/src/AssetLicenseRegistry.sol
 *                   (forge inspect AssetLicenseRegistry abi --json)
 */
export const ASSET_LICENSE_REGISTRY_ABI = ${JSON.stringify(abi, null, 2)} as const;

export type AssetLicenseRegistryAbi = typeof ASSET_LICENSE_REGISTRY_ABI;
`;

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, body, 'utf8');

const entries = abi.filter((item) => item.type === 'function' || item.type === 'event').length;
console.log(`[abi] wrote ${outputPath} (${entries} functions/events)`);
