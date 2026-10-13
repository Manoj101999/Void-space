import { z } from 'zod';
import { booleanishSchema } from './common';

/**
 * FR-9.1/9.2: Publish is only permitted on an 'approved' asset. The client may
 * pass explicit license terms; the API hashes them and the worker mints the
 * token with the asset's current CID (§3.9.2).
 */
export const publishAssetSchema = z.object({
  licenseType: z.enum(['CC0', 'CC-BY', 'CC-BY-SA', 'Commercial-Use', 'Internal-Only']),
  licenseTerms: z.string().max(4000).optional(),
  /** Optional external wallet to receive the license token (§3.9.3). */
  recipientAddress: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .optional(),
  /** Also push the licensed asset into EoN Reality after minting (FR-10.1). */
  publishToXr: booleanishSchema.default(true),
});
export type PublishAssetInput = z.infer<typeof publishAssetSchema>;

/** FR-9.5: takedown — flags the license revoked without deleting history. */
export const revokeLicenseSchema = z.object({
  reason: z.string().min(3).max(500),
});
export type RevokeLicenseInput = z.infer<typeof revokeLicenseSchema>;

export const publishResponseSchema = z.object({
  assetId: z.string().uuid(),
  /** Both jobs are enqueued by the publish endpoint (§3.10). */
  chainLicenseJobId: z.string(),
  xrPublishJobId: z.string().nullable(),
  status: z.literal('approved'),
});
export type PublishResponse = z.infer<typeof publishResponseSchema>;

/** §6.5 / FR-9.7: on-chain license detail exposed to the UI. */
export interface LicenseDetail {
  readonly tokenId: string;
  readonly contractAddress: string;
  /** Null when the mint transaction was not observed (token adopted from chain state). */
  readonly txHash: string | null;
  readonly blockNumber: string | null;
  readonly gasUsed: string | null;
  readonly ipfsCid: string;
  readonly licenseTermsHash: string;
  readonly status: 'active' | 'revoked';
  readonly revokedReason: string | null;
  readonly mintedAt: string;
  readonly tokenUri: string | null;
  readonly approverRef: string | null;
  readonly asset: { id: string; name: string; status: string } | null;
  /** §4.9.7: link/params for the local block-explorer (tx inspector) view. */
  readonly explorer: { txUrl: string | null; addressUrl: string | null };
}

/** Payload written to IPFS as the token's tokenURI document (§3.9.2). */
export const licenseMetadataDocumentSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  assetId: z.string(),
  assetName: z.string(),
  ipfsCid: z.string(),
  licenseType: z.string(),
  licenseTermsHash: z.string(),
  approvingAssessor: z.object({
    userId: z.string(),
    reference: z.string(),
    decidedAt: z.string(),
  }),
  mintedAt: z.string(),
  tokenId: z.string(),
  contractAddress: z.string(),
  licenseTerms: z.string().optional(),
});
export type LicenseMetadataDocument = z.infer<typeof licenseMetadataDocumentSchema>;
