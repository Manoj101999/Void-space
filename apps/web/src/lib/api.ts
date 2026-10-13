/**
 * API client (SRS §3.1).
 *
 * The browser never talks to Postgres, IPFS or the chain directly: every call goes through
 * the Fastify API, and in the local stack that request leaves the page at `https://localhost`
 * and is proxied by nginx. Cookies are httpOnly (FR-2.3), so the client simply asks the
 * browser to include them — there is no token to store and nothing to leak to JavaScript.
 */
import type { ApiError } from '@void-space/types';

export const API_INTERNAL_URL = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';
export const API_PUBLIC_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? '/api/v1';

/** An API failure carrying the stable `code` the UI branches on. */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  readonly requestId: string | undefined;

  constructor(status: number, body: Partial<ApiError>, fallback: string) {
    super(body.message ?? fallback);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = body.code ?? 'UNKNOWN';
    this.details = body.details;
    this.requestId = body.requestId;
  }
}

interface RequestOptions {
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  readonly body?: unknown;
  /** Absolute URL used by server components; defaults to the proxied browser path. */
  readonly baseUrl?: string;
  readonly cookieHeader?: string;
  readonly suppressErrorLog?: boolean;
  /** Internal: prevents an infinite refresh→retry→refresh loop. */
  readonly skipRefresh?: boolean;
}

async function parse<T>(response: Response, path: string): Promise<T> {
  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let payload: unknown;
  try {
    payload = text.length > 0 ? (JSON.parse(text) as unknown) : undefined;
  } catch {
    payload = undefined;
  }

  if (!response.ok) {
    const body = (payload && typeof payload === 'object' ? payload : {}) as Partial<ApiError>;
    const fallback =
      text && text.length < 200 && !text.includes('<!DOCTYPE')
        ? text
        : `${response.status} ${response.statusText || 'Request failed'} for ${path}`;
    throw new ApiRequestError(response.status, body, body.message ?? fallback);
  }

  return payload as T;
}

/**
 * Exchange the rotating refresh cookie for a fresh access cookie (FR-2.3).
 *
 * The access token lives ≤15 minutes by mandate, so *something* has to perform this exchange or
 * every session would end fifteen minutes after sign-in. It is client-only by design: only a
 * browser can persist the rotated httpOnly cookie that comes back.
 *
 * Single-flight: several queries can 401 together on a cold load, and they must share one
 * exchange. Multiple concurrent rotations of the same token would trip the server's reuse
 * detection (§3.7) and revoke the whole session family.
 */
let refreshInFlight: Promise<boolean> | null = null;

export function refreshSession(): Promise<boolean> {
  if (typeof window === 'undefined') return Promise.resolve(false);
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    try {
      const response = await fetch(`${API_PUBLIC_BASE}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: { accept: 'application/json' },
        cache: 'no-store',
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      // Cleared in a microtask so concurrent callers awaiting this promise all observe the result.
      void Promise.resolve().then(() => {
        refreshInFlight = null;
      });
    }
  })();

  return refreshInFlight;
}

/** Paths where a 401 is the answer rather than a cue to refresh. */
const NO_REFRESH_PATHS = ['/auth/refresh', '/auth/login', '/auth/register', '/auth/invite'];

/**
 * Calls the API. `credentials: 'include'` is what makes cookie auth work from the browser;
 * from a server component the cookie header is forwarded explicitly instead.
 *
 * On 401 the call is retried once behind a silent refresh, so an expired access token is a
 * non-event: the user keeps working and only a genuinely dead session reaches the sign-in screen.
 */
export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await send(path, options);

  const canRefresh =
    response.status === 401 &&
    !options.skipRefresh &&
    !options.cookieHeader &&
    typeof window !== 'undefined' &&
    !NO_REFRESH_PATHS.some((prefix) => path.startsWith(prefix));

  if (canRefresh && (await refreshSession())) {
    return parse<T>(await send(path, options), path);
  }

  return parse<T>(response, path);
}

/** Issues one request; kept separate so `apiFetch` can retry it verbatim after a refresh. */
async function send(path: string, options: RequestOptions): Promise<Response> {
  const base = options.baseUrl ?? API_PUBLIC_BASE;
  const url = path.startsWith('http') ? path : `${base}${path}`;

  return fetch(url, {
    method: options.method ?? 'GET',
    headers: {
      accept: 'application/json',
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.cookieHeader ? { cookie: options.cookieHeader } : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    cache: 'no-store',
    ...(options.cookieHeader ? {} : { credentials: 'include' as RequestCredentials }),
  });
}

/** Uploads multipart form data (asset binaries, FR-3.1) with progress reporting. */
export async function apiUpload<T>(
  path: string,
  form: FormData,
  onProgress?: (percent: number) => void,
): Promise<T> {
  // `fetch` cannot report upload progress, so the body is sent through XHR for the one call
  // where a 200 MB ceiling makes progress feedback matter.
  return new Promise<T>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', `${API_PUBLIC_BASE}${path}`);
    request.withCredentials = true;
    request.responseType = 'text';

    request.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };

    request.onerror = () => reject(new ApiRequestError(0, {}, 'Network error during upload'));
    request.onload = () => {
      let payload: unknown;
      try {
        payload = request.responseText.length > 0 ? JSON.parse(request.responseText) : undefined;
      } catch {
        payload = undefined;
      }

      if (request.status >= 200 && request.status < 300) {
        resolve(payload as T);
        return;
      }
      reject(
        new ApiRequestError(request.status, (payload ?? {}) as Partial<ApiError>, 'Upload failed'),
      );
    };

    request.send(form);
  });
}
