'use client';

/**
 * Asset metadata editor (FR-3.2, FR-4.5).
 *
 * Opened from the Library's Edit control, which only renders when the API
 * computed `canEdit` for this caller — so the button and this form can never
 * disagree about who may edit (§3.6 "reflected in the Next.js UI"). The
 * server re-validates the caller's permission, the asset's lifecycle state
 * and every field on save; this dialog is feedback, not a security boundary.
 *
 * Fields the API accepts on PATCH /assets/:id: name, category, tags,
 * description and the tenant's structured `metadata` (FR-14.3). Provenance
 * fields (source tool, licence, attribution) live on the version and stay
 * immutable (FR-8.4), so they are deliberately absent.
 *
 * The control renders on every card for the asset's creator and for admins.
 * When the lifecycle state has made the asset itself immutable (§5.1) the
 * form opens read-only with the rule stated, rather than offering a save the
 * API would refuse with a 409.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { isMetadataEditable, type AssetStatus } from '@void-space/types';

import { ApiRequestError, apiFetch } from '../lib/api';
import { useToast } from './toast';
import { STATUS_LABEL } from './ui/chip';
import { ErrorNote } from './ui/feedback';
import { Field, Input, Select, Textarea } from './ui/field';

/** The subset of the asset summary the editor prefills from. */
export interface EditableAsset {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly category: string;
  readonly tags: readonly string[];
  /** Lifecycle state — decides whether the form may save (§5.1). */
  readonly status: AssetStatus;
}

/** DTO ceilings (FR-3.2), mirrored so a save fails here rather than at the API. */
const MAX_TAGS = 25;
const MAX_TAG_LENGTH = 40;

