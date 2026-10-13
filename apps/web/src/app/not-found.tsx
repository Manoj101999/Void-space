/**
 * 404.
 *
 * A dead end in an operations tool usually means a stale link or a deleted asset, so this page says
 * which of those is likely and offers the routes worth taking. It uses the *storefront* frame rather
 * than the console's, because a 404 can be reached by someone with no session at all, and a page
 * that presupposes the console would either leak the navigation or render a session prompt on a
 * missing URL.
 *
 * The reason deletion is only possible for unpublished work is stated here rather than assumed: it
 * is the fact that decides whether the reader should look for the asset again or stop looking.
 */
import Link from 'next/link';

import { MarketFooter, MarketHeader } from '../components/market-shell';
import { buttonVariants } from '../components/ui/button';
import { CubeIcon } from '../components/ui/icons';

export default function NotFound() {
  return (
    <div className="flex min-h-[100dvh] flex-col bg-base">
      <MarketHeader />

      <main id="main" className="flex-1">
        <div className="relative overflow-hidden">
          {/* The same masked drafting grid the storefront uses, so a dead end still looks like the
              product rather than like a server error. */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-grid-faint bg-grid-lg [mask-image:radial-gradient(70%_60%_at_50%_0%,#000_0%,transparent_72%)]"
          />

          <div className="relative mx-auto w-full max-w-[1200px] px-6 py-20 md:py-28">
            <div className="max-w-2xl">
              <span className="text-[12px] font-semibold uppercase tracking-[0.16em] text-ink-faint">
                404 · Route not found
              </span>

              <h1 className="mt-6 text-balance text-[clamp(1.875rem,3.6vw,2.75rem)] font-semibold leading-[1.08] tracking-[-0.03em] text-ink">
                Nothing is at this address.
              </h1>

              <p className="mt-6 max-w-[62ch] text-[16px] leading-[1.7] text-ink-dim">
                Either the link is stale, or the asset it pointed at was deleted. Deletion is only
                possible for unpublished work, so anything that was ever published still exists in the
                ledger and can be found from the catalogue.
              </p>

              <div className="mt-9 flex flex-wrap items-center gap-3">
                <Link href="/catalog" className={buttonVariants({ variant: 'primary' })}>
                  Browse the catalogue
                </Link>
                <Link href="/console" className={buttonVariants()}>
                  Console overview
                </Link>
                <Link href="/" className={buttonVariants({ variant: 'outline' })}>
                  What the platform does
                </Link>
              </div>
            </div>

            {/* A single large mark, bled off the right edge. A 404 has no content to offer, so the
                composition carries the weight instead of a wall of apology. */}
            <CubeIcon
              aria-hidden
              className="pointer-events-none absolute -right-16 top-1/2 hidden -translate-y-1/2 text-brand opacity-[0.07] lg:block"
              width={420}
              height={420}
              strokeWidth={0.4}
            />
          </div>
        </div>
      </main>

      <MarketFooter />
    </div>
  );
}