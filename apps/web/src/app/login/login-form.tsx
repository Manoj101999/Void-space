'use client';

/**
 * Sign-in (FR-2.1, FR-2.2, FR-1.4).
 *
 * Three things this screen has to get right:
 *
 *  1. Credentials go to the API over the edge; tokens come back as httpOnly cookies, so nothing here
 *     ever touches a token (§2.5 constraint).
 *  2. Someone who belongs to several workspaces gets a chooser, not an error (FR-1.4).
 *  3. It is the first impression of the product, so it shows what the platform does rather than asking
 *     for a password in an empty room.
 *
 * `next` is where to land after signing in. It is validated on the server (`safeNextPath`), so this
 * component can treat it as a known-good in-app path: a deep link into the console survives the
 * sign-in detour instead of dumping the user on the overview.
 *
 * The demo accounts are listed because this is a local reference stack with seeded credentials — a
 * sign-in screen for a system anyone can run should say how to get in, and hiding that behind a README
 * is the kind of friction that makes an evaluation stop.
 */
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { ApiRequestError, apiFetch } from '../../lib/api';
import { rememberMemberships, type Membership } from '../../lib/session';
import { Wordmark } from '../../components/market-shell';
import { Avatar } from '../../components/ui/avatar';
import { CubeIcon } from '../../components/ui/icons';
import { ErrorNote } from '../../components/ui/feedback';

interface LoginResponse {
  readonly user?: { readonly tenants: readonly Membership[] };
  readonly requiresTenantSelection?: boolean;
  readonly tenants?: readonly Membership[];
}

const HIGHLIGHTS = [
  {
    title: 'Ingest anything',
    body: 'GLB, GLTF, OBJ, FBX, STL and BLEND up to 200 MB, streamed to disk and measured on arrival.',
  },
  {
    title: 'Stored by content',
    body: 'Every version is pinned to IPFS, so the catalogue link is the file — verifiable, not a guess.',
  },
  {
    title: 'Licensed on chain',
    body: 'Publishing mints an ERC-721 licence. A takedown flags the token and keeps the history.',
  },
] as const;

const DEMO_ACCOUNTS = [
  { email: 'creator@aurora.dev', role: 'Creator — uploads and submits' },
  { email: 'assessor@aurora.dev', role: 'Assessor — reviews and publishes' },
  { email: 'admin@aurora.dev', role: 'Tenant admin — team and settings' },
  { email: 'viewer@aurora.dev', role: 'Viewer — read-only marketplace' },
  { email: 'priya@void-space.dev', role: 'Member of two workspaces' },
] as const;

const DEMO_PASSWORD = 'VoidSpace!2026';

