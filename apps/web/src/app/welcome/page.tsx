/**
 * Welcome route (`/welcome`).
 *
 * A deliberate stop between arriving and the sign-in form: it names the product, then hands over
 * to the existing login page on its own after three seconds, so nobody has to click through a
 * screen they have already read.
 *
 * The redirect is time-based, so it lives in the client component; this file stays a server
 * component so the route carries its own metadata and still renders its content when JavaScript
 * is unavailable (the reader simply stays on the screen rather than landing on a blank one).
 *
 * Nothing else is touched: `/` keeps its landing page and `/login` keeps its form.
 */
import type { Metadata } from 'next';

import { WelcomeScreen } from './welcome-screen';

export const metadata: Metadata = {
  title: 'Welcome — VOID·SPACE',
  description: 'Welcome to VOID·SPACE — 3D Assets. Redirecting you to sign in.',
};

export default function WelcomePage() {
  return <WelcomeScreen />;
}
