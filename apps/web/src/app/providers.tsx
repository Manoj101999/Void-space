'use client';

/**
 * Client providers.
 *
 * React Query is configured for an *operations* tool: data is refetched on focus and polled
 * by the pages that show in-flight work, because job state (pin, enrich, mint, publish)
 * changes server-side while the operator is looking at the screen.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';

import { ToastProvider } from '../components/toast';

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // A 401 is an answer, not a failure to retry: it sends the user to /login.
            retry: (failureCount, error) => {
              const status = (error as { status?: number }).status ?? 0;
              if (status === 401 || status === 403 || status === 404) return false;
              return failureCount < 2;
            },
            refetchOnWindowFocus: true,
            staleTime: 5_000,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={client}>
      {/* Toasts wrap the app: every mutation reports its outcome where the user is looking. */}
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>
  );
}
