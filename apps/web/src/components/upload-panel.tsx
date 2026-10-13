'use client';

/**
 * Asset intake (SRS FR-3.1, FR-3.2, FR-3.3, NFR-SEC.3).
 *
 * The client enforces the same rules the API does — allowed extension, 200 MB ceiling, and the
 * tenant's allowed categories (FR-14.3) — so an operator gets told *before* a 200 MB upload starts
 * rather than after it fails. The server re-validates everything regardless: this is feedback, not a
 * security boundary.
 *
 * The form is a marketplace's "list an item" panel: a large drop target first, then the metadata, then
 * one primary action. Cancelling is not offered, because an unsubmitted form costs nothing — the file
 * only reaches the server when the button is pressed, and the progress bar exists because a 200 MB
 * stream with no feedback looks like a hang.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { ALLOWED_ASSET_EXTENSIONS, MAX_ASSET_SIZE_BYTES, SOURCE_TOOLS } from '@void-space/types';

import { ApiRequestError, apiUpload } from '../lib/api';
import { formatBytes } from '../lib/format';
import { ErrorNote } from './ui/feedback';

const EXTENSIONS: readonly string[] = ALLOWED_ASSET_EXTENSIONS;

export function UploadPanel({ categories }: { categories: readonly string[] }) {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [category, setCategory] = useState(categories[0] ?? 'Other');
  const [tags, setTags] = useState('');
  const [sourceTool, setSourceTool] = useState<string>('Blender');
  const [submitForReview, setSubmitForReview] = useState(true);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [done, setDone] = useState<string | null>(null);

  function chooseFile(next: File | null) {
    setError(null);
    setDone(null);

    if (!next) {
      setFile(null);
      return;
    }

    const extension = `.${next.name.split('.').pop()?.toLowerCase() ?? ''}`;
    if (!EXTENSIONS.includes(extension)) {
      setError({
        message: `Unsupported type ${extension}. The importer accepts ${EXTENSIONS.join(', ')}.`,
        code: 'VALIDATION_ERROR',
      });
      setFile(null);
      return;
    }
    if (next.size > MAX_ASSET_SIZE_BYTES) {
      setError({
        message: `That file is ${formatBytes(next.size)}; the ceiling is ${formatBytes(
          MAX_ASSET_SIZE_BYTES,
        )}.`,
        code: 'PAYLOAD_TOO_LARGE',
      });
      setFile(null);
      return;
    }

    setFile(next);
    if (name.trim().length === 0) {
      setName(next.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' '));
    }
  }

  async function upload() {
    if (!file) return;

    setError(null);
    setProgress(0);

    const form = new FormData();
    // Field order matters: the API streams the file last, after it has the metadata.
    form.append('name', name.trim());
    form.append('category', category);
    form.append('tags', tags);
    form.append('sourceTool', sourceTool);
    form.append('submitForReview', submitForReview ? 'true' : 'false');
    form.append('file', file);

    try {
      await apiUpload('/assets', form, setProgress);
      setDone(`${name.trim()} ingested${submitForReview ? ' and queued for review' : ' as a draft'}`);
      setFile(null);
      setName('');
      setTags('');
      if (inputRef.current) inputRef.current.value = '';
      await queryClient.invalidateQueries({ queryKey: ['assets'] });
      await queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    } catch (caught) {
      const apiError = caught as ApiRequestError;
      setError({ message: apiError.message, code: apiError.code });
    } finally {
      setProgress(null);
    }
  }

  return (
    <div className="px-5 py-5">
      <label
        className="block cursor-pointer rounded-[var(--vs-radius)] border border-dashed px-6 py-8 text-center transition-colors"
        style={{
          borderColor: file ? 'var(--fc-heat-40)' : 'var(--vs-line-strong)',
          background: file ? 'var(--fc-heat-4)' : 'var(--fc-bg-lighter)',
        }}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          chooseFile(event.dataTransfer.files[0] ?? null);
        }}
      >
        <span className="mt-0 block text-[13px] leading-relaxed text-ink-faint">
          Drop a model here, or choose a file. It is streamed to disk and measured on the way in —
          nothing is buffered whole in memory.
        </span>

        <input
          ref={inputRef}
          type="file"
          accept={EXTENSIONS.join(',')}
          className="font-mono text-[12px] text-ink-dim mx-auto mt-4 block w-full max-w-md text-[11px]"
          onChange={(event) => chooseFile(event.target.files?.[0] ?? null)}
        />

        <span className="font-mono text-[11.5px] tracking-[0.01em] tabular-nums text-ink-faint mt-3 block">
          {EXTENSIONS.join(' · ')} · max {formatBytes(MAX_ASSET_SIZE_BYTES)}
        </span>

        {file ? (
          <span className="mt-4 flex items-center justify-center gap-3">
            <span className="font-mono text-[12px] text-ink-dim truncate">{file.name}</span>
            <span className="chip">{formatBytes(file.size)}</span>
          </span>
        ) : null}
      </label>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <label className="block md:col-span-2">
          <span className="text-[12px] tracking-[0.01em] text-ink-faint">Name</span>
          <input
            className="h-10 w-full rounded-control border border-hairline bg-surface px-3 text-[15px] text-ink transition-colors duration-150 ease-standard hover:border-hairline-strong focus:border-brand focus:outline-none mt-1.5"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>

        <label className="block">
          <span className="text-[12px] tracking-[0.01em] text-ink-faint">
            Category{categories.length > 0 ? ' · restricted by this workspace' : ''}
          </span>
          <select
            className="h-10 w-full cursor-pointer appearance-none rounded-control border border-hairline bg-surface px-3 text-[14px] text-ink transition-colors duration-150 ease-standard hover:border-hairline-strong focus:border-brand focus:outline-none mt-1.5"
            value={category}
            onChange={(event) => setCategory(event.target.value)}
          >
            {(categories.length > 0 ? categories : ['Other']).map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="text-[12px] tracking-[0.01em] text-ink-faint">Source tool</span>
          <select
            className="h-10 w-full cursor-pointer appearance-none rounded-control border border-hairline bg-surface px-3 text-[14px] text-ink transition-colors duration-150 ease-standard hover:border-hairline-strong focus:border-brand focus:outline-none mt-1.5"
            value={sourceTool}
            onChange={(event) => setSourceTool(event.target.value)}
          >
            {SOURCE_TOOLS.map((tool) => (
              <option key={tool} value={tool}>
                {tool}
              </option>
            ))}
          </select>
        </label>

        <label className="block md:col-span-2">
          <span className="text-[12px] tracking-[0.01em] text-ink-faint">Tags · comma separated</span>
          <input
            className="h-10 w-full rounded-control border border-hairline bg-surface px-3 text-[15px] text-ink transition-colors duration-150 ease-standard hover:border-hairline-strong focus:border-brand focus:outline-none mt-1.5"
            value={tags}
            onChange={(event) => setTags(event.target.value)}
            placeholder="helmet, safety, ppe"
          />
        </label>

        <label className="flex items-center gap-2.5 md:col-span-2">
          <input
            type="checkbox"
            checked={submitForReview}
            onChange={(event) => setSubmitForReview(event.target.checked)}
          />
          <span className="text-[13.5px]">
            Submit for review on upload
            <span className="text-[12px] tracking-[0.01em] text-ink-faint block">
              Unchecked, the asset is saved as a draft only you can submit.
            </span>
          </span>
        </label>
      </div>

      {error ? (
        <div className="mt-4">
          <ErrorNote message={error.message} code={error.code} />
        </div>
      ) : null}

      {done ? (
        <div className="mt-4 flex items-center gap-3" role="status">
          <span className="inline-flex items-center gap-2 rounded-full border border-state-published bg-veil-4 px-2.5 py-[3px] text-[11.5px] text-state-published">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />
            Ingested
          </span>
          <span className="font-mono text-[12px] text-ink-dim">{done}</span>
        </div>
      ) : null}

      {progress !== null ? (
        <div className="mt-4">
          <div className="flex items-baseline justify-between">
            <span className="text-[12px] tracking-[0.01em] text-ink-faint">Uploading…</span>
            <span className="font-mono text-[12px] text-ink-dim">{progress}%</span>
          </div>
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-veil-8">
            <span
              className="block h-full rounded-full bg-brand transition-[width] duration-200 ease-standard"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      ) : null}

      <button
        type="button"
        className="inline-flex h-10 items-center justify-center gap-2 rounded-control border px-4 text-[14px] font-semibold transition-all duration-200 ease-standard border-brand bg-brand text-white shadow-heat hover:border-brand-warm hover:bg-brand-warm mt-5 w-full justify-center"
        disabled={!file || progress !== null || name.trim().length === 0}
        onClick={() => void upload()}
      >
        {progress !== null ? 'Uploading…' : 'Ingest asset'}
      </button>
    </div>
  );
}

