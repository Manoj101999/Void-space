'use client';

/**
 * Welcome screen — the hop between arriving and signing in.
 *
 * The redirect is the whole point of the screen, so the timing lives here in a client component:
 * three seconds on the page, then straight to the existing `/login` route. `replace` rather than
 * `push` on purpose — this is a stop on the way to the sign-in form, and the back button should
 * not bring someone back to a page that only sends them forward again.
 *
 * The layout borrows the sign-in screen's frame (page ground, drafting grid, cube mark) so the two
 * read as one sequence rather than as a splash ad followed by the product. No new tokens, no new
 * components, nothing outside this route.
 */
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { CubeIcon } from '../../components/ui/icons';

/** How long the welcome stays on screen before it hands over to the sign-in page. */
const REDIRECT_DELAY_MS = 3000;

const REDIRECT_SECONDS = REDIRECT_DELAY_MS / 1000;

export function WelcomeScreen() {
  const router = useRouter();
  const [secondsLeft, setSecondsLeft] = useState(REDIRECT_SECONDS);

  useEffect(() => {
    const tick = window.setInterval(() => {
      setSecondsLeft((seconds) => Math.max(0, seconds - 1));
    }, 1000);
    const redirect = window.setTimeout(() => router.replace('/login'), REDIRECT_DELAY_MS);

    return () => {
      window.clearInterval(tick);
      window.clearTimeout(redirect);
    };
  }, [router]);

  return (
    <main
      id="main"
      className="relative grid min-h-[100dvh] place-items-center overflow-hidden bg-base px-6"
    >
      {/* The storefront's drafting grid, faded out from the centre so the copy sits on clear ground. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-grid-faint [mask-image:radial-gradient(70%_60%_at_50%_45%,#000_0%,transparent_75%)]"
      />

      <div className="relative w-full max-w-[540px] text-center">
        <CubeIcon className="mx-auto text-brand" width={44} height={44} strokeWidth={1.15} />

        <span className="mt-7 block text-[12px] font-semibold uppercase tracking-[0.16em] text-ink-faint">
          3D asset lifecycle platform
        </span>

        <h1 className="mt-4 text-balance text-[clamp(1.6rem,3.4vw,2.25rem)] font-semibold leading-[1.08] tracking-[-0.02em] text-ink">
          Welcome to VOID·SPACE — 3D Assets
        </h1>

        <p className="mx-auto mt-5 max-w-[46ch] text-[15px] leading-[1.7] text-ink-dim">
          Signing you in next — your workspace, its assets and every licence issued for them are one
          step away.
        </p>

        {/* Countdown: a bar that empties as the seconds do, and a figure that says exactly how long. */}
        <div className="mx-auto mt-8 w-full max-w-[280px]">
          <div className="h-[3px] w-full overflow-hidden rounded-full bg-veil-12">
            <div
              aria-hidden
              className="h-full rounded-full bg-brand transition-[width] duration-1000 ease-linear"
              style={{ width: `${(secondsLeft / REDIRECT_SECONDS) * 100}%` }}
            />
          </div>
          <p
            role="status"
            aria-live="polite"
            className="mt-3 font-mono text-[12px] tabular-nums text-ink-faint"
          >
            Redirecting to sign in in {secondsLeft}s
          </p>
        </div>

        {/* The countdown is a convenience, not a gate: leaving early is always one click away. */}
        <a href="/login" className="link-underline mt-7 inline-block text-[13.5px] text-ink-dim">
          Continue to sign in
        </a>
      </div>
    </main>
  );
}
