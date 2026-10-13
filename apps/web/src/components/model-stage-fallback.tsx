/**
 * What stands in for a 3D stage when there is nothing to render.
 *
 * Shared by the storefront hero and the console so "no preview" looks the same everywhere: an asset
 * whose format has no decoder, an empty catalogue, or a browser without WebGL are three different
 * facts and each gets its own sentence rather than a blank rectangle.
 *
 * A plain server component — no hooks, no canvas — so a Server Component can render it.
 */
import { CubeIcon } from './ui/icons';

export function ModelStageFallback({
  title,
  body,
  code,
}: {
  readonly title: string;
  readonly body: string;
  /** Optional stable identifier, shown so a support conversation has something to quote. */
  readonly code?: string | undefined;
}) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center p-7 text-center">
      <CubeIcon className="text-ink-faint opacity-40" width={34} height={34} />
      <div className="mt-4 text-[15px] font-semibold tracking-[-0.01em] text-ink">{title}</div>
      <p className="mt-2 max-w-sm text-[13px] leading-relaxed text-ink-faint">{body}</p>
      {code ? <div className="mt-3 font-mono text-[12px] text-ink-faint">{code}</div> : null}
    </div>
  );
}
