import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { cn } from '../../lib/cn';

/**
 * The button, as a variant table rather than a stylesheet rule.
 *
 * `buttonVariants` is exported because half the "buttons" in this product are links — a sign-in
 * call to action, a row action that navigates — and they must be visually identical to the real
 * `<button>`s beside them. Rendering an anchor as a button by hand is how a product ends up with
 * two slightly different orange rectangles on the same screen.
 *
 * Sizes are the documented ones: 32, 40 and 48 pixels. Weight is 600 rather than 500 because the
 * self-hosted Plus Jakarta Sans files are 400/600/700/800 — asking for 500 would get a synthesised
 * weight, which is exactly the kind of near-miss that makes an interface look unpolished.
 *
 * The focus ring is not set here: it lives once in `globals.css` on `:focus-visible`, so it applies
 * to every interactive element in the product whether or not it came from this component.
 */
export const buttonVariants = cva(
  'inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-control border text-sm font-semibold transition-all duration-200 ease-standard disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        /* The one loud control on a view: solid heat, a white label, and the stacked warm shadow. */
        primary:
          'border-brand bg-brand text-white shadow-heat hover:-translate-y-px hover:bg-brand-warm hover:border-brand-warm active:translate-y-0 active:scale-[0.995] active:bg-brand-dim',
        /* Filled but neutral: a supporting action beside a primary one. */
        secondary: 'border-veil-8 bg-veil-6 text-ink hover:bg-veil-12',
        /* Outlined: present, quiet, and used for the second option in a pair. */
        outline:
          'border-hairline-strong bg-transparent text-ink-dim hover:bg-veil-6 hover:text-ink',
        /* No chrome until it is hovered. For dense rows and toolbars. */
        ghost: 'border-transparent bg-transparent text-ink-dim hover:bg-veil-6 hover:text-ink',
        destructive: 'border-state-rejected bg-state-rejected text-white hover:brightness-110',
      },
      size: {
        sm: 'h-8 px-3 text-[13px]',
        md: 'h-10 px-4',
        lg: 'h-12 px-6 text-[15px]',
        icon: 'h-9 w-9 px-0',
      },
      /** Renders the pressed/selected state of a toggle, which is a different thing from `:active`. */
      selected: {
        true: '',
        false: '',
      },
    },
    compoundVariants: [
      {
        selected: true,
        class: 'border-heat-40 bg-heat-12 text-brand-warm hover:bg-heat-16',
      },
    ],
    defaultVariants: { variant: 'secondary', size: 'md', selected: false },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, selected, type = 'button', ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(buttonVariants({ variant, size, selected }), className)}
      {...props}
    />
  ),
);
Button.displayName = 'Button';

/**
 * A square icon button.
 *
 * Carried as its own component rather than a button size because an icon button that forgets its
 * `aria-label` is invisible to a screen reader, and a component that requires one cannot forget.
 */
export function IconButton({
  className,
  label,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        'relative inline-flex h-9 w-9 items-center justify-center rounded-control border border-hairline bg-surface text-ink-dim transition-all duration-200 ease-standard hover:border-hairline-strong hover:bg-surface-raised hover:text-ink',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}
