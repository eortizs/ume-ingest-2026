import { describe, it, expect } from 'vitest';
import { runMapping, type IngestMapping } from '../src/lib/mappingEngine';

describe('mappingEngine', () => {
  const mapping: IngestMapping = {
    targetType: 'task',
    mapping: {
      id: 'generate_uuidv7()',
      name: 'source.title',
      tenantId: '__tenant__',
      properties: {
        status: 'source.status',
        priority: '#high',
      },
    },
  };

  it('maps CSV rows to entities with UUIDv7 ids', () => {
    const rows = [
      { source: { title: 'A', status: 'open' } },
      { source: { title: 'B', status: 'closed' } },
    ];
    const r = runMapping(rows, mapping, 'acme');
    expect(r.errors).toEqual([]);
    expect(r.entities).toHaveLength(2);
    expect(r.entities[0].name).toBe('A');
    expect(r.entities[0].tenantId).toBe('acme');
    expect((r.entities[0].properties as Record<string, unknown>).priority).toBe(
      'high',
    );
    expect((r.entities[0].id as string)).toMatch(/-7/);
  });

  it('reports missing path as row error and continues', () => {
    const r = runMapping(
      [{ status: 'open' }],
      {
        targetType: 'task',
        mapping: { name: 'source.title', properties: {} },
      },
      'acme',
    );
    expect(r.entities).toHaveLength(0);
    expect(r.errors).toEqual([{ index: 0, message: expect.stringMatching(/not found/) }]);
  });

  it('resolves literals via # prefix', () => {
    const r = runMapping(
      [{ name: 'X' }],
      {
        targetType: 'task',
        mapping: {
          name: '#CONST',
          tenantId: 'acme',
          properties: {},
        },
      },
    );
    expect(r.entities[0].name).toBe('CONST');
  });

  it('resolves flat CSV columns as simple field names', () => {
    const r = runMapping(
      [
        { title: 'A', status: 'open' },
        { title: 'B', status: 'closed' },
      ],
      {
        targetType: 'task',
        mapping: {
          name: 'title',
          properties: { title: 'title', status: 'status' },
        },
      },
      'acme',
    );
    expect(r.errors).toEqual([]);
    expect(r.entities).toHaveLength(2);
    expect(r.entities[0].name).toBe('A');
    expect(
      (r.entities[0].properties as Record<string, unknown>).title,
    ).toBe('A');
    expect(
      (r.entities[1].properties as Record<string, unknown>).status,
    ).toBe('closed');
  });
});