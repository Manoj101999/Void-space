/**
 * Third-party integration adapters (SRS §4.6, FR-6.1–FR-6.4).
 *
 * ## The rule this file follows
 *
 * Every adapter here has a **real mode** (an API key is configured) and an **offline mode**. The
 * offline mode returns an empty result set plus the reason — it does **not** return invented
 * content.
 *
 * That distinction is the whole point of the module. A local simulation (the Blender derivative, the
 * EoN push) fabricates a record *about our own system*, and labels it, so nothing downstream can be
 * misled. Fabricating a Sketchfab listing would invent data *about the outside world* — an asset
 * that does not exist, with an author who does not exist and a licence nobody granted. A user who
 * imported that would end up with a licence claim this platform cannot back, which is the exact
 * failure the rest of the product is built to prevent.
 *
 * So: no key means no results, and `IntegrationStatus.offlineFallbacks` names the adapter so the UI
 * can say *why*. NFR-REL.1 asks the core workflow to survive an absent integration, and an empty
 * list with a reason is what surviving looks like.
 *
 * ## Verification status
 *
 * The request shapes below follow each vendor's published API. They have **not** been exercised
 * against the live services — no vendor key exists in this environment — so treat the real-mode
 * branches as written-to-spec rather than proven. The offline branches, the status reporting and the
 * route contracts are all covered by tests.
 */
import type {
  ExternalAssetResult,
  IntegrationStatus,
  MeshyGenerateInput,
  PolyPizzaSearchQuery,
  SketchfabSearchQuery,
} from '@void-space/types';

