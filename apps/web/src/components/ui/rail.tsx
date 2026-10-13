import * as React from 'react';

import { cn } from '../../lib/cn';

/**
 * The filter rail.
 *
 * One selection per group, and clicking the selected row clears it. That is how a marketplace behaves
 * and — more to the point — it is the only way to undo a filter without hunting for a reset control.
 * The row is a `<button>` rather than a checkbox input because it is not a form: nothing is
 * submitted, and `role="checkbox"` on a control that re-queries a table would misdescribe it.
 *
 * Its own scroll container on a wide screen, so a rail with twelve categories does not drag the page
 * down with it while the grid beside it stays put.
 */
export interface RailOption {
  readonly value: string;
  readonly label: string;
  /** How many rows this filter would leave. A filter without a count is a guess. */
  readonly count?: number;
}

export interface RailGroup {
  readonly title: string;
  readonly options: readonly RailOption[];
  readonly value: string;
  readonly onChange: (next: string) => void;
}

export function FilterRail({ groups, className }: { groups: readonly RailGroup[]; className?: string }) {
  return (
    <aside
      aria-label="Filters"
      className={cn(
        'flex flex-col divide-y divide-hairline lg:sticky lg:top-[124px] lg:max-h-[calc(100dvh_-_148px)] lg:overflow-y-auto lg:pr-1',
        className,
      )}
    >
      {groups.map((group) => (
        <div key={group.title} className="py-3 first:pt-0 last:pb-0">
          <div className="px-2 pb-2 font-mono text-[11.5px] tracking-[0.04em] text-ink-faint">
            {group.title}
          </div>
          {group.options.map((option) => {
            const active = group.value === option.value;
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={active}
                onClick={() => group.onChange(active ? '' : option.value)}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-control px-2 py-2 text-left text-[13.5px] transition-colors duration-150 ease-standard',
                  active ? 'bg-veil-8 text-ink' : 'text-ink-dim hover:bg-veil-6 hover:text-ink',
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    'relative h-3.5 w-3.5 shrink-0 rounded-[4px] border transition-colors duration-150 ease-standard',
                    active ? 'border-brand bg-brand' : 'border-hairline-strong',
                  )}
                >
                  {active ? (
                    <span className="absolute left-[4px] top-[1px] h-2 w-1 rotate-45 border-b-[1.5px] border-r-[1.5px] border-white" />
                  ) : null}
                </span>
                <span className="truncate">{option.label}</span>
                {option.count === undefined ? null : (
                  <span className="ml-auto font-mono text-[11.5px] text-ink-faint">{option.count}</span>
                )}
              </button>
            );
          })}
        </div>
      ))}
    </aside>
  );
}
