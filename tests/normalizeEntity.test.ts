import { describe, it, expect } from 'vitest';
import {
  normalizeEntity,
  NormalizationError,
} from '../src/lib/normalizeEntity';

describe('normalizeEntity', () => {
  it('forces 9 root fields, defaults lifecycle and createdBy', () => {
    const e = normalizeEntity({
      name: 'Foo',
      type: 'task',
      tenantId: 'acme',
      properties: { status: 'open' },
      relationships: [],
    });
    expect(e.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(e.lifecycle.state).toBe('created');
    expect(e.lifecycle.createdAt).toMatch(/T.*Z$/);
    expect(e.createdBy).toBe('ingest:web');
    expect(e.relationships).toEqual([]);
    expect(e.markdown).toBe('');
  });

  it('rewrites alias "tenant" -> "tenantId"', () => {
    const e = normalizeEntity({
      name: 'X',
      type: 'task',
      tenant: 'acme',
      properties: {},
    });
    expect(e.tenantId).toBe('acme');
  });

  it('throws on illegal root field', () => {
    expect(() =>
      normalizeEntity({
        name: 'X',
        type: 'task',
        tenantId: 'acme',
        foo: 'bar',
      }),
    ).toThrow(NormalizationError);
  });

  it('throws on missing type', () => {
    expect(() =>
      normalizeEntity({ name: 'X', tenantId: 'acme' }),
    ).toThrow(/type/);
  });

  it('throws on missing tenantId', () => {
    expect(() =>
      normalizeEntity({ name: 'X', type: 'task' }),
    ).toThrow(/tenantId/);
  });

  it('skips invalid relationships but keeps valid ones', () => {
    const e = normalizeEntity({
      name: 'X',
      type: 'task',
      tenantId: 'acme',
      properties: {},
      relationships: [
        { role: 'assigned_to', targetType: 'system_user', targetId: 'u1' },
        { role: 'broken' },
        null,
      ],
    });
    expect(e.relationships).toHaveLength(1);
    expect(e.relationships[0].role).toBe('assigned_to');
  });

  it('uses provided id when present', () => {
    const e = normalizeEntity({
      id: '01900000-0000-7000-8000-000000000001',
      name: 'X',
      type: 'task',
      tenantId: 'acme',
    });
    expect(e.id).toBe('01900000-0000-7000-8000-000000000001');
  });
});