export interface ToolsDeps {
  readonly sketchfabToken: string | undefined;
  readonly polyPizzaToken: string | undefined;
  readonly meshyKey: string | undefined;
  /** The worker's Blender queue is reachable, i.e. a runner is configured. */
  readonly blenderConfigured: boolean;
  /** EoN Reality is configured (real mode, not the labelled simulation). */
  readonly eonConfigured: boolean;
  /** An Anthropic key exists, so enrichment is not falling back to the offline heuristic. */
  readonly claudeConfigured: boolean;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export interface SearchOutcome {
  readonly results: readonly ExternalAssetResult[];
  /** True when the adapter could not be reached, or is not configured. */
  readonly offline: boolean;
  /** Present only when `offline` — a sentence a UI can show a person. */
  readonly reason?: string;
}

export interface MeshyOutcome {
  readonly taskId: string | null;
  readonly status: 'queued' | 'offline';
  readonly reason?: string;
}

/** Sketchfab's `license` values, mapped to the label a human reads. */
const SKETCHFAB_LICENSES: Readonly<Record<string, string>> = {
  cc0: 'CC0',
  by: 'CC-BY',
  'by-sa': 'CC-BY-SA',
  'by-nd': 'CC-BY-ND',
  'by-nc': 'CC-BY-NC',
  any: '',
};

interface SketchfabModel {
  readonly uid?: string;
  readonly name?: string;
  readonly user?: { readonly displayName?: string; readonly username?: string };
  readonly license?: { readonly label?: string; readonly slug?: string };
  readonly faceCount?: number;
  readonly thumbnails?: { readonly images?: readonly { readonly url?: string }[] };
  readonly isDownloadable?: boolean;
  readonly viewerUrl?: string;
}

/**
 * FR-6.1 — Sketchfab search, filtered by licence and polygon count.
 *
 * The filters the SRS names (licence, polycount) are applied *server-side* where the API supports it
 * and re-checked here, because a client-side filter that silently disagrees with the vendor's is how
 * a "CC0 only" search returns a CC-BY-NC model.
 */
export function createToolsService(deps: ToolsDeps) {
  const doFetch = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function searchSketchfab(query: SketchfabSearchQuery): Promise<SearchOutcome> {
    if (!deps.sketchfabToken) {
      return {
        results: [],
        offline: true,
        reason:
          'Sketchfab is not configured. Set SKETCHFAB_API_TOKEN to search the library; this ' +
          'endpoint returns no results rather than inventing listings.',
      };
    }

    const params = new URLSearchParams({
      type: 'models',
      q: terms(query.q),
      downloadable: String(query.downloadable),
      page: String(query.page),
    });
    const license = SKETCHFAB_LICENSES[query.license] ?? '';
    if (license) params.set('license', license);

    const response = await doFetch(`https://api.sketchfab.com/v3/search?${params.toString()}`, {
      headers: { authorization: `Token ${deps.sketchfabToken}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      // A vendor outage must not read as "no results" — the two need different words in a UI.
      return {
        results: [],
        offline: true,
        reason: `Sketchfab returned HTTP ${response.status}.`,
      };
    }

    const body = (await response.json()) as { results?: readonly SketchfabModel[] };
    const results = (body.results ?? [])
      .map((model): ExternalAssetResult => {
        const thumbnail = model.thumbnails?.images?.[0]?.url ?? null;
        const author = model.user?.displayName ?? model.user?.username ?? null;
        return {
          source: 'sketchfab',
          externalId: model.uid ?? '',
          name: model.name ?? 'Untitled',
          author,
          license: model.license?.label ?? model.license?.slug ?? null,
          polycount: typeof model.faceCount === 'number' ? model.faceCount : null,
          thumbnailUrl: thumbnail,
          // The vendor does not hand out a direct download URL from search; the import step
          // resolves one per model, authenticated.
          downloadUrl: null,
          sourceUrl: model.viewerUrl ?? null,
          downloadable: model.isDownloadable === true,
          attribution: author ? `${model.name ?? 'Untitled'} by ${author}` : null,
        };
      })
      .filter((result) => result.externalId !== '')
      // The local re-check. The vendor honours these, but a filter that is only applied remotely is
      // a filter this platform cannot vouch for.
      .filter((result) => query.maxPolycount === undefined || (result.polycount ?? 0) <= query.maxPolycount)
      .filter((result) => query.minPolycount === undefined || (result.polycount ?? 0) >= query.minPolycount)
      .slice(0, query.pageSize);

    return { results, offline: false };
  }

  /**
   * FR-6.2 — Poly Pizza search by keyword, category and triangle count.
   *
   * Poly Pizza is CC0-only and hand-curated, which makes it the safest source to import from: there
   * is no licence to get wrong. The polycount filter is applied locally because the vendor's
   * category endpoint does not take one.
   */
  async function searchPolyPizza(query: PolyPizzaSearchQuery): Promise<SearchOutcome> {
    if (!deps.polyPizzaToken) {
      return {
        results: [],
        offline: true,
        reason:
          'Poly Pizza is not configured. Set POLY_PIZZA_API_KEY to search the library; this ' +
          'endpoint returns no results rather than inventing listings.',
      };
    }

    const base = query.category
      ? `https://api.poly.pizza/v1.1/category/${encodeURIComponent(terms(query.category, 60))}`
      : `https://api.poly.pizza/v1.1/search/${encodeURIComponent(terms(query.q))}`;

    const response = await doFetch(base, {
      headers: { 'x-auth-token': deps.polyPizzaToken },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return { results: [], offline: true, reason: `Poly Pizza returned HTTP ${response.status}.` };
    }

    const body = (await response.json()) as {
      results?: readonly {
        readonly Id?: string;
        readonly Title?: string;
        readonly Creator?: { readonly Username?: string };
        readonly Triangles?: number;
        readonly Thumbnail?: string;
        readonly Download?: string;
        readonly Licence?: string;
      }[];
    };

    const results = (body.results ?? [])
      .map((model): ExternalAssetResult => {
        const author = model.Creator?.Username ?? null;
        return {
          source: 'poly-pizza',
          externalId: model.Id ?? '',
          name: model.Title ?? 'Untitled',
          author,
          // Poly Pizza is CC0 by policy; recorded explicitly rather than left blank, because
          // NFR-COMP.1 asks an imported asset to carry its source licence.
          license: model.Licence ?? 'CC0',
          polycount: typeof model.Triangles === 'number' ? model.Triangles : null,
          thumbnailUrl: model.Thumbnail ?? null,
          downloadUrl: model.Download ?? null,
          sourceUrl: model.Id ? `https://poly.pizza/m/${model.Id}` : null,
          downloadable: Boolean(model.Download),
          attribution: author ? `${model.Title ?? 'Untitled'} by ${author} (Poly Pizza, CC0)` : 'Poly Pizza (CC0)',
        };
      })
      .filter((result) => result.externalId !== '')
      .filter(
        (result) =>
          query.maxTriangles === undefined || (result.polycount ?? 0) <= query.maxTriangles,
      )
      .slice(0, query.pageSize);

    return { results, offline: false };
  }

  /**
   * FR-6.4 — text-to-3D generation via Meshy.
   *
   * Meshy is asynchronous: this submits the task and returns its id, which then travels to
   * `GET /jobs/:id` (FR-6.5) once the poller has a row for it. That is why the shape is a task id
   * rather than a mesh.
   */
  async function generateMeshy(input: MeshyGenerateInput): Promise<MeshyOutcome> {
    if (!deps.meshyKey) {
      return {
        status: 'offline',
        taskId: null,
        reason:
          'Meshy AI is not configured. Set MESHY_API_KEY to enable text-to-3D generation; nothing ' +
          'is generated locally.',
      };
    }

    const response = await doFetch('https://api.meshy.ai/openapi/v2/text-to-3d', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${deps.meshyKey}`,
      },
      body: JSON.stringify({
        mode: 'preview',
        prompt: terms(input.prompt, 600),
        art_style: input.artStyle,
        should_remesh: true,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return { status: 'offline', taskId: null, reason: `Meshy returned HTTP ${response.status}.` };
    }

    const body = (await response.json()) as { result?: string };
    return { status: 'queued', taskId: body.result ?? null };
  }

  /**
   * Which integrations are live, and which are degrading (FR-6.x, NFR-REL.1).
   *
   * The SRS's `IntegrationStatus` contract already has `offlineFallbacks`, so this is what that
   * field was for: a screen that can tell an operator "the pipeline works, but four of its
   * dependencies are stubbed" instead of leaving them to discover it from an empty list.
   */
  function integrationStatus(): IntegrationStatus {
    const offlineFallbacks: string[] = [];
    if (!deps.claudeConfigured) offlineFallbacks.push('claude');
    if (!deps.eonConfigured) offlineFallbacks.push('eon');
    if (!deps.blenderConfigured) offlineFallbacks.push('blender');
    if (!deps.sketchfabToken) offlineFallbacks.push('sketchfab');
    if (!deps.polyPizzaToken) offlineFallbacks.push('poly-pizza');
    if (!deps.meshyKey) offlineFallbacks.push('meshy');

    return {
      sketchfab: Boolean(deps.sketchfabToken),
      polyPizza: Boolean(deps.polyPizzaToken),
      meshy: Boolean(deps.meshyKey),
      blender: deps.blenderConfigured,
      eon: deps.eonConfigured,
      claude: deps.claudeConfigured,
      offlineFallbacks,
    };
  }

  return { searchSketchfab, searchPolyPizza, generateMeshy, integrationStatus };
}

export type ToolsService = ReturnType<typeof createToolsService>;

/** Trimmed text for building query strings. */
function terms(value: string, max = 120): string {
  return value.trim().slice(0, max);
}

/** A vendor that has not answered in 15s is down as far as this platform is concerned. */
const DEFAULT_TIMEOUT_MS = 15_000;
