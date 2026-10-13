import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Tailwind-aware class merge.
 *
 * Every component in `components/ui` takes a `className` and merges it through this, so a caller can
 * override any utility the component sets without fighting specificity — `twMerge` drops the earlier
 * class when two utilities write the same property. It is what makes `px-4` on a `<Button>` actually
 * replace the size variant's padding instead of losing to source order.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
