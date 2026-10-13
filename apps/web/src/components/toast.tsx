'use client';

/**
 * Action feedback.
 *
 * The console fires off asynchronous work constantly — publish, approve, revoke, mint — and until
 * now the only confirmation was a panel quietly re-rendering somewhere further down the page. A
 * user who clicks PUBLISH and sees nothing happen assumes it failed and clicks again, which is how
 * duplicate mints get attempted.
 *
 * Toasts state what happened, and errors stay until they are dismissed: a licence that failed to
 * mint is not a message that should disappear on a timer.
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

import { cn } from '../lib/cn';

type Tone = 'ok' | 'error' | 'info';

interface Toast {
  readonly id: number;
  readonly tone: Tone;
  readonly title: string;
  readonly detail?: string | undefined;
}

interface ToastApi {
  push: (tone: Tone, title: string, detail?: string) => void;
  success: (title: string, detail?: string) => void;
  failure: (title: string, detail?: string) => void;
  info: (title: string, detail?: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const TONE_STYLE: Record<Tone, { dot: string; ring: string }> = {
  ok: { dot: 'bg-state-published', ring: 'border-state-published' },
  info: { dot: 'bg-brand', ring: 'border-heat-40' },
  error: { dot: 'bg-state-rejected', ring: 'border-state-rejected' },
};

const DISMISS_AFTER_MS: Record<Tone, number | null> = {
  ok: 6_000,
  info: 5_000,
  error: null, // stays put until acknowledged
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<readonly Toast[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback(
    (tone: Tone, title: string, detail?: string) => {
      const id = Date.now() + Math.random();
      setToasts((current) => [...current.slice(-3), { id, tone, title, detail }]);

      const timeout = DISMISS_AFTER_MS[tone];
      if (timeout !== null) setTimeout(() => dismiss(id), timeout);
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      push,
      success: (title, detail) => push('ok', title, detail),
      failure: (title, detail) => push('error', title, detail),
      info: (title, detail) => push('info', title, detail),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      {/* aria-live so a screen reader hears the outcome of an action it triggered. */}
      <div
        className="pointer-events-none fixed bottom-4 right-4 z-[9500] flex flex-col gap-2"
        role="status"
        aria-live="polite"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className="pointer-events-auto flex w-[min(380px,calc(100vw-2rem))] items-start gap-3 rounded-card border border-hairline bg-surface-raised px-4 py-3.5 shadow-float"
          >
            <span
              aria-hidden
              className={cn(
                // The rule on the leading edge carries the tone, and the title says it in words: state
                // is never colour alone.
                'mt-1 h-2 w-2 shrink-0 rounded-full',
                TONE_STYLE[toast.tone].dot,
              )}
            />
            <div className="min-w-0 flex-1">
              <div className="text-[13.5px] font-semibold text-ink">{toast.title}</div>
              {toast.detail ? (
                <div className="mt-1 text-[12.5px] leading-snug text-ink-dim">
                  {toast.detail}
                </div>
              ) : null}
            </div>
            <button
              type="button"
              className="shrink-0 rounded-control p-1 font-mono text-[12px] text-ink-faint transition-colors duration-150 ease-standard hover:bg-veil-6 hover:text-ink"
              onClick={() => dismiss(toast.id)}
              aria-label="Dismiss notification"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/**
 * Access to the toast queue.
 *
 * Deliberately non-throwing when no provider is mounted: a page rendered in a test or a story
 * should not explode because it logged something.
 */
export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  return (
    api ?? {
      push: () => undefined,
      success: () => undefined,
      failure: () => undefined,
      info: () => undefined,
    }
  );
}
