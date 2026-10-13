/**
 * Root layout.
 *
 * One set of typefaces for the whole application, self-hosted from `public/fonts` and declared with
 * `@font-face` in `globals.css`. Deliberately not Google Fonts: a marketplace that renders nothing
 * until fonts.googleapis.com answers is broken on a locked-down network, and the container build
 * cannot reach it at all.
 *
 * Plus Jakarta Sans for interface and display (geometric, slightly humanist, and not Inter — see the
 * type rules in `DESIGN.md`), JetBrains Mono for the identifiers and figures this product is made of,
 * so columns of hashes, CIDs and triangle counts line up.
 *
 * There is no theme toggle. The system is dark-only by design: heat orange against a near-neutral
 * ground is the brand, and a light mode would be a second design to maintain rather than an
 * accessibility win — contrast is held to WCAG AA in the one theme that exists.
 */
import type { Metadata, Viewport } from 'next';

import { Providers } from './providers';
import './globals.css';

export const metadata: Metadata = {
  title: 'VOID·SPACE — 3D asset marketplace',
  description:
    'Ingest, classify, review, store on IPFS and licence 3D assets on-chain. Every action accounted for in an append-only ledger.',
  openGraph: {
    title: 'VOID·SPACE — 3D asset marketplace',
    description: 'A multi-tenant 3D asset lifecycle platform with on-chain licensing.',
    type: 'website',
  },
};

export const viewport: Viewport = {
  // The page ground, so a mobile browser's chrome matches the page rather than framing it.
  themeColor: '#0a0a0a',
  colorScheme: 'dark',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="relative min-h-screen">
        {/* Keyboard users land here first; the header's destinations are reachable but skippable. */}
        <a href="#main" className="vs-skip-link">
          Skip to content
        </a>

        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
