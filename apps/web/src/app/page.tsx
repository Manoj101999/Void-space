/**
 * The first page — `/`.
 *
 * The site opens on the welcome screen: it names the product, counts three seconds down, then
 * hands over to the existing sign-in route (`/login`) on its own. Sign-in itself is untouched —
 * this page only navigates to it; the login route, its form and the session handling behind it
 * are exactly as they were.
 *
 * The landing page that used to live at the root moved unchanged to `/home` (import paths only),
 * so the product pitch is still one URL away rather than deleted.
 *
 * The redirect is time-based, so it lives in the client component; this file stays a server
 * component so `/` keeps its own metadata and still renders its content when JavaScript is
 * unavailable — the reader simply stays on the screen instead of landing on a blank one.
 */
import type { Metadata } from 'next';

import { WelcomeScreen } from './welcome/welcome-screen';

export const metadata: Metadata = {
  title: 'Welcome — VOID·SPACE',
  description: 'Welcome to VOID·SPACE — 3D Assets. Redirecting you to sign in.',
};

export default function HomePage() {
  return <WelcomeScreen />;
}
