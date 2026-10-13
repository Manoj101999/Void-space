/**
 * Content gateway for the browser — `/ipfs/<cid>`.
 *
 * Why this route exists
 * ---------------------
 * A `ModelViewer` fetches its mesh from `/ipfs/<cid>`, a *relative* path. That resolves against
 * whatever origin the page was served from, and there are two of them:
 *
 *   • through the edge (https://localhost) → nginx owns `location /ipfs/`, proxies to Kubo and caches
 *     the bytes (FR-8.3). This route is never reached, so the edge cache keeps doing its job.
 *   • directly on the web origin (http://localhost:3000, which is what `next start` and any browser
 *     pointed at the app port uses) → nothing served `/ipfs`, so *every* model preview died with
 *     `404 Not Found`. The catalogue's one job is showing the model, so that was the worst possible
 *     place to depend on which port the user happened to open.
 *
 * Proxying here makes the relative URL correct on both, and no third host or CORS header is needed.
 *
 * Range requests are forwarded rather than absorbed: three.js streams large meshes, and the bundled
 * blue-whale scan is ~17 MB. Dropping `Range` would force a whole-file download before the first
 * frame and lose HTTP's ability to resume. 206 responses pass through with their `Content-Range`.
 */

/** Content addressing means a CID is always a lookup, never a mutation. */
export const dynamic = 'force-dynamic';

/**
 * Internal Kubo gateway. `http://ipfs:8080` inside compose; the published port when the API and
 * worker run natively, which is how `pnpm dev` works.
 *
 * `127.0.0.1` rather than `localhost` deliberately: on a Windows host, `localhost` resolves to the
 * IPv6 loopback `::1` first, where the WSL port relay (`wslrelay`) — not Docker — owns the
 * forwarded port. Connections then stall until they time out, and every preview of a large model
 * failed with a 503 from this handler while the identical request against `127.0.0.1` answered in
 * under a second. The literal loopback address skips that resolution entirely.
 */
const GATEWAY_URL = process.env.IPFS_GATEWAY_URL ?? 'http://127.0.0.1:8080';

/** Base32 (`bafy…`) or base58 (`Qm…`) — letters and digits only, so traversal is unrepresentable. */
const CID_PATTERN = /^[a-zA-Z0-9]{32,128}$/;

/** Headers that describe the payload and must survive the hop. */
const PASS_THROUGH = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'etag',
  'last-modified',
] as const;

export async function GET(
  request: Request,
  { params }: { params: { cid: string } },
): Promise<Response> {
  const { cid } = params;

  if (!CID_PATTERN.test(cid)) {
    return new Response('Not found', { status: 404 });
  }

  /** Forwarded so a partial-content request stays partial. */
  const range = request.headers.get('range');

  let upstream: Response;
  /**
   * The budget bounds the *headers* only, and is cancelled the moment they arrive.
   *
   * `AbortSignal.timeout` used to be handed straight to `fetch`, which ties it to the whole
   * response — including the body. A mesh can be 200 MB (FR-3.1), and a browser streaming that
   * through a dev server routinely needs longer than thirty seconds, so the signal fired
   * mid-transfer and tore the stream down. The browser then had fewer bytes than the
   * `Content-Length` it had been promised, reported `net::ERR_CONTENT_LENGTH_MISMATCH`, and
   * three.js surfaced it as `Could not load /ipfs/<cid>: Failed to fetch` — a correctly pinned
   * asset rendered as "preview unavailable" for the sole reason that it was large.
   *
   * Headers are what a timeout is for: they separate "the gateway is down" from "the gateway is
   * slow", which is the case this guard exists to answer. Once the gateway has answered, the
   * stream is bounded by the client going away instead — a stalled transfer costs one connection,
   * where a premature cut-off silently corrupts every large preview.
   */
  const controller = new AbortController();
  const headerBudget = setTimeout(() => controller.abort(), 30_000);

  try {
    upstream = await fetch(`${GATEWAY_URL}/ipfs/${cid}`, {
      headers: range ? { range } : {},
      // Kubo answers an immutable block; caching is expressed on the response instead.
      cache: 'no-store',
      signal: controller.signal,
    });
  } catch {
    // The gateway is down or unreachable. 503 says "try again", and the message avoids leaking the
    // internal hostname into a page the public can read.
    return new Response('Content gateway unavailable', { status: 503 });
  } finally {
    // The headers are in. Dropping the timer is what keeps the budget on the headers alone —
    // without this line the signal fires mid-body and reproduces exactly the truncation described
    // above, because `AbortSignal` stays wired to the response for as long as it is passed in.
    clearTimeout(headerBudget);
  }

  if (upstream.status === 404 || upstream.status === 400) {
    return new Response('Not found', { status: 404 });
  }

  if (!upstream.ok && upstream.status !== 206) {
    return new Response('Content gateway error', { status: 502 });
  }

  const headers = new Headers();
  for (const name of PASS_THROUGH) {
    const value = upstream.headers.get(name);
    if (value !== null) headers.set(name, value);
  }

  // The CID *is* the hash of these bytes, so a cached copy can never be stale.
  headers.set('cache-control', 'public, max-age=31536000, immutable');
  if (!headers.has('accept-ranges')) headers.set('accept-ranges', 'bytes');

  // `upstream.body` is passed straight through: it is already a web ReadableStream, and piping it
  // through Node's stream types and back would only add a copy per chunk.
  return new Response(upstream.body, { status: upstream.status, headers });
}
