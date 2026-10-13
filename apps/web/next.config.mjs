/** @type {import('next').NextConfig} */
const API_INTERNAL_URL = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';

const nextConfig = {
  reactStrictMode: true,
  // Workspace packages ship TypeScript source (see README "package strategy"),
  // so Next compiles them alongside the app.
  transpilePackages: ['@void-space/ui', '@void-space/types'],
  experimental: {
    // 200 MB asset uploads go through the API, not Next's actions, so keep the
    // default body limit; this only affects server actions.
    serverActions: { bodySizeLimit: '2mb' },
  },
  // The browser talks to the API through the nginx edge (§3.1); server-side
  // renders use the internal URL so they never need TLS locally.
  env: {
    NEXT_PUBLIC_API_BASE_URL: process.env.NEXT_PUBLIC_API_BASE_URL ?? '/api/v1',
  },
  eslint: {
    // Lint is run from the monorepo root (`pnpm lint`).
    ignoreDuringBuilds: true,
  },
  /**
   * Browser API calls are relative (`/api/v1/...`) because in the deployed stack nginx terminates
   * that prefix and proxies it to the API. When Next is reached *directly* — `next dev` or
   * `next start` on :3000, which is how the app is developed and how the UI audit drives it —
   * nothing sits in front of it, so the same path is answered by Next's own router with a 404 and
   * every interactive surface looks broken: sign-in, catalogue filtering, the console.
   *
   * These rewrites make the bare origin work without changing the deployed path. In the container
   * stack they are never reached, because nginx resolves `/api/*` before the request arrives here.
   */
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${API_INTERNAL_URL}/api/:path*` }];
  },
};

export default nextConfig;
