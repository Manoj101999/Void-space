/**
 * AI enrichment unit tests (SRS FR-7.1–FR-7.7).
 *
 * The offline enricher is the fallback that keeps the pipeline working without an API key
 * (NFR-REL.1), and the response parser is what stands between a chatty model and the
 * database — so both are tested directly rather than only through the queue.
 */
import { describe, expect, it } from 'vitest';

import {
  createAnthropicEnricher,
  createOfflineEnricher,
  enrichmentSchema,
  parseEnrichmentResponse,
  selectEnricher,
  systemPrompt,
  userPrompt,
  type EnrichmentInput,
} from '../src/lib/enricher';

function input(overrides: Partial<EnrichmentInput> = {}): EnrichmentInput {
  return {
    name: 'Industrial Safety Helmet',
    category: 'Safety Equipment',
    format: '.glb',
    sizeBytes: 4_500_000,
    creatorTags: ['helmet'],
    sourceTool: 'Blender',
    mesh: { polycount: 2500, vertices: 1500, materials: 2, animations: 1, textures: 1 },
    polycountBudget: 50_000,
    strict: false,
    ...overrides,
  };
}

describe('offline enricher', () => {
  it('produces a schema-valid suggestion', async () => {
    const outcome = await createOfflineEnricher().enrich(input());

    expect(() => enrichmentSchema.parse(outcome.result)).not.toThrow();
    expect(outcome.result.tags.length).toBeGreaterThanOrEqual(3);
    expect(outcome.result.description.length).toBeGreaterThanOrEqual(20);
    expect(outcome.modelVersion).toBe('offline-heuristic-v1');
    expect(outcome.promptVersion).toBe('v1');
    expect(outcome.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('reports low confidence, because a heuristic is not a vision model', async () => {
    const outcome = await createOfflineEnricher().enrich(input());
    expect(outcome.result.confidence).toBeLessThan(0.5);
  });

  it('derives tags from the name, category and format', async () => {
    const outcome = await createOfflineEnricher().enrich(input());
    expect(outcome.result.tags).toContain('helmet');
    expect(outcome.result.tags).toContain('safety-equipment');
    expect(outcome.result.tags).toContain('glb');
  });

  it('flags a polycount that exceeds the workspace budget', async () => {
    const outcome = await createOfflineEnricher().enrich(
      input({ polycountBudget: 1000, mesh: { ...input().mesh, polycount: 2500 } }),
    );
    expect(outcome.result.qualityFlags).toContain('high-polycount');
  });

  it('flags missing geometry metadata instead of inventing numbers', async () => {
    const outcome = await createOfflineEnricher().enrich(
      input({
        mesh: { polycount: null, vertices: null, materials: null, animations: null, textures: null },
      }),
    );
    expect(outcome.result.qualityFlags).toContain('metadata-incomplete');
  });

  it('pads tags to satisfy the schema when the name is terse', async () => {
    const outcome = await createOfflineEnricher().enrich(
      input({ name: 'A', creatorTags: [], category: 'X' }),
    );
    expect(outcome.result.tags.length).toBeGreaterThanOrEqual(3);
  });

  it('switches to the strict prompt version on the retry attempt', async () => {
    const outcome = await createOfflineEnricher().enrich(input({ strict: true }));
    expect(outcome.promptVersion).toBe('v1-strict');
  });
});

describe('model reply parsing', () => {
  it('accepts a bare JSON object', () => {
    const parsed = parseEnrichmentResponse(
      '{"tags":["a","b","c"],"description":"A reasonably long description here.","qualityFlags":[],"confidence":0.8}',
    );
    expect(enrichmentSchema.parse(parsed).confidence).toBe(0.8);
  });

  it('tolerates markdown fences and surrounding prose', () => {
    const parsed = parseEnrichmentResponse(
      'Sure! Here is the JSON:\n```json\n{"tags":["a","b","c"],"description":"A reasonably long description here.","qualityFlags":["untextured"],"confidence":0.5}\n```\nHope that helps.',
    );
    expect(enrichmentSchema.parse(parsed).tags).toEqual(['a', 'b', 'c']);
  });

  it('rejects a reply with no JSON object', () => {
    expect(() => parseEnrichmentResponse('I cannot help with that.')).toThrow(/no JSON object/);
  });

  it('rejects JSON that does not match the schema (FR-7.3)', () => {
    const parsed = parseEnrichmentResponse('{"tags":[],"description":"short","confidence":2}');
    expect(() => enrichmentSchema.parse(parsed)).toThrow();
  });
});

describe('prompt construction', () => {
  it('asks for JSON only and includes the extracted mesh numbers', () => {
    expect(systemPrompt(false)).toContain('single JSON object');

    const user = userPrompt(input());
    expect(user).toContain('Triangles: 2500');
    expect(user).toContain('Workspace polycount budget: 50000');
    expect(user).toContain('Category: Safety Equipment');
  });

  it('escalates the instructions in strict mode', () => {
    expect(systemPrompt(true)).toContain('STRICT MODE');
  });
});

describe('enricher selection', () => {
  it('falls back to the offline enricher without an API key (NFR-REL.1)', () => {
    expect(selectEnricher({ apiKey: undefined, model: 'x', timeoutMs: 1000 }).modelVersion).toBe(
      'offline-heuristic-v1',
    );
  });

  it('uses the Claude enricher when a key is configured', () => {
    expect(selectEnricher({ apiKey: 'sk-test', model: 'claude-test', timeoutMs: 1000 }).modelVersion).toBe(
      'claude-test',
    );
  });
});

describe('Anthropic enricher', () => {
  it('sends the documented request and parses the reply', async () => {
    let captured: { url: string; init: RequestInit } | undefined;

    const stubFetch = (async (url: string, init: RequestInit) => {
      captured = { url: String(url), init };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model: 'claude-sonnet-4-5-20250929',
          content: [
            {
              type: 'text',
              text: '{"tags":["helmet","safety","ppe"],"description":"A protective helmet for industrial use.","qualityFlags":[],"confidence":0.91}',
            },
          ],
        }),
        text: async () => '',
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const enricher = createAnthropicEnricher({
      apiKey: 'sk-test',
      model: 'claude-sonnet-4-5-20250929',
      timeoutMs: 5_000,
      fetchImpl: stubFetch,
    });

    const outcome = await enricher.enrich(input());

    expect(captured?.url).toBe('https://api.anthropic.com/v1/messages');
    const headers = captured?.init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-test');
    expect(headers['anthropic-version']).toBe('2023-06-01');

    const body = JSON.parse(String(captured?.init.body)) as { model: string; system: string };
    expect(body.model).toBe('claude-sonnet-4-5-20250929');
    expect(body.system).toContain('JSON');

    expect(outcome.result.confidence).toBe(0.91);
    expect(outcome.modelVersion).toBe('claude-sonnet-4-5-20250929');
    expect(outcome.promptVersion).toBe('v1');
  });

  it('surfaces an API error so the queue can retry it', async () => {
    const stubFetch = (async () =>
      ({
        ok: false,
        status: 529,
        text: async () => 'overloaded',
        json: async () => ({}),
      }) as unknown as Response) as unknown as typeof fetch;

    const enricher = createAnthropicEnricher({
      apiKey: 'sk-test',
      model: 'm',
      timeoutMs: 1000,
      fetchImpl: stubFetch,
    });

    await expect(enricher.enrich(input())).rejects.toThrow(/529/);
  });
});
