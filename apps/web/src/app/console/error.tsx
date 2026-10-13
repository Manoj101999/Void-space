'use client';

/**
 * Route-level fault panel.
 *
 * An operations console that shows a stack trace is worse than one that shows a fault code: the
 * operator needs to know whether the work is safe to retry. Anything that escapes a component error
 * boundary lands here.
 *
 * The message is shown verbatim and in mono, because "Console halted" tells nobody anything and the
 * actual exception is usually the whole answer — this is a tool for the people who run it, not a
 * consumer page where a raw error is noise.
 */
export default function AppError({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div className="relative overflow-hidden rounded-card border border-hairline bg-surface shadow-panel">
      <div className="flex items-center justify-between gap-4 border-b border-hairline px-5 py-3.5 text-[14px] font-semibold text-ink">
        <span>This view failed to render</span>
        <span className="font-mono text-[12px] text-ink-dim">UI.RENDER</span>
      </div>
      <div className="px-5 py-6">
        <p className="max-w-[65ch] text-[13.5px] leading-relaxed" style={{ color: 'var(--vs-fg-dim)' }}>
          Server-side state is unaffected: any job that was already queued keeps running, and no
          mutation was applied twice. Retrying re-renders this route.
        </p>

        <pre
          className="break-all font-mono text-[11.5px] text-ink-dim mt-5 max-h-40 overflow-auto rounded-[8px] border p-3.5 text-[12px] leading-relaxed"
          style={{ borderColor: 'var(--vs-line-strong)', background: 'var(--fc-bg-lighter)', color: 'var(--vs-fg-dim)' }}
        >
          {error.message}
        </pre>

        <div className="mt-5 flex flex-wrap gap-2">
          <button type="button" className="inline-flex h-10 items-center justify-center gap-2 rounded-control border px-4 text-[14px] font-semibold transition-all duration-200 ease-standard border-brand bg-brand text-white shadow-heat hover:border-brand-warm hover:bg-brand-warm" onClick={reset}>
            Retry the view
          </button>
          <a className="inline-flex h-10 items-center justify-center gap-2 rounded-control border border-transparent bg-veil-8 px-4 text-[14px] font-semibold text-ink transition-all duration-200 ease-standard hover:bg-veil-12" href="/console">
            Back to overview
          </a>
        </div>
      </div>
    </div>
  );
}
