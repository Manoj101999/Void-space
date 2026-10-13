'use client';

/**
 * Asset console (SRS FR-3.4, FR-3.3, FR-4.2, FR-7.5, FR-9.1, §6.3).
 *
 * The single screen where the whole lifecycle is visible and operable: the 3D preview served
 * from the cached IPFS gateway, the AI suggestion with explicit accept controls (never applied
 * silently, FR-7.5), the review decision form, publish, versions, the comment thread and the
 * asset's slice of the audit ledger.
 *
 * Actions are rendered from the capabilities the API computed for this caller, so a Creator
 * never sees an approve button that would 403.
 */
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { AssetStatus } from '@void-space/types';

import { ApiRequestError, apiFetch } from '../../../../lib/api';
import {
  formatBytes,
  formatDateTime,
  formatNumber,
  formatRelative,
  shortId,
} from '../../../../lib/format';
import { ModelViewer } from '../../../../components/model-viewer';
import { CopyButton } from '../../../../components/copy-button';
import { useToast } from '../../../../components/toast';
import { Panel } from '../../../../components/ui/card';
import { StatusChip, Tag } from '../../../../components/ui/chip';
import { ErrorNote, LoadingBlock } from '../../../../components/ui/feedback';
import { BackLink } from '../../../../components/ui/layout';
import { StatCell, StatRow, PersonCell } from '../../../../components/console-kit';

interface AssetDetailView {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly tags: readonly string[];
  readonly status: AssetStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly creator: { id: string; fullName: string; email: string } | null;
  readonly currentVersion: {
    readonly id: string;
    readonly versionNumber: number;
    readonly format: string;
    readonly sizeBytes: number;
    readonly polycount: number | null;
    readonly pinStatus: string;
    readonly ipfsCid: string | null;
    readonly gatewayUrl: string | null;
    readonly stats: {
      readonly vertices: number | null;
      readonly materials: number | null;
      readonly textures: number | null;
      readonly animations: number | null;
    };
    readonly dimensions: { x: number; y: number; z: number } | null;
  } | null;
  readonly license: {
    readonly tokenId: string;
    readonly txHash: string | null;
    readonly blockNumber: string | null;
    readonly gasUsed: string | null;
    readonly status: string;
    readonly ipfsMetadataCid: string | null;
    readonly mintedAt: string;
  } | null;
  readonly xrModuleUrl: string | null;
  readonly xrManifestRef: string | null;
  readonly canDelete: boolean;
  readonly canPublish: boolean;
  readonly canRevoke: boolean;
  readonly versions: readonly {
    readonly id: string;
    readonly versionNumber: number;
    readonly format: string;
    readonly sizeBytes: number;
    readonly polycount: number | null;
    readonly pinStatus: string;
    readonly ipfsCid: string | null;
    readonly createdAt: string;
    readonly isCurrent: boolean;
  }[];
  readonly aiSuggestion: {
    readonly suggestedTags: readonly string[];
    readonly suggestedDescription: string;
    readonly qualityFlags: readonly string[];
    readonly confidence: number;
    readonly modelVersion: string;
    readonly promptVersion: string;
    readonly latencyMs: number | null;
    readonly acceptedTags: readonly string[];
    readonly acceptedDescription: string | null;
  } | null;
  readonly decisions: readonly {
    readonly id: string;
    readonly decision: string;
    readonly comment: string | null;
    readonly createdAt: string;
    readonly assessor: { id: string; fullName: string } | null;
  }[];
  readonly comments: readonly {
    readonly id: string;
    readonly body: string;
    readonly createdAt: string;
    readonly author: { id: string; fullName: string; roles: readonly string[] } | null;
    readonly replies: readonly {
      readonly id: string;
      readonly body: string;
      readonly createdAt: string;
      readonly author: { id: string; fullName: string; roles: readonly string[] } | null;
    }[];
  }[];
  readonly jobs: readonly {
    readonly id: string;
    readonly queue: string;
    readonly status: string;
    readonly attempts: number;
    readonly error: string | null;
    readonly createdAt: string;
  }[];
  readonly auditTrail: readonly {
    readonly id: string;
    readonly action: string;
    readonly actorId: string | null;
    readonly createdAt: string;
    readonly txHash: string | null;
  }[];
}

