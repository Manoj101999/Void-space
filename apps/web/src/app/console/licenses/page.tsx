'use client';

/**
 * Licence registry (SRS §6.5, FR-9.6, FR-9.7). Every mint, with its chain evidence.
 *
 * The provenance columns — block, gas, transaction — are the reason this screen exists, so they are
 * printed in full rather than hidden behind a tooltip, and the transaction links out to the explorer
 * when one is configured. A registry entry a reader cannot check is just a row in a table.
 *
 * Revocation is shown as a state on the token, not as a deletion: the token is never burned, so a
 * revoked licence stays visible with its reason and simply stops being distributable. Showing it any
 * other way would misrepresent what a takedown does.
 */
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';

import { apiFetch } from '../../../lib/api';
import { formatDateTime, formatNumber, shortCid } from '../../../lib/format';
import { EmptyBlock, EventChip, PageHead, StatCell, StatRow } from '../../../components/console-kit';
import { Panel } from '../../../components/ui/card';
import { Tag } from '../../../components/ui/chip';
import { ErrorNote, LoadingBlock } from '../../../components/ui/feedback';

interface LicenceRow {
  readonly tokenId: string;
  readonly contractAddress: string;
  readonly txHash: string | null;
  readonly blockNumber: string | null;
  readonly gasUsed: string | null;
  readonly ipfsCid: string;
  readonly status: 'active' | 'revoked';
  readonly revokedReason: string | null;
  readonly mintedAt: string;
  readonly tokenUri: string | null;
  readonly asset: { id: string; name: string; status: string } | null;
  readonly explorer: { txUrl: string | null; addressUrl: string | null };
}

export default function LicencesPage() {
  const licences = useQuery<{ licenses: readonly LicenceRow[]; total: number }>({
    queryKey: ['licenses'],
    queryFn: () => apiFetch<{ licenses: readonly LicenceRow[]; total: number }>('/licenses'),
  });

  const rows = licences.data?.licenses ?? [];
  const active = rows.filter((row) => row.status === 'active').length;
  const revoked = rows.length - active;
  const onChain = rows.filter((row) => row.txHash !== null).length;
  const contractUrl = rows.find((row) => row.explorer.addressUrl)?.explorer.addressUrl ?? null;

  return (
    <div className="space-y-7">
      <PageHead
        title="Licence registry"
        meta={
          licences.data
            ? `${formatNumber(licences.data.total)} tokens · ERC-721 · ${onChain} with an observed transaction`
            : 'Querying'
        }
        actions={
          contractUrl ? (
            <a className="inline-flex h-10 items-center justify-center gap-2 rounded-control border border-transparent bg-veil-8 px-4 text-[14px] font-semibold text-ink transition-all duration-200 ease-standard hover:bg-veil-12" href={contractUrl} target="_blank" rel="noreferrer">
              Open the contract
            </a>
          ) : null
        }
      />

      {licences.isLoading ? <LoadingBlock label="Loading the registry" /> : null}
      {licences.error ? <ErrorNote message={(licences.error as Error).message} /> : null}

      {licences.data ? (
        <>
          <StatRow>
            <StatCell label="Tokens minted" value={formatNumber(licences.data.total)} />
            <StatCell
              label="Active"
              value={formatNumber(active)}
              hint="distributable now"
              tone="forest"
            />
            <StatCell
              label="Revoked"
              value={formatNumber(revoked)}
              hint={revoked > 0 ? 'flagged, never burned' : 'none'}
              tone={revoked > 0 ? 'heat' : 'plain'}
            />
            <StatCell
              label="Not observed on chain"
              value={formatNumber(rows.length - onChain)}
              hint="registry record only"
              tone={rows.length - onChain > 0 ? 'honey' : 'plain'}
            />
          </StatRow>

          <Panel title="Mint ledger" right={`${formatNumber(licences.data.total)} entries`}>
            {rows.length === 0 ? (
              <EmptyBlock
                title="No licences minted"
                hint="A licence is minted when an approved asset is published. An empty ledger means nothing has been published in this workspace yet."
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="vs-table">
                  <thead>
                    <tr>
                      <th>Token</th>
                      <th>Asset</th>
                      <th>State</th>
                      <th className="text-right">Block</th>
                      <th className="text-right">Gas</th>
                      <th>Metadata</th>
                      <th>Transaction</th>
                      <th className="text-right">Minted</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.tokenId}>
                        <td className="font-mono tracking-[-0.01em] tabular-nums whitespace-nowrap text-[15px]">
                          <span style={{ color: 'var(--vs-accent)' }}>#</span>
                          {row.tokenId}
                        </td>
                        <td>
                          {row.asset ? (
                            <Link href={`/console/assets/${row.asset.id}`} className="link-underline">
                              {row.asset.name}
                            </Link>
                          ) : (
                            <span className="font-mono text-[12px] text-ink-dim">—</span>
                          )}
                        </td>
                        <td>
                          <div className="flex flex-col items-start gap-1.5">
                            <EventChip
                              action={
                                row.status === 'active'
                                  ? 'chain.license_active'
                                  : 'chain.license_revoked'
                              }
                            />
                            {row.revokedReason ? <Tag tone="brand">{row.revokedReason}</Tag> : null}
                          </div>
                        </td>
                        <td className="font-mono tracking-[-0.01em] tabular-nums text-right">{row.blockNumber ?? '—'}</td>
                        <td className="font-mono tracking-[-0.01em] tabular-nums text-right">{row.gasUsed ?? '—'}</td>
                        <td className="font-mono text-[12px] text-ink-dim" title={row.ipfsCid}>
                          {row.tokenUri ? (
                            <a className="link-underline" href={row.tokenUri} target="_blank" rel="noreferrer">
                              {shortCid(row.ipfsCid)}
                            </a>
                          ) : (
                            shortCid(row.ipfsCid)
                          )}
                        </td>
                        <td className="font-mono text-[12px] text-ink-dim">
                          {row.txHash ? (
                            row.explorer.txUrl ? (
                              <a
                                className="link-underline"
                                href={row.explorer.txUrl}
                                target="_blank"
                                rel="noreferrer"
                                title={row.txHash}
                              >
                                {row.txHash.slice(0, 12)}…
                              </a>
                            ) : (
                              <span title={row.txHash}>{row.txHash.slice(0, 12)}…</span>
                            )
                          ) : (
                            <span style={{ color: 'var(--vs-fg-faint)' }}>not observed</span>
                          )}
                        </td>
                        <td className="font-mono text-[12px] text-ink-dim whitespace-nowrap text-right">
                          {formatDateTime(row.mintedAt).slice(0, 16)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </>
      ) : null}
    </div>
  );
}
