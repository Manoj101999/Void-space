/**
 * AI metadata enrichment (SRS FR-7.1–FR-7.7).
 *
 * Two interchangeable implementations behind one interface:
 *
 * - `createAnthropicEnricher` — the Claude API, asked for strict JSON (FR-7.1, FR-7.2);
 * - `createOfflineEnricher` — a deterministic heuristic used when no API key is configured,
 *   so the pipeline still completes end to end (NFR-REL.1) and tests need no network.
 *
 * FR-7.7 requires the model and prompt versions plus the latency to be recorded for every
 * suggestion, so both implementations report them.
 */
import { z } from 'zod';

/** The exact shape the model must return (FR-7.3 — validated, never trusted). */
export const enrichmentSchema = z.object({
  tags: z.array(z.string().min(1).max(40)).min(3).max(12),
  description: z.string().min(20).max(600),
  qualityFlags: z.array(z.string().min(1).max(40)).max(8),
  confidence: z.number().min(0).max(1),
});
export type EnrichmentResult = z.infer<typeof enrichmentSchema>;

export interface EnrichmentInput {
  readonly name: string;
  readonly category: string;
  readonly format: string;
  readonly sizeBytes: number;
  readonly creatorTags: readonly string[];
  readonly sourceTool?: string | null;
  readonly mesh: {
    readonly polycount: number | null;
    readonly vertices: number | null;
    readonly materials: number | null;
    readonly animations: number | null;
    readonly textures: number | null;
  };
  /** FR-14.3 — the tenant's polycount budget, used for quality flagging. */
  readonly polycountBudget: number | null;
  /** Attempt 2 uses a stricter prompt (§3.10 retry policy). */
  readonly strict: boolean;
}

export interface EnrichmentOutcome {
  readonly result: EnrichmentResult;
  readonly modelVersion: string;
  readonly promptVersion: string;
  readonly latencyMs: number;
  readonly rawResponse: unknown;
}

export interface Enricher {
  readonly modelVersion: string;
  enrich(input: EnrichmentInput): Promise<EnrichmentOutcome>;
}

export const PROMPT_VERSION = 'v1';
export const STRICT_PROMPT_VERSION = 'v1-strict';

/** Shared instruction text, so both prompt variants stay in sync. */
export function systemPrompt(strict: boolean): string {
  const base = [
    'You classify 3D assets for a Digital Asset Management platform.',
    'You receive metadata already extracted from the file (format, triangle count, texture',
    'and animation counts) plus the Creator-supplied name, category and tags.',
    'Reply with a single JSON object and nothing else — no prose, no markdown fences.',
    'Shape: {"tags": string[3..12], "description": string, "qualityFlags": string[], "confidence": number}',
    'tags: short lowercase keywords a person would search for (material, subject, style, use-case).',
    'description: one or two sentences describing what the asset depicts and how it is best used.',
    'qualityFlags: only real concerns you can justify from the supplied numbers,',
    'for example "high-polycount", "untextured", "no-animations", "large-file".',
    'confidence: your own certainty between 0 and 1. Be honest: low confidence is useful.',
  ].join(' ');

  return strict
    ? `${base} STRICT MODE: the previous answer failed validation. Every field is mandatory. ` +
        'tags must contain between 3 and 12 items; description must be at least 20 characters; ' +
        'confidence must be a number between 0 and 1. Output JSON only.'
    : base;
}

export function userPrompt(input: EnrichmentInput): string {
  return [
    `Name: ${input.name}`,
    `Category: ${input.category}`,
    `Format: ${input.format}`,
    `Size: ${(input.sizeBytes / (1024 * 1024)).toFixed(2)} MB`,
    `Creator tags: ${input.creatorTags.join(', ') || '(none)'}`,
    input.sourceTool ? `Source tool: ${input.sourceTool}` : 'Source tool: (unknown)',
    `Triangles: ${input.mesh.polycount ?? '(unknown)'}`,
    `Vertices: ${input.mesh.vertices ?? '(unknown)'}`,
    `Materials: ${input.mesh.materials ?? '(unknown)'}`,
    `Animations: ${input.mesh.animations ?? '(unknown)'}`,
    `Textures: ${input.mesh.textures ?? '(unknown)'}`,
    `Workspace polycount budget: ${input.polycountBudget ?? '(none set)'}`,
  ].join('\n');
}