/** §3.6 — the permissions that gate each control on this screen. */
const PERMISSIONS = {
  decide: 'review:decide',
  publish: 'asset:publish',
  revoke: 'asset:revoke-license',
  submit: 'asset:upload-own',
  comment: 'catalog:view',
  delete: 'asset:delete-own-unpublished',
} as const;

function AiClassificationPanel({
  asset,
  inReview,
  canDecide,
  acceptTags,
  acceptDescription,
  setAcceptTags,
  setAcceptDescription,
}: {
  asset: AssetDetailView;
  inReview: boolean;
  canDecide: boolean;
  acceptTags: boolean;
  acceptDescription: boolean;
  setAcceptTags: (value: boolean) => void;
  setAcceptDescription: (value: boolean) => void;
}) {
  return (
    <Panel
      title="AI classification"
      right={
        asset.aiSuggestion
          ? `${(asset.aiSuggestion.confidence * 100).toFixed(0)}% confidence`
          : 'Pending'
      }
    >
      {asset.aiSuggestion ? (
        <div className="px-5 py-5">
          <div className="font-mono text-[12px] text-ink-dim">
            {asset.aiSuggestion.modelVersion} · prompt {asset.aiSuggestion.promptVersion}
            {asset.aiSuggestion.latencyMs !== null ? ` · ${asset.aiSuggestion.latencyMs} ms` : ''}
          </div>

          <div className="mt-3">
            <div className="text-[12px] tracking-[0.01em] text-ink-faint">Suggested tags</div>
            <div className="mt-1 flex flex-wrap gap-1">
              {asset.aiSuggestion.suggestedTags.map((tag) => (
                <Tag key={tag} tone={asset.aiSuggestion?.acceptedTags.includes(tag) ? 'brand' : 'neutral'}>
                  {tag}
                </Tag>
              ))}
            </div>
          </div>

          <div className="mt-3">
            <div className="text-[12px] tracking-[0.01em] text-ink-faint">Suggested description</div>
            <p className="mt-1 text-[12px] leading-relaxed opacity-90">
              {asset.aiSuggestion.suggestedDescription}
            </p>
            {asset.aiSuggestion.acceptedDescription ? (
              <div className="mt-2 inline-flex items-center gap-2 text-[12.5px] text-state-published">
                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />
                Accepted by review
              </div>
            ) : null}
          </div>

          {asset.aiSuggestion.qualityFlags.length > 0 ? (
            <div className="mt-3">
              <div className="text-[12px] tracking-[0.01em] text-ink-faint">Quality flags</div>
              <div className="mt-1 flex flex-wrap gap-1">
                {asset.aiSuggestion.qualityFlags.map((flag) => <Tag key={flag} tone="brand">{flag}</Tag>)}
              </div>
            </div>
          ) : null}

          {canDecide && inReview ? (
            <div className="mt-4 space-y-2 border-t pt-3" style={{ borderColor: 'var(--vs-line-strong)' }}>
              <div className="text-[12px] tracking-[0.01em] text-ink-faint">Adoption on decision</div>
              <label className="font-mono text-[12px] text-ink-dim flex items-center gap-2">
                <input type="checkbox" checked={acceptTags} onChange={(event) => setAcceptTags(event.target.checked)} />
                MERGE AI TAGS INTO ASSET
              </label>
              <label className="font-mono text-[12px] text-ink-dim flex items-center gap-2">
                <input type="checkbox" checked={acceptDescription} onChange={(event) => setAcceptDescription(event.target.checked)} />
                RECORD AI DESCRIPTION
              </label>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="animate-dot-pulse font-mono text-[12px] text-ink-dim px-5 py-4">Enrichment pending…</div>
      )}
    </Panel>
  );
}

export default function AssetConsolePage() {
  const params = useParams<{ id: string }>();
  const assetId = params.id;
  const queryClient = useQueryClient();

  const [comment, setComment] = useState('');
  const [decisionComment, setDecisionComment] = useState('');
  const [acceptTags, setAcceptTags] = useState(true);
  const [acceptDescription, setAcceptDescription] = useState(false);
  const [licenseType, setLicenseType] = useState('Commercial-Use');
  const [petition, setPetition] = useState<{ key: string; label: string } | null>(null);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);

  const query = useQuery<AssetDetailView>({
    queryKey: ['asset', assetId],
    queryFn: () => apiFetch<{ asset: AssetDetailView }>(`/assets/${assetId}`).then((result) => result.asset),
    // In-flight work (pin, enrich, mint, publish) updates server-side while the operator watches.
    refetchInterval: (query) => {
      const data = query.state.data;
      const busy =
        data !== undefined &&
        (data.currentVersion?.pinStatus !== 'pinned' ||
          data.jobs.some(
            (job: { status: string }) =>
              job.status === 'queued' || job.status === 'active' || job.status === 'delayed',
          ));
      return busy ? 4_000 : false;
    },
  });

  const me = useQuery<{ user: { permissions: readonly string[] } }>({
    queryKey: ['session-minimal'],
    queryFn: () => apiFetch<{ user: { permissions: readonly string[] } }>('/auth/me'),
    staleTime: 30_000,
  });

  const permissions = me.data?.user.permissions ?? [];
  const may = (permission: string) => permissions.includes(permission);
  const toast = useToast();

  /**
   * Runs a mutation while locking the other actions.
   *
   * `key` identifies the pressed control so only that button shows the in-flight label; the
   * lock itself is global, since these mutations all change the same asset.
   */
  async function act(action: () => Promise<unknown>, key: string, label: string) {
    setError(null);
    setPetition({ key, label });
    try {
      await action();
      await queryClient.invalidateQueries({ queryKey: ['asset', assetId] });
      await queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      toast.success(`${label.charAt(0) + label.slice(1).toLowerCase()} done`);
    } catch (caught) {
      const apiError = caught as ApiRequestError;
      setError({ message: apiError.message, code: apiError.code });
      toast.failure(label.charAt(0) + label.slice(1).toLowerCase() + ' failed', apiError.message);
    } finally {
      setPetition(null);
    }
  }

  if (query.isLoading) return <LoadingBlock label="LOADING ASSET" />;
  if (query.error || !query.data) {
    return (
      <div className="space-y-3">
        <BackLink href="/console/library">Library</BackLink>
        <ErrorNote message={(query.error as Error)?.message ?? 'Asset not found'} />
      </div>
    );
  }

  const asset = query.data;
  const version = asset.currentVersion;
  const inReview = asset.status === 'pending' || asset.status === 'needs_manual_review';

  return (
    <div className="space-y-5">
      <div className="animate-rise flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <BackLink href="/console/library">Library</BackLink>
          <h1 className="mt-3 truncate text-[clamp(1.5rem,2.6vw,2rem)] font-semibold tracking-[-0.028em] text-ink">{asset.name}</h1>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <StatusChip status={asset.status} />
            <span className="chip">{asset.category}</span>
            {asset.creator ? <span className="chip">{asset.creator.fullName}</span> : null}
            <span className="chip">Updated {formatRelative(asset.updatedAt)}</span>
          </div>
        </div>
        <div className="text-right font-mono text-[12.5px] text-ink-faint">
          {version ? `v${version.versionNumber} · ${version.format.replace(/^\./, '').toUpperCase()}` : 'no version'}
          <div className="mt-1">asset {shortId(asset.id, 12)}</div>
        </div>
      </div>

      {error ? <ErrorNote message={error.message} code={error.code} /> : null}

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.08fr)_minmax(320px,0.92fr)]">
        <section className="relative overflow-hidden rounded-card border border-hairline bg-surface shadow-panel animate-rise">
          <div className="h-[clamp(480px,68vh,820px)]">
            <ModelViewer
              cid={version?.ipfsCid ?? null}
              format={version?.format ?? '.glb'}
              label={asset.name}
              dimensions={version?.dimensions ?? null}
              recordedPolycount={version?.polycount ?? null}
            />
          </div>
        </section>
        <div className="animate-rise">
          <AiClassificationPanel
            asset={asset}
            inReview={inReview}
            canDecide={may(PERMISSIONS.decide)}
            acceptTags={acceptTags}
            acceptDescription={acceptDescription}
            setAcceptTags={setAcceptTags}
            setAcceptDescription={setAcceptDescription}
          />
        </div>
      </div>

      <div className="grid gap-5 xl:grid-cols-[1.6fr_1fr]">
        <div className="space-y-5">
          <Panel title="Integrity" right="FR-8.1 / FR-9.6">
            <StatRow>
              <StatCell
                label="Polycount"
                value={formatNumber(version?.polycount ?? null)}
                hint="measured on ingest"
              />
              <StatCell label="Size" value={formatBytes(version?.sizeBytes ?? 0)} />
              <StatCell
                label="Pin state"
                value={version?.pinStatus ?? '—'}
                hint="IPFS"
                tone={version?.pinStatus === 'pinned' ? 'forest' : 'plain'}
              />
              <StatCell label="Versions" value={String(asset.versions.length)} hint="immutable history" />
            </StatRow>
            <div className="h-px w-full bg-hairline" />
            <dl className="px-5 py-3">
              <div className="flex justify-between gap-4 py-1">
                <dt className="text-[12px] tracking-[0.01em] text-ink-faint">CID</dt>
                <dd className="font-mono text-[12px] text-ink-dim truncate" title={version?.ipfsCid ?? ''}>
                  {version?.ipfsCid ?? '—'}
                </dd>
              </div>
              <div className="flex justify-between gap-4 py-1">
                <dt className="text-[12px] tracking-[0.01em] text-ink-faint">Gateway</dt>
                <dd className="font-mono text-[12px] text-ink-dim truncate">
                  {version?.gatewayUrl ? (
                    <a className="link-underline" href={version.gatewayUrl} target="_blank" rel="noreferrer">
                      {version.gatewayUrl}
                    </a>
                  ) : (
                    '—'
                  )}
                </dd>
              </div>
              <div className="flex justify-between gap-4 py-1">
                <dt className="text-[12px] tracking-[0.01em] text-ink-faint">Licence token</dt>
                <dd className="font-mono text-[12px] text-ink-dim">
                  {asset.license
                    ? `#${asset.license.tokenId} · ${asset.license.status}`
                    : 'Not licensed'}
                </dd>
              </div>
              {asset.license ? (
                <div className="flex justify-between gap-4 py-1">
                  <dt className="text-[12px] tracking-[0.01em] text-ink-faint">Tx</dt>
                  <dd
                    className="font-mono text-[12px] text-ink-dim truncate"
                    title={asset.license.txHash ?? 'mint transaction not observed'}
                  >
                    {asset.license.txHash ?? 'NOT OBSERVED'} / GAS {asset.license.gasUsed ?? '—'}
                  </dd>
                </div>
              ) : null}
              {/*
                One button per row above it: CID, Gateway, Licence token. The middle one used to
                read the licence transaction hash, which is null until a mint happens, so it sat
                disabled under a Gateway value that was plainly on screen ("Nothing to copy yet").
                The Tx row keeps its hash as selectable text, and with no licence there is no
                token either — that button copies what its own row says rather than going dead.
              */}
              <div className="flex flex-wrap justify-end gap-2 py-2">
                <CopyButton label="CID" value={version?.ipfsCid ?? null} />
                <CopyButton label="Gateway" value={version?.gatewayUrl ?? null} />
                <CopyButton label="Licence token" value={asset.license?.tokenId ?? 'Not licensed'} />
              </div>
              <div className="flex justify-between gap-4 py-1">
                <dt className="text-[12px] tracking-[0.01em] text-ink-faint">XR module</dt>
                <dd className="font-mono text-[12px] text-ink-dim truncate">
                  {asset.xrModuleUrl ? (
                    <a className="link-underline" href={asset.xrModuleUrl} target="_blank" rel="noreferrer">
                      {asset.xrManifestRef ?? asset.xrModuleUrl}
                    </a>
                  ) : (
                    'Not published'
                  )}
                </dd>
              </div>
            </dl>
          </Panel>

          <Panel title="Review history" right={`${asset.decisions.length} decisions`}>
            {asset.decisions.length === 0 ? (
              <div className="px-5 py-6 text-[13.5px]" style={{ color: 'var(--vs-fg-faint)' }}>
                No decisions recorded yet.
              </div>
            ) : (
              <table className="vs-table">
                <thead>
                  <tr>
                    <th>Decision</th>
                    <th>Assessor</th>
                    <th>Comment</th>
                    <th className="text-right">When</th>
                  </tr>
                </thead>
                <tbody>
                  {asset.decisions.map((decision) => (
                    <tr key={decision.id}>
                      <td className="font-mono text-[12px] text-ink-dim uppercase">{decision.decision}</td>
                      <td className="opacity-80">{decision.assessor?.fullName ?? '—'}</td>
                      <td className="opacity-80">{decision.comment ?? '—'}</td>
                      <td className="font-mono text-[12px] text-ink-dim whitespace-nowrap text-right opacity-70">
                        {formatRelative(decision.createdAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>

          <Panel title="Discussion" right={`${asset.comments.length} THREADS`}>
            <div className="px-5 py-5">
              {asset.comments.length === 0 ? (
                <div className="text-[13.5px]" style={{ color: 'var(--vs-fg-faint)' }}>
                  No comments yet.
                </div>
              ) : (
                <ul className="space-y-4">
                  {asset.comments.map((thread) => (
                    <li key={thread.id}>
                      <PersonCell
                        name={thread.author?.fullName ?? 'System'}
                        sub={`${thread.author?.roles.join(' / ') ?? ''} · ${formatRelative(
                          thread.createdAt,
                        )}`}
                        compact
                      />
                      <div className="mt-2 text-[13.5px] leading-relaxed">{thread.body}</div>
                      {thread.replies.map((reply) => (
                        <div
                          key={reply.id}
                          className="mt-3 border-l pl-4"
                          style={{ borderColor: 'var(--fc-heat-40)' }}
                        >
                          <PersonCell
                            name={reply.author?.fullName ?? 'System'}
                            sub={formatRelative(reply.createdAt)}
                            compact
                          />
                          <div className="mt-2 text-[13.5px] leading-relaxed">{reply.body}</div>
                        </div>
                      ))}
                    </li>
                  ))}
                </ul>
              )}

              {may(PERMISSIONS.comment) ? (
                <div className="mt-4">
                  <textarea
                    className="h-auto min-h-24 w-full resize-y rounded-control border border-hairline bg-surface px-3 py-2.5 text-[15px] text-ink transition-colors duration-150 ease-standard hover:border-hairline-strong focus:border-brand focus:outline-none"
                    rows={2}
                    placeholder="Add a comment on this asset"
                    value={comment}
                    onChange={(event) => setComment(event.target.value)}
                  />
                  <button
                    type="button"
                    className="inline-flex h-10 items-center justify-center gap-2 rounded-control border border-transparent bg-veil-8 px-4 text-[14px] font-semibold text-ink transition-all duration-200 ease-standard hover:bg-veil-12 mt-2"
                    disabled={comment.trim().length === 0 || petition !== null}
                    onClick={() =>
                      void act(async () => {
                        await apiFetch(`/assets/${assetId}/comments`, {
                          method: 'POST',
                          body: { body: comment.trim() },
                        });
                        setComment('');
                      }, 'comment', 'Posting…')
                    }
                  >
                    {petition?.key === 'comment' ? petition.label : 'Post comment'}
                  </button>
                </div>
              ) : null}
            </div>
          </Panel>
        </div>

        <div className="space-y-4">
          {may(PERMISSIONS.decide) && inReview ? (
            <Panel title="Review decision" right="FR-4.2">
              <div className="p-3">
                <textarea
                  className="h-auto min-h-24 w-full resize-y rounded-control border border-hairline bg-surface px-3 py-2.5 text-[15px] text-ink transition-colors duration-150 ease-standard hover:border-hairline-strong focus:border-brand focus:outline-none"
                  rows={3}
                  placeholder="Comment (required when rejecting or requesting changes)"
                  value={decisionComment}
                  onChange={(event) => setDecisionComment(event.target.value)}
                />
                <div className="mt-3 grid grid-cols-3 gap-2">
                  <button
                    type="button"
                    className="inline-flex h-10 items-center justify-center gap-2 rounded-control border px-4 text-[14px] font-semibold transition-all duration-200 ease-standard border-brand bg-brand text-white shadow-heat hover:border-brand-warm hover:bg-brand-warm justify-center disabled:pointer-events-none disabled:opacity-50"
                    disabled={petition !== null}
                    onClick={() =>
                      void act(
                        () =>
                          apiFetch(`/assets/${assetId}/decisions`, {
                            method: 'POST',
                            body: {
                              decision: 'approved',
                              comment: decisionComment.trim() || undefined,
                              acceptAiTags: acceptTags,
                              acceptAiDescription: acceptDescription,
                            },
                          }),
                        'approve',
                        'Approving…',
                      )
                    }
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className="inline-flex h-10 items-center justify-center gap-2 rounded-control border border-transparent bg-veil-8 px-4 text-[14px] font-semibold text-ink transition-all duration-200 ease-standard hover:bg-veil-12 justify-center disabled:pointer-events-none disabled:opacity-50"
                    disabled={petition !== null || decisionComment.trim().length === 0}
                    onClick={() =>
                      void act(
                        () =>
                          apiFetch(`/assets/${assetId}/decisions`, {
                            method: 'POST',
                            body: { decision: 'revision', comment: decisionComment.trim() },
                          }),
                        'revision',
                        'Requesting changes…',
                      )
                    }
                  >
                    Request changes
                  </button>
                  <button
                    type="button"
                    className="inline-flex h-10 items-center justify-center gap-2 rounded-control border border-transparent bg-veil-8 px-4 text-[14px] font-semibold text-ink transition-all duration-200 ease-standard hover:bg-veil-12 justify-center disabled:pointer-events-none disabled:opacity-50"
                    disabled={petition !== null || decisionComment.trim().length === 0}
                    onClick={() =>
                      void act(
                        () =>
                          apiFetch(`/assets/${assetId}/decisions`, {
                            method: 'POST',
                            body: { decision: 'rejected', comment: decisionComment.trim() },
                          }),
                        'reject',
                        'Rejecting…',
                      )
                    }
                  >
                    Reject
                  </button>
                </div>
              </div>
            </Panel>
          ) : null}

          {may(PERMISSIONS.publish) && asset.status === 'approved' ? (
            <Panel title="Publish" right="FR-9.1">
              <div className="p-3">
                <label className="block">
                  <span className="text-[12px] tracking-[0.01em] text-ink-faint">Licence type</span>
                  <select className="h-10 w-full cursor-pointer appearance-none rounded-control border border-hairline bg-surface px-3 text-[14px] text-ink transition-colors duration-150 ease-standard hover:border-hairline-strong focus:border-brand focus:outline-none mt-1" value={licenseType} onChange={(event) => setLicenseType(event.target.value)}>
                    {['CC0', 'CC-BY', 'CC-BY-SA', 'Commercial-Use', 'Internal-Only'].map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="text-[12px] tracking-[0.01em] text-ink-faint mt-3">
                  Mints an ERC-721 licence on Anvil, pins the licence document to IPFS, then
                  pushes the module to EoN Reality.
                </div>
                <button
                  type="button"
                  className="inline-flex h-10 items-center justify-center gap-2 rounded-control border px-4 text-[14px] font-semibold transition-all duration-200 ease-standard border-brand bg-brand text-white shadow-heat hover:border-brand-warm hover:bg-brand-warm mt-3 w-full justify-center"
                  disabled={petition !== null || version?.pinStatus !== 'pinned'}
                  onClick={() =>
                    void act(
                      () =>
                        apiFetch(`/assets/${assetId}/publish`, {
                          method: 'POST',
                          body: { licenseType, publishToXr: true },
                        }),
                      'publish',
                      'Minting the licence…',
                    )
                  }
                >
                  {petition?.key === 'publish'
                    ? petition.label
                    : version?.pinStatus === 'pinned'
                      ? 'Publish and mint'
                      : 'Waiting for the IPFS pin'}
                </button>
              </div>
            </Panel>
          ) : null}

          {may(PERMISSIONS.revoke) && asset.canRevoke ? (
            <Panel title="Takedown" right="FR-9.5">
              <div className="p-3">
                <div className="text-[12px] tracking-[0.01em] text-ink-faint">Flags the licence revoked on chain. History is retained.</div>
                <button
                  type="button"
                  className="inline-flex h-10 items-center justify-center gap-2 rounded-control border border-transparent bg-veil-8 px-4 text-[14px] font-semibold text-ink transition-all duration-200 ease-standard hover:bg-veil-12 mt-3 w-full justify-center"
                  disabled={petition !== null}
                  onClick={() =>
                    void act(
                      () =>
                        apiFetch(`/assets/${assetId}/license/revoke`, {
                          method: 'POST',
                          body: { reason: 'Revoked from the operations console' },
                        }),
                      'revoke',
                      'Revoking…',
                    )
                  }
                >
                  {petition?.key === 'revoke' ? petition.label : 'Revoke the licence'}
                </button>
              </div>
            </Panel>
          ) : null}

          <Panel title="Pipeline jobs" right="§3.10">
            {asset.jobs.length === 0 ? (
              <div className="px-5 py-6 text-[13.5px]" style={{ color: 'var(--vs-fg-faint)' }}>
                No jobs have run for this asset. Pinning, enrichment, minting and publishing each
                enqueue one, so an empty list means none of them has been triggered yet.
              </div>
            ) : (
              <table className="vs-table">
                <thead>
                  <tr>
                    <th>Queue</th>
                    <th>State</th>
                    <th className="text-right">Attempt</th>
                  </tr>
                </thead>
                <tbody>
                  {asset.jobs.map((job) => (
                    <tr key={job.id}>
                      <td className="font-mono text-[12px] text-ink-dim">{job.queue}</td>
                      <td
                        className="font-mono text-[12px] text-ink-dim uppercase"
                        style={{
                          color:
                            job.status === 'completed'
                              ? 'var(--vs-published)'
                              : job.status === 'failed'
                                ? 'var(--vs-accent)'
                                : 'var(--vs-fg-dim)',
                        }}
                      >
                        {job.status}
                      </td>
                      <td className="font-mono tracking-[-0.01em] tabular-nums text-right">{job.attempts}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>

          <Panel
            title="Versions"
            right={asset.versions.length > 1 ? 'Immutable history' : 'Initial upload'}
          >
            <table className="vs-table">
              <thead>
                <tr>
                  <th>Ver</th>
                  <th>Format</th>
                  <th className="text-right">Poly</th>
                  <th className="text-right">Size</th>
                </tr>
              </thead>
              <tbody>
                {asset.versions.map((item) => (
                  <tr key={item.id}>
                    <td className="font-mono text-[12px] text-ink-dim">
                      v{item.versionNumber} {item.isCurrent ? <span className="text-brand">●</span> : null}
                    </td>
                    <td className="font-mono text-[12px] text-ink-dim">{item.format}</td>
                    <td className="font-mono tracking-[-0.01em] tabular-nums text-right">{formatNumber(item.polycount)}</td>
                    <td className="font-mono tracking-[-0.01em] tabular-nums text-right">{formatBytes(item.sizeBytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>

          <Panel title="Ledger slice" right={`${asset.auditTrail.length} EVENTS`}>
            <div className="p-3">
              <ul className="space-y-2">
                {asset.auditTrail.slice(0, 12).map((entry) => (
                  <li key={entry.id} className="flex items-baseline justify-between gap-3">
                    <span className="font-mono text-[12px] text-ink-dim">{entry.action}</span>
                    <span className="text-[12px] tracking-[0.01em] text-ink-faint whitespace-nowrap">
                      {entry.txHash ? 'on chain · ' : ''}
                      {formatDateTime(entry.createdAt).slice(5)}
                    </span>
                  </li>
                ))}
              </ul>
              {may('audit:view') ? (
                <Link href="/console/audit" className="link-underline">
                  FULL LEDGER &gt;&gt;
                </Link>
              ) : null}
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}