export function AssetEditDialog({
  asset,
  categories,
  onClose,
}: {
  readonly asset: EditableAsset;
  /** The tenant's allowed categories; free text when the workspace defines none. */
  readonly categories: readonly string[];
  readonly onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();

  const [name, setName] = useState(asset.name);
  const [category, setCategory] = useState(asset.category);
  const [tags, setTags] = useState(asset.tags.join(', '));
  const [description, setDescription] = useState(asset.description ?? '');
  const [metadata, setMetadata] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);

  // Escape closes, mirroring the quick-look dialog.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  // The asset's current category stays selectable even when the workspace has
  // since restricted its allowed list — otherwise the select would render no
  // selection and a save would silently keep the old value.
  const categoryOptions = categories.includes(category)
    ? categories
    : [category, ...categories];

  // The asset's creator and admins may write back in any mutable state and while the
  // asset is in review, before a decision has landed (FR-3.2); §5.1 keeps every other
  // state read-only. The dialog still opens on every card so the rule can be stated
  // where the reader is.
  const editable = isMetadataEditable(asset.status);

  async function save() {
    if (!editable || name.trim().length === 0 || saving) return;

    const parsedTags = tags
      .split(',')
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0);

    if (parsedTags.length > MAX_TAGS) {
      setError({
        message: `Too many tags: ${parsedTags.length}. The ceiling is ${MAX_TAGS}.`,
        code: 'VALIDATION_ERROR',
      });
      return;
    }
    if (parsedTags.some((tag) => tag.length > MAX_TAG_LENGTH)) {
      setError({
        message: `A tag is longer than ${MAX_TAG_LENGTH} characters.`,
        code: 'VALIDATION_ERROR',
      });
      return;
    }

    // Structured metadata replaces the stored object; empty keeps it unchanged.
    let parsedMetadata: Record<string, unknown> | undefined;
    if (metadata.trim().length > 0) {
      try {
        const parsed: unknown = JSON.parse(metadata);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('it must be a JSON object, e.g. { "scale": "1:1" }');
        }
        parsedMetadata = parsed as Record<string, unknown>;
      } catch (caught) {
        setError({
          message: `Metadata is not valid JSON: ${(caught as Error).message}`,
          code: 'VALIDATION_ERROR',
        });
        return;
      }
    }

    setSaving(true);
    setError(null);

    try {
      await apiFetch(`/assets/${asset.id}`, {
        method: 'PATCH',
        body: {
          name: name.trim(),
          category: category.trim(),
          tags: parsedTags,
          description: description.trim(),
          ...(parsedMetadata ? { metadata: parsedMetadata } : {}),
        },
      });
      await queryClient.invalidateQueries({ queryKey: ['assets'] });
      await queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      toast.success('Asset details saved');
      onClose();
    } catch (caught) {
      const apiError = caught as ApiRequestError;
      setError({ message: apiError.message, code: apiError.code });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[9400] flex items-center justify-center p-3 sm:p-6"
      style={{ background: 'rgba(5,5,5,0.86)' }}
      onMouseDown={(event) => {
        // Click-outside closes, but only when the press started on the backdrop itself.
        if (event.target === event.currentTarget) onClose();
      }}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Edit ${asset.name}`}
        className="relative flex max-h-full w-full max-w-lg flex-col overflow-hidden rounded-card border border-hairline bg-surface shadow-panel"
      >
        <div className="flex items-center justify-between gap-4 border-b border-hairline px-5 py-3.5">
          <span className="truncate text-[14px] font-semibold text-ink">Edit asset</span>
          <button
            type="button"
            className="inline-flex h-8 items-center justify-center gap-2 rounded-control border border-transparent bg-veil-8 px-3 text-[13px] font-semibold text-ink-dim transition-all duration-200 ease-standard hover:bg-veil-12 hover:text-ink"
            onClick={onClose}
            aria-label="Close editor"
          >
            Close
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          {editable ? null : (
            <div
              role="note"
              className="mb-4 rounded-card border border-hairline border-l-[3px] border-l-brand bg-surface py-4 pl-[18px] pr-5"
            >
              <span className="inline-flex items-center gap-2 text-[13.5px] font-semibold text-ink">
                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-brand" />
                Read-only
              </span>
              <p className="mt-2 max-w-[62ch] text-[13.5px] leading-relaxed text-ink">
                {`This asset is ${STATUS_LABEL[asset.status]}. Metadata can be changed only while it is in Draft, In review, Needs changes or Rejected — §5.1 keeps every other state immutable.`}
              </p>
            </div>
          )}
          <div className="grid gap-4">
            <Field
              label="Name"
              hint="Required — shown in the library, the catalogue and the review queue."
            >
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={200}
                placeholder="Asset name"
                disabled={!editable}
              />
            </Field>

            <Field
              label="Category"
              hint={categories.length > 0 ? 'Restricted by this workspace.' : undefined}
            >
              {categories.length > 0 ? (
                <Select
                  value={category}
                  onChange={(event) => setCategory(event.target.value)}
                  disabled={!editable}
                >
                  {categoryOptions.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </Select>
              ) : (
                <Input
                  value={category}
                  onChange={(event) => setCategory(event.target.value)}
                  maxLength={60}
                  placeholder="Category"
                  disabled={!editable}
                />
              )}
            </Field>

            <Field label="Tags" hint={`Comma separated, up to ${MAX_TAGS}.`}>
              <Input
                value={tags}
                onChange={(event) => setTags(event.target.value)}
                placeholder="helmet, safety, ppe"
                disabled={!editable}
              />
            </Field>

            <Field label="Description" hint="Shown on the asset's detail page and marketplace card.">
              <Textarea
                rows={3}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                maxLength={4000}
                disabled={!editable}
              />
            </Field>

            <Field
              label="Metadata"
              hint='Optional JSON object, e.g. { "scale": "1:1" }. Leave empty to keep the current metadata.'
            >
              <Textarea
                rows={3}
                value={metadata}
                onChange={(event) => setMetadata(event.target.value)}
                placeholder='{ "scale": "1:1", "lod": 2 }'
                className="font-mono text-[13px]"
                disabled={!editable}
              />
            </Field>
          </div>

          {error ? (
            <div className="mt-4">
              <ErrorNote message={error.message} code={error.code} />
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-hairline px-5 py-3.5">
          <button
            type="button"
            className="inline-flex h-10 items-center justify-center gap-2 rounded-control border border-transparent bg-veil-8 px-4 text-[14px] font-semibold text-ink transition-all duration-200 ease-standard hover:bg-veil-12"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="inline-flex h-10 items-center justify-center gap-2 rounded-control border px-4 text-[14px] font-semibold transition-all duration-200 ease-standard border-brand bg-brand text-white shadow-heat hover:border-brand-warm hover:bg-brand-warm disabled:pointer-events-none disabled:opacity-50"
            disabled={saving || !editable || name.trim().length === 0}
            onClick={() => void save()}
          >
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  );
}
