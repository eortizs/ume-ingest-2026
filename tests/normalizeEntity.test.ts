import { describe, it, expect } from 'vitest';
import {
  normalizeEntity,
  normalizeEntityDetailed,
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

  it('forceTenantId overrides provided tenantId', () => {
    const e = normalizeEntity(
      {
        name: 'X',
        type: 'task',
        tenantId: 'wrong',
      },
      { forceTenantId: 'forced' },
    );
    expect(e.tenantId).toBe('forced');
  });

  it('forceTenantId fills missing tenantId', () => {
    const e = normalizeEntity(
      {
        name: 'X',
        type: 'task',
      },
      { forceTenantId: 'forced' },
    );
    expect(e.tenantId).toBe('forced');
  });

  it('stripUnknownRoots drops illegal root fields and reports them', () => {
    const r = normalizeEntityDetailed(
      {
        name: 'X',
        type: 'task',
        tenantId: 'acme',
        status: 'open',
        extra: 1,
      },
      { stripUnknownRoots: true },
    );
    expect(r.entity.tenantId).toBe('acme');
    expect(r.stripped.sort()).toEqual(['extra', 'status']);
    expect((r.entity as unknown as Record<string, unknown>).status).toBeUndefined();
  });

  it('aliased report lists rewritten keys (e.g. tenant)', () => {
    const r = normalizeEntityDetailed(
      {
        name: 'X',
        type: 'task',
        tenant: 'acme',
      },
      {},
    );
    expect(r.aliased).toContain('tenant');
    expect(r.entity.tenantId).toBe('acme');
  });
});