export function LoginForm({ next }: { next: string }) {
  const router = useRouter();
  const [email, setEmail] = useState('creator@aurora.dev');
  const [password, setPassword] = useState(DEMO_PASSWORD);
  const [tenants, setTenants] = useState<readonly Membership[] | null>(null);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(tenantId?: string) {
    setBusy(true);
    setError(null);

    try {
      const result = await apiFetch<LoginResponse>('/auth/login', {
        method: 'POST',
        body: { email, password, ...(tenantId ? { tenantId } : {}) },
      });

      if (result.requiresTenantSelection) {
        setTenants(result.tenants ?? []);
        return;
      }

      if (result.user?.tenants) rememberMemberships(result.user.tenants);
      router.replace(next);
    } catch (caught) {
      const apiError = caught as ApiRequestError;
      setError({ message: apiError.message, code: apiError.code });
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="grid min-h-[100dvh] place-items-center bg-base p-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)] lg:place-items-stretch lg:p-0">
      {/*
        The left half states what the product does. It is the first screen anyone sees, and a form
        floating in an empty page tells a visitor nothing about what they are signing in to. Hidden
        below 1000px, where the form needs the whole width.
      */}
      <section className="relative hidden overflow-hidden border-l border-hairline bg-deeper px-12 py-14 lg:flex lg:flex-col lg:justify-between">
        {/*
          The drafting grid, as a child element rather than an `::before`. It is the same
          `bg-grid-faint` texture the landing page uses, at a wider pitch, masked so it fades away from
          the top-right corner where the copy sits.
        */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-grid-faint bg-[length:44px_44px] [mask-image:radial-gradient(80%_80%_at_100%_0%,#000_0%,transparent_74%)]"
        />

        <div className="relative">
          {/*
            The mark, at 44px rather than a glyph. The 3D cube is the product's own subject, and it is
            the only decoration on this half — an ASCII drawing lived here first and it was the wrong
            signal on a page selling licensed 3D content, reading as a terminal utility rather than a
            marketplace. The mark is drawn from strokes rather than shipped as an image so it inherits
            the accent colour and stays crisp on any display.
          */}
          <CubeIcon className="text-brand" width={44} height={44} strokeWidth={1.15} />

          <span className="mt-7 block text-[12px] font-semibold uppercase tracking-[0.16em] text-ink-faint">
            3D asset lifecycle platform
          </span>

          <h1 className="text-balance text-[clamp(1.5rem,3vw,2.1rem)] font-semibold leading-[1.08] tracking-[-0.02em] text-ink mt-5 max-w-lg">
            Ingest, review and license 3D content with provenance that can be checked.
          </h1>

          <ul className="mt-10 flex flex-col gap-7">
            {HIGHLIGHTS.map((item) => (
              <li key={item.title} className="grid grid-cols-[18px_minmax(0,1fr)] gap-2.5 text-[13px] leading-[1.6] text-ink-dim">
                <span className="inline-block h-3.5 w-3.5 shrink-0 rounded-[3px]" aria-hidden />
                <span>
                  <b className="block text-ink">{item.title}</b>
                  {item.body}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="relative mt-12 flex flex-wrap items-center gap-4">
          <span className="inline-flex items-center gap-2 rounded-full border border-hairline-strong bg-surface px-2.5 py-[5px] font-mono">
            <i aria-hidden />
            <span>Reference stack · local only</span>
          </span>
          <Link href="/catalog" className="link-underline text-[13.5px]">
            Browse the public catalogue
          </Link>
        </div>
      </section>

      {/* Right: the form. */}
      <section className="flex items-center justify-center px-6 lg:px-12">
        <div className="w-full max-w-[400px] py-12">
          <div className="mb-8 flex items-center justify-between">
            <Link href="/" aria-label="VOID·SPACE — home">
              <Wordmark />
            </Link>
            <span className="font-mono text-[11.5px] tracking-[0.01em] tabular-nums text-ink-faint">v2.0</span>
          </div>

          <div className="relative overflow-hidden rounded-card border border-hairline bg-surface shadow-panel px-6 py-6">
            {tenants ? (
              /*
                FR-1.4 — someone who belongs to more than one workspace picks here rather than after
                landing in the wrong one. The roles are shown next to each, because which workspace you
                want is often decided by what you can do in it.
              */
              <div className="space-y-4">
                <div>
                  <h2 className="font-medium leading-[1.1] tracking-[-0.021em] text-ink text-2xl">Choose a workspace</h2>
                  <p className="text-[12px] tracking-[0.01em] text-ink-faint mt-1.5">
                    {email} belongs to {tenants.length}. You can switch later from the header.
                  </p>
                </div>

                <div className="flex flex-col gap-2">
                  {tenants.map((tenant) => (
                    <button
                      key={tenant.id}
                      type="button"
                      className="flex w-full items-center gap-3 rounded-control border border-hairline bg-surface p-3 text-left transition-all duration-150 ease-standard hover:border-hairline-strong hover:bg-surface-raised aria-pressed:border-heat-40 aria-pressed:bg-heat-8"
                      onClick={() => void submit(tenant.id)}
                      disabled={busy}
                    >
                      <Avatar name={tenant.name} />
                      <span className="min-w-0">
                        <b className="block truncate text-[13.5px] font-medium text-ink">
                          {tenant.name}
                        </b>
                        <span className="block truncate font-mono text-[11px] text-ink-faint">
                          {tenant.roles?.join(' / ') ?? ''}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>

                <button
                  type="button"
                  className="inline-flex h-10 items-center justify-center gap-2 rounded-control border px-4 text-[14px] font-semibold transition-all duration-200 ease-standard hover:bg-veil-12 border-hairline-strong bg-transparent text-ink-dim hover:bg-veil-6 hover:text-ink w-full justify-center"
                  onClick={() => setTenants(null)}
                >
                  Back
                </button>
              </div>
            ) : (
              <form
                className="space-y-5"
                onSubmit={(event) => {
                  event.preventDefault();
                  void submit();
                }}
              >
                <div>
                  <h2 className="font-medium leading-[1.1] tracking-[-0.021em] text-ink text-2xl">Sign in</h2>
                  <p className="text-[12px] tracking-[0.01em] text-ink-faint mt-1.5">Continue to your workspace</p>
                </div>

                <label className="block">
                  <span className="text-[12px] tracking-[0.01em] text-ink-faint">Email</span>
                  <input
                    className="h-10 w-full rounded-control border border-hairline bg-surface px-3 text-[15px] text-ink transition-colors duration-150 ease-standard hover:border-hairline-strong focus:border-brand focus:outline-none mt-1.5"
                    type="email"
                    value={email}
                    autoComplete="username"
                    onChange={(event) => setEmail(event.target.value)}
                    required
                  />
                </label>

                <label className="block">
                  <span className="text-[12px] tracking-[0.01em] text-ink-faint">Password</span>
                  <input
                    className="h-10 w-full rounded-control border border-hairline bg-surface px-3 text-[15px] text-ink transition-colors duration-150 ease-standard hover:border-hairline-strong focus:border-brand focus:outline-none mt-1.5"
                    type="password"
                    value={password}
                    autoComplete="current-password"
                    onChange={(event) => setPassword(event.target.value)}
                    required
                  />
                </label>

                {error ? (
                  <ErrorNote
                    message={error.message}
                    code={error.code}
                    hint={`Seed passwords are ${DEMO_PASSWORD}.`}
                  />
                ) : null}

                <button
                  className="inline-flex h-10 items-center justify-center gap-2 rounded-control border px-4 text-[14px] font-semibold transition-all duration-200 ease-standard border-brand bg-brand text-white shadow-heat hover:border-brand-warm hover:bg-brand-warm w-full justify-center"
                  type="submit"
                  disabled={busy}
                >
                  {busy ? 'Signing in…' : 'Sign in'}
                </button>
              </form>
            )}
          </div>

          {/*
            The seeded accounts, listed rather than described. A local reference stack that hides how
            to get in is one nobody evaluates.
          */}
          <div className="relative overflow-hidden rounded-card border border-hairline bg-surface shadow-panel mt-4 px-5 py-5">
            <div className="text-[12px] tracking-[0.01em] text-ink-faint">Demo accounts</div>
            <ul className="mt-3 flex flex-col gap-1">
              {DEMO_ACCOUNTS.map((account) => (
                <li key={account.email}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-3 rounded-control border border-transparent bg-transparent p-2 text-left transition-all duration-150 ease-standard hover:border-heat-40 hover:bg-heat-4 aria-pressed:border-heat-40 aria-pressed:bg-heat-8"
                    onClick={() => {
                      setEmail(account.email);
                      setPassword(DEMO_PASSWORD);
                    }}
                  >
                    <span className="min-w-0">
                      <span className="font-mono text-[12px] text-ink-dim block truncate">{account.email}</span>
                      <span className="text-[12px] tracking-[0.01em] text-ink-faint block">{account.role}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <p className="text-[12px] tracking-[0.01em] text-ink-faint mt-3 leading-relaxed">
              Selecting an account fills the form. The password is {DEMO_PASSWORD}.
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}
