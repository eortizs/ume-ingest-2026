import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TypeRegistry, type EntityTypeDefinition } from 'ume-standard';
import {
  extractWithLlm,
  parseAgentResponse,
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

function makeRegistry(def: EntityTypeDefinition): TypeRegistry {
  const reg = new TypeRegistry();
  reg.add(def);
  return reg;
}

const taskDef: EntityTypeDefinition = {
  type: 'task',
  tenant: 'acme',
  propertiesSchema: {
    type: 'object',
    properties: { status: { type: 'string' } },
    additionalProperties: true,
  },
  allowedRelationships: [],
};

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
        typeDef: taskDef,
      },
      'k',
      'm',
      makeRegistry(taskDef),
    );
    expect(r.ok).toBe(true);
    expect(r.entities[0].name).toBe('From LLM');
    expect(r.entities[0].lifecycle.state).toBe('created');
    expect(r.entities[0].createdBy).toBe('ingest:ai-agent');
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
        typeDef: taskDef,
      },
      'k',
      'm',
      makeRegistry(taskDef),
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
        typeDef: taskDef,
      },
      'k',
      'm',
      makeRegistry(taskDef),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/LLM failed after 3 attempts/);
  });

  it('parseAgentResponse extracts thinking + entities', () => {
    const text = `<thinking>
The text describes a single task.
</thinking>
\`\`\`json
{"entities":[{"name":"A","type":"task","tenantId":"acme"}]}
\`\`\``;
    const r = parseAgentResponse(text);
    expect(r.thinking).toMatch(/single task/);
    expect(r.entities).toHaveLength(1);
  });

  it('parseAgentResponse reads thinking field inside JSON envelope', () => {
    const r = parseAgentResponse(
      JSON.stringify({
        thinking: 'CoT in field',
        entities: [{ name: 'A', type: 'task', tenantId: 'acme' }],
      }),
    );
    expect(r.thinking).toBe('CoT in field');
    expect(r.entities).toHaveLength(1);
  });

  it('parseAgentResponse accepts raw JSON', () => {
    const r = parseAgentResponse(
      '{"entities":[{"name":"A","type":"task","tenantId":"acme"}]}',
    );
    expect(r.entities).toHaveLength(1);
  });

  it('parseAgentResponse throws on non-JSON', () => {
    expect(() => parseAgentResponse('not json')).toThrow(/not valid JSON/);
  });

  it('parseAgentResponse throws when entities array missing', () => {
    expect(() =>
      parseAgentResponse(JSON.stringify({ thinking: 'x' })),
    ).toThrow(/no "entities" array/);
  });
});