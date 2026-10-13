/**
 * Licence-reuse rules in the chain client (SRS §3.9.2, §5.1).
 *
 * These cover a bug found by actually republishing: the worker's idempotency guard asked the
 * chain for "a token for this asset" and got back the *revoked* one, then tried to adopt it.
 * The insert collided with the existing row on (tenantId, tokenId) and the publish job failed
 * three times, leaving the asset unpublished with no way forward from the UI.
 *
 * `isLiveLicenceFor` is the rule that was wrong, so it is tested directly rather than through a
 * mocked RPC client.
 */
import { describe, expect, it } from 'vitest';

import { isLiveLicenceFor, type OnChainLicense } from '../src/lib/chain';

const ASSET = '09eeeab7-417a-5673-aeeb-b93cd0bf306f';

function record(overrides: Partial<OnChainLicense> = {}): OnChainLicense {
  return {
    assetId: ASSET,
    ipfsCid: 'bafybeieqtejat5toyy6bkt4eb5babt75il5uogfv6q3iecufag3no7xxkm',
    licenseTermsHash: `0x${'a'.repeat(64)}`,
    mintedAt: 1_800_000_000n,
    revoked: false,
    revokedReason: '',
    ...overrides,
  };
}

describe('isLiveLicenceFor', () => {
  it('accepts an unrevoked token for the asset', () => {
    expect(isLiveLicenceFor(record(), ASSET)).toBe(true);
  });

  it('rejects a revoked token, so a republish mints instead of adopting', () => {
    // The regression: adopting a revoked token published the asset against an invalid licence
    // and never minted for the new content.
    expect(
      isLiveLicenceFor(record({ revoked: true, revokedReason: 'Content re-exported.' }), ASSET),
    ).toBe(false);
  });

  it('rejects a live token belonging to a different asset', () => {
    // The scan walks every recent token, so a neighbour's licence must not be adopted.
    expect(isLiveLicenceFor(record({ assetId: 'ffffffff-0000-4000-8000-000000000000' }), ASSET)).toBe(
      false,
    );
  });

  it('rejects a token that does not exist', () => {
    // `getLicense` returns null for a token id the contract has no owner for.
    expect(isLiveLicenceFor(null, ASSET)).toBe(false);
  });

  it('treats revocation as disqualifying regardless of the reason text', () => {
    for (const reason of ['', 'superseded', 'DMCA takedown']) {
      expect(isLiveLicenceFor(record({ revoked: true, revokedReason: reason }), ASSET)).toBe(false);
    }
  });
});