/** Extracts a JSON object from a model reply, tolerating stray fences or prose. */
export function parseEnrichmentResponse(text: string): unknown {
  const withoutFences = text.replace(/```(?:json)?/gi, '').trim();
  const start = withoutFences.indexOf('{');
  const end = withoutFences.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('The model reply contained no JSON object');
  }
  return JSON.parse(withoutFences.slice(start, end + 1));
}

interface AnthropicMessageResponse {
  readonly content?: readonly { readonly type: string; readonly text?: string }[];
  readonly model?: string;
}

/** The real Claude-backed enricher (FR-7.1). */
export function createAnthropicEnricher(options: {
  readonly apiKey: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly fetchImpl?: typeof fetch;
}): Enricher {
  const doFetch = options.fetchImpl ?? fetch;

  return {
    modelVersion: options.model,
    async enrich(input) {
      const started = Date.now();
      const response = await doFetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': options.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: options.model,
          max_tokens: 1024,
          // Low temperature: classification should be repeatable, not creative.
          temperature: 0.2,
          system: systemPrompt(input.strict),
          messages: [{ role: 'user', content: userPrompt(input) }],
        }),
        signal: AbortSignal.timeout(options.timeoutMs),
      });

      if (!response.ok) {
        throw new Error(
          `Claude API returned HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`,
        );
      }

      const payload = (await response.json()) as AnthropicMessageResponse;
      const text = (payload.content ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('\n');

      // FR-7.3 — schema validation is the gate; a malformed reply throws and is retried.
      const result = enrichmentSchema.parse(parseEnrichmentResponse(text));

      return {
        result,
        modelVersion: payload.model ?? options.model,
        promptVersion: input.strict ? STRICT_PROMPT_VERSION : PROMPT_VERSION,
        latencyMs: Date.now() - started,
        rawResponse: payload,
      };
    },
  };
}

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'version',
  'final',
  'copy',
  'new',
  'asset',
  'model',
]);

/**
 * The offline fallback: deterministic heuristics over metadata the platform already holds.
 *
 * It deliberately reports *low* confidence. A heuristic cannot replace a vision model, and
 * the SRS treats AI output as a suggestion for a human (FR-7.5) — an honest confidence
 * value is what keeps the review queue meaningful.
 */
export function createOfflineEnricher(): Enricher {
  return {
    modelVersion: 'offline-heuristic-v1',
    async enrich(input) {
      const started = Date.now();

      const tokens = input.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .split(' ')
        .filter((token) => token.length > 2 && !STOP_WORDS.has(token));

      const tags = [
        ...new Set([
          ...input.creatorTags.map((tag) => tag.toLowerCase()),
          ...tokens,
          input.category.toLowerCase().replace(/\s+/g, '-'),
          input.format.replace('.', ''),
        ]),
      ].filter((tag) => tag.length > 1);

      // The schema requires at least three tags; pad from the category if the name is terse.
      while (tags.length < 3) {
        tags.push(`${input.category}-${tags.length + 1}`.toLowerCase().replace(/\s+/g, '-'));
      }

      const qualityFlags: string[] = [];
      if (
        input.polycountBudget &&
        input.mesh.polycount &&
        input.mesh.polycount > input.polycountBudget
      ) {
        qualityFlags.push('high-polycount');
      }
      if (input.mesh.textures === 0) qualityFlags.push('untextured');
      if (input.mesh.animations === 0) qualityFlags.push('no-animations');
      if (input.sizeBytes > 100 * 1024 * 1024) qualityFlags.push('large-file');
      if (input.mesh.polycount === null) qualityFlags.push('metadata-incomplete');

      const triangleText = input.mesh.polycount
        ? ` It contains roughly ${input.mesh.polycount.toLocaleString('en-US')} triangles.`
        : '';

      const description =
        `${input.name} is a ${input.category.toLowerCase()} asset supplied as ${input.format} ` +
        `(${(input.sizeBytes / (1024 * 1024)).toFixed(1)} MB).${triangleText} ` +
        'Classified by the built-in offline enricher because no Claude API key is configured; ' +
        'treat the tags below as a starting point and confirm them during review.';

      const result = enrichmentSchema.parse({
        tags: tags.slice(0, 12),
        description,
        qualityFlags,
        confidence: 0.35,
      });

      return {
        result,
        modelVersion: 'offline-heuristic-v1',
        promptVersion: input.strict ? STRICT_PROMPT_VERSION : PROMPT_VERSION,
        latencyMs: Date.now() - started,
        rawResponse: {
          source: 'offline',
          input: { name: input.name, category: input.category, format: input.format },
        },
      };
    },
  };
}

/** Chooses the enricher for this deployment (NFR-REL.1 graceful degradation). */
export function selectEnricher(options: {
  readonly apiKey: string | undefined;
  readonly model: string;
  readonly timeoutMs: number;
}): Enricher {
  return options.apiKey
    ? createAnthropicEnricher({
        apiKey: options.apiKey,
        model: options.model,
        timeoutMs: options.timeoutMs,
      })
    : createOfflineEnricher();
}
