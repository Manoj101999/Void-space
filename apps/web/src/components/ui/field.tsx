import * as React from 'react';

import { cn } from '../../lib/cn';
import { SearchIcon } from './icons';

/**
 * Form controls.
 *
 * One control geometry for everything: 40px tall, 8px radius, `surface` fill, a 1px `hairline`
 * border that brightens on hover and turns heat on focus. Height and radius are shared as constants
 * so a text field, a select and a search box on the same row cannot end up two pixels apart.
 */
const CONTROL =
  'h-10 rounded-control border border-hairline bg-surface text-ink transition-colors duration-150 ease-standard hover:border-hairline-strong focus:border-brand focus:outline-none disabled:opacity-50';

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input ref={ref} className={cn(CONTROL, 'w-full px-3 text-[15px]', className)} {...props} />
  ),
);
Input.displayName = 'Input';

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(CONTROL, 'h-auto w-full px-3 py-2.5 text-[15px]', className)}
    {...props}
  />
));
Textarea.displayName = 'Textarea';

export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(({ className, children, ...props }, ref) => (
  <select
    ref={ref}
    className={cn(
      CONTROL,
      // `appearance-none` plus a drawn chevron: the platform arrow is a different shape and size in
      // every browser, which is the one thing that makes a set of selects look unfinished. The arrow
      // comes from a base rule keyed on `appearance-none` (see globals.css) rather than from a class
      // here, because a custom `bg-…` theme key inside `cn()` gets merged away.
      'w-full cursor-pointer appearance-none pl-3 pr-9 text-[14px]',
      className,
    )}
    {...props}
  >
    {children}
  </select>
));
Select.displayName = 'Select';

/**
 * A labelled field.
 *
 * The label is a real `<label>` wrapping the control, so clicking the words focuses the input — the
 * cheapest accessibility win in a form and the one most often replaced by a styled `<div>`.
 */
export function Field({
  label,
  hint,
  className,
  children,
}: {
  label: string;
  hint?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={cn('block', className)}>
      <span className="mb-1.5 block text-[12px] font-semibold text-ink-faint">{label}</span>
      {children}
      {hint === undefined ? null : (
        <span className="mt-1.5 block text-[12px] leading-relaxed text-ink-faint">{hint}</span>
      )}
    </label>
  );
}

/**
 * The search field.
 *
 * The magnifier is an inline SVG rather than a border-radius trick, and it sits inside the field's
 * padding, so the text baseline and the icon centre stay aligned at every font size.
 */
export function SearchField({
  label,
  className,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return (
    <div className={cn('relative flex items-center', className)}>
      <SearchIcon className="pointer-events-none absolute left-3.5 text-ink-faint" />
      <input
        type="search"
        aria-label={label}
        placeholder={label}
        className={cn(CONTROL, 'w-full pl-10 pr-3.5 text-[14px]')}
        {...props}
      />
    </div>
  );
}
