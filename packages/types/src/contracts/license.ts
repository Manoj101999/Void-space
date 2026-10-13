/**
 * Domain shape of the on-chain licence record (SRS §3.9.2, §5.1 `License`).
 *
 * Kept independent of viem/ABI types so the web app can render licence data
 * without pulling a chain client into the bundle.
 */

/** Mirrors the contract's `LicenseRecord` struct returned by `getLicense`. */
export interface OnChainLicenseRecord {
  readonly assetId: string;
  readonly ipfsCid: string;
  readonly licenseTermsHash: string;
  readonly mintedAt: bigint;
  readonly revoked: boolean;
  readonly revokedReason: string;
}

/** §3.9.2 `LicenseMinted(tokenId, assetId, ipfsCid, approver, timestamp)`. */
export interface LicenseMintedEvent {
  readonly tokenId: bigint;
  readonly assetId: string;
  readonly ipfsCid: string;
  readonly approver: string;
  readonly timestamp: bigint;
  readonly transactionHash: string;
  readonly blockNumber: bigint;
}

/** §3.9.2 `LicenseRevoked(tokenId, reason, timestamp)`. */
export interface LicenseRevokedEvent {
  readonly tokenId: bigint;
  readonly reason: string;
  readonly timestamp: bigint;
  readonly transactionHash: string;
  readonly blockNumber: bigint;
}

/** `LicenseMetadataUpdated(tokenId, metadataCid)` — tokenURI document pinned. */
export interface LicenseMetadataUpdatedEvent {
  readonly tokenId: bigint;
  readonly metadataCid: string;
  readonly transactionHash: string;
  readonly blockNumber: bigint;
}

/**
 * The four documented contract functions, expressed as a typed facade the
 * worker depends on. Implemented with viem in `apps/worker` (§3.9.4).
 */
export interface LicenseRegistryClient {
  mintLicense(params: {
    to: `0x${string}`;
    assetId: string;
    ipfsCid: string;
    licenseTermsHash: string;
  }): Promise<{ tokenId: bigint; txHash: `0x${string}`; blockNumber: bigint }>;
  setLicenseMetadataCid(params: {
    tokenId: bigint;
    metadataCid: string;
  }): Promise<{ txHash: `0x${string}`; blockNumber: bigint }>;
  revokeLicense(params: {
    tokenId: bigint;
    reason: string;
  }): Promise<{ txHash: `0x${string}`; blockNumber: bigint }>;
  getLicense(tokenId: bigint): Promise<OnChainLicenseRecord>;
  tokenURI(tokenId: bigint): Promise<string>;
  isLicenseValid(tokenId: bigint): Promise<boolean>;
  ownerOf(tokenId: bigint): Promise<`0x${string}`>;
}
