import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  extractWithLlm,
  __test_hooks,
  type FetchLike,
} from '../src/lib/llmExtractor';

function jsonResponse(payload: unknown): ReturnType<FetchLike> {
  return Promise.resolve({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(payload),
    json: async () => payload,
  });
}

describe('llmExtractor (mocked OpenRouter)', () => {
  let originalFetch: typeof fetch | undefined;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    if (originalFetch) {
      globalThis.fetch = originalFetch as typeof fetch;
    }
    __test_hooks.setFetch(null);
  });

  it('parses { entities: [...] } response and normalizes', async () => {
    const fakeFetch: FetchLike = async () =>
      jsonResponse({
        choices: [
          {
            message: {
              role: 'assistant',
              content: JSON.stringify({
                entities: [
                  {
                    name: 'From LLM',
                    type: 'task',
                    tenantId: 'acme',
                    properties: { status: 'open' },
                  },
                ],
              }),
            },
          },
        ],
      });
    __test_hooks.setFetch(fakeFetch);

    const r = await extractWithLlm(
      {
        text: 'do something',
        targetType: 'task',
        tenantId: 'acme',
        typeDef: {
          type: 'task',
          tenant: 'acme',
          propertiesSchema: {
            type: 'object',
            properties: { status: { type: 'string' } },
            additionalProperties: true,
          },
          allowedRelationships: [],
        },
      },
      'k',
      'm',
    );
    expect(r.ok).toBe(true);
    expect(r.entities[0].name).toBe('From LLM');
    expect(r.entities[0].lifecycle.state).toBe('created');
    expect(r.entities[0].createdBy).toBe('ingest:web');
  });

  it('self-heals on invalid JSON once', async () => {
    let calls = 0;
    const fakeFetch: FetchLike = async () => {
      calls++;
      if (calls === 1) {
        return jsonResponse({
          choices: [
            { message: { role: 'assistant', content: 'not json {' } },
          ],
        });
      }
      return jsonResponse({
        choices: [
          {
            message: {
              role: 'assistant',
              content: JSON.stringify({
                entities: [{ name: 'ok', type: 'task' }],
              }),
            },
          },
        ],
      });
    };
    __test_hooks.setFetch(fakeFetch);
    const r = await extractWithLlm(
      {
        text: 't',
        targetType: 'task',
        tenantId: 'acme',
        typeDef: {
          type: 'task',
          tenant: 'acme',
          propertiesSchema: { type: 'object', additionalProperties: true },
          allowedRelationships: [],
        },
      },
      'k',
      'm',
    );
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(r.ok).toBe(true);
  });

  it('fails hard after 3 attempts', async () => {
    const fakeFetch: FetchLike = async () =>
      jsonResponse({
        choices: [{ message: { role: 'assistant', content: 'garbage' } }],
      });
    __test_hooks.setFetch(fakeFetch);
    const r = await extractWithLlm(
      {
        text: 't',
        targetType: 'task',
        tenantId: 'acme',
        typeDef: {
          type: 'task',
          tenant: 'acme',
          propertiesSchema: { type: 'object', additionalProperties: true },
          allowedRelationships: [],
        },
      },
      'k',
      'm',
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/LLM failed after 3 attempts/);
  });
});