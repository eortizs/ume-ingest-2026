import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TypeRegistry, type EntityTypeDefinition } from 'ume-standard';
import {
  extractWithLlm,
  __test_hooks,
  type FetchLike,
} from '../src/lib/llmExtractor';
import { loadRegistryWithDefs } from '../src/lib/registry';
import { validateShapeBatch } from '../src/lib/validateBatch';

function jsonResponse(payload: unknown): ReturnType<FetchLike> {
  return Promise.resolve({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(payload),
    json: async () => payload,
  });
}

describe('ingest-ai POS composition (mocked)', () => {
  let originalFetch: typeof fetch | undefined;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    if (originalFetch) globalThis.fetch = originalFetch as typeof fetch;
    __test_hooks.setFetch(null);
  });

  it('local pack resolves pos_ticket + pos_ticket_line', async () => {
    const { registry } = await loadRegistryWithDefs();
    const t = registry.resolve('pos_ticket', 'global');
    const l = registry.resolve('pos_ticket_line', 'global');
    expect(t?.type).toBe('pos_ticket');
    expect(l?.type).toBe('pos_ticket_line');
    expect(t?.allowedRelationships[0]?.relationshipPropertiesSchema).toBeDefined();
  });

  it('multi-entity composition with canon fields, force tenantId', async () => {
    const { registry, defs } = await loadRegistryWithDefs();
    const ticketDef = defs.find((d: EntityTypeDefinition) => d.type === 'pos_ticket')!;
    const lineDef = defs.find((d: EntityTypeDefinition) => d.type === 'pos_ticket_line')!;
    expect(ticketDef).toBeDefined();
    expect(lineDef).toBeDefined();

    const ticketId = '01900000-0000-7000-8000-000000000010';
    const lineId = '01900000-0000-7000-8000-000000000011';

    const fakeFetch: FetchLike = async () =>
      jsonResponse({
        choices: [
          {
            message: {
              role: 'assistant',
              content: `<thinking>
The text mentions a ticket total $42.50 USD at ACME with one line "Coffee x2 @ $5".
Plan: emit pos_ticket (parent) and pos_ticket_line (child) connected via contains_line with critical relevance.
</thinking>
\`\`\`json
{
  "entities": [
    {
      "id": "${ticketId}",
      "type": "pos_ticket",
      "tenantId": "wrong-tenant-should-be-overridden",
      "name": "ACME Coffee Ticket",
      "properties": { "total": 42.5, "currency": "USD", "merchant": "ACME" }
    },
    {
      "id": "${lineId}",
      "type": "pos_ticket_line",
      "tenantId": "wrong",
      "name": "Coffee x2",
      "properties": { "sku": "CFE-1", "description": "Coffee", "quantity": 2, "unit_price": 5, "subtotal": 10 },
      "relationships": [
        {
          "role": "belongs_to_ticket",
          "targetId": "${ticketId}",
          "targetType": "pos_ticket",
          "direction": "outgoing"
        }
      ]
    },
    {
      "id": "${ticketId}",
      "type": "pos_ticket",
      "name": "ACME Coffee Ticket",
      "tenantId": "acme",
      "properties": { "total": 42.5, "currency": "USD", "merchant": "ACME" },
      "relationships": [
        {
          "role": "contains_line",
          "targetId": "${lineId}",
          "targetType": "pos_ticket_line",
          "direction": "outgoing",
          "properties": { "relevance": "critical", "criticality_score": 0.9, "reason": "primary line" }
        }
      ]
    }
  ]
}
\`\`\``,
            },
          },
        ],
      });
    __test_hooks.setFetch(fakeFetch);

    const r = await extractWithLlm(
      {
        text: 'ACME Coffee Ticket — total $42.50 USD. 1 line: Coffee x2 @ $5.',
        targetType: 'pos_ticket',
        tenantId: 'acme',
        typeDef: ticketDef,
        relatedDefs: [lineDef],
        maxEntities: 5,
      },
      'k',
      'm',
      registry,
    );

    expect(r.ok).toBe(true);
    expect(r.entities.length).toBeGreaterThanOrEqual(2);
    for (const e of r.entities) expect(e.tenantId).toBe('acme');
    expect(r.thinking).toMatch(/Coffee/);

    const ticket = r.entities.find((e) => e.type === 'pos_ticket');
    expect(ticket).toBeDefined();
    const line = r.entities.find((e) => e.type === 'pos_ticket_line');
    expect(line).toBeDefined();
    expect(line!.relationships.some((rel) => rel.targetId === ticketId)).toBe(true);

    const shape = validateShapeBatch(r.entities, registry);
    expect(shape.ok).toBe(true);
  });

  it('relevance "high" fails shape against pos schema', async () => {
    const { registry, defs } = await loadRegistryWithDefs();
    const ticketDef = defs.find((d: EntityTypeDefinition) => d.type === 'pos_ticket')!;
    const lineDef = defs.find((d: EntityTypeDefinition) => d.type === 'pos_ticket_line')!;

    const ticketId = '01900000-0000-7000-8000-000000000020';
    const lineId = '01900000-0000-7000-8000-000000000021';

    const fakeFetch: FetchLike = async () =>
      jsonResponse({
        choices: [
          {
            message: {
              role: 'assistant',
              content: JSON.stringify({
                entities: [
                  {
                    id: ticketId,
                    type: 'pos_ticket',
                    name: 'T',
                    tenantId: 'acme',
                    properties: { total: 1, currency: 'USD' },
                  },
                  {
                    id: lineId,
                    type: 'pos_ticket_line',
                    name: 'L',
                    tenantId: 'acme',
                    properties: { quantity: 1, unit_price: 1, subtotal: 1 },
                  },
                  {
                    id: ticketId,
                    type: 'pos_ticket',
                    name: 'T',
                    tenantId: 'acme',
                    properties: { total: 1, currency: 'USD' },
                    relationships: [
                      {
                        role: 'contains_line',
                        targetId: lineId,
                        targetType: 'pos_ticket_line',
                        direction: 'outgoing',
                        properties: { relevance: 'high', criticality_score: 0.5 },
                      },
                    ],
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
        text: 'a ticket with bad relevance',
        targetType: 'pos_ticket',
        tenantId: 'acme',
        typeDef: ticketDef,
        relatedDefs: [lineDef],
        maxEntities: 5,
      },
      'k',
      'm',
      registry,
    );

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/shape validation failed/);
  });
});