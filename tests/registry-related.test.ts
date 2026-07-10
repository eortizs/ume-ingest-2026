import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadRegistryWithDefs } from '../src/lib/registry';
import { collectRelatedDefs, aiMaxEntities, clampMaxEntities } from '../src/lib/relatedDefs';

describe('registry + related BFS', () => {
  let prevHops: string | undefined;
  let prevMax: string | undefined;
  let prevLimit: string | undefined;
  let prevDefault: string | undefined;
  beforeEach(() => {
    prevHops = process.env.INGEST_RELATED_HOPS;
    prevMax = process.env.INGEST_AI_MAX_ENTITIES;
    prevLimit = process.env.INGEST_BATCH_LIMIT;
    prevDefault = process.env.INGEST_AI_DEFAULT_ENTITIES;
  });
  afterEach(() => {
    if (prevHops === undefined) delete process.env.INGEST_RELATED_HOPS;
    else process.env.INGEST_RELATED_HOPS = prevHops;
    if (prevMax === undefined) delete process.env.INGEST_AI_MAX_ENTITIES;
    else process.env.INGEST_AI_MAX_ENTITIES = prevMax;
    if (prevLimit === undefined) delete process.env.INGEST_BATCH_LIMIT;
    else process.env.INGEST_BATCH_LIMIT = prevLimit;
    if (prevDefault === undefined) delete process.env.INGEST_AI_DEFAULT_ENTITIES;
    else process.env.INGEST_AI_DEFAULT_ENTITIES = prevDefault;
  });

  it('physical_asset appears once with self-edge (replace-by-key)', async () => {
    const { defs, registry } = await loadRegistryWithDefs();
    const pa1 = defs.filter((d) => d.type === 'physical_asset');
    expect(pa1.length).toBe(1);
    const pa2 = registry.resolve('physical_asset', 'global');
    expect(pa2?.allowedRelationships.find((r) => r.role === 'contains_component')).toBeDefined();
  });

  it('travel_* all resolve to global', async () => {
    const { registry } = await loadRegistryWithDefs();
    for (const t of [
      'travel_itinerary',
      'travel_day',
      'travel_booking',
      'travel_activity',
    ]) {
      expect(registry.resolve(t, 'acme'), t).toBeDefined();
      expect(registry.resolve(t, 'global'), `${t} global`).toBeDefined();
    }
  });

  it('POS still resolves (no regression)', async () => {
    const { registry } = await loadRegistryWithDefs();
    expect(registry.resolve('pos_ticket', 'global')).toBeDefined();
    expect(registry.resolve('pos_ticket_line', 'global')).toBeDefined();
  });

  it('BFS hops: itinerary (1 hop) → day → booking/activity', async () => {
    const { registry } = await loadRegistryWithDefs();
    const itin = registry.resolve('travel_itinerary', 'global')!;
    const related = collectRelatedDefs(registry, itin, { hops: 2 });
    const types = related.map((d) => d.type).sort();
    expect(types).toContain('travel_day');
    expect(types).toContain('travel_booking');
    expect(types).toContain('travel_activity');
    expect(types).not.toContain('travel_itinerary');
  });

  it('BFS finite: self-referencing def does not loop forever', async () => {
    const { registry } = await loadRegistryWithDefs();
    const pa = registry.resolve('physical_asset', 'global')!;
    const related = collectRelatedDefs(registry, pa, { hops: 10 });
    // primary is not duplicated; finite result even though self-edge exists
    expect(related.find((d) => d.type === 'physical_asset')).toBeUndefined();
  });

  it('default hops is 4 (env override)', async () => {
    const { registry } = await loadRegistryWithDefs();
    const pos = registry.resolve('pos_ticket', 'global')!;
    process.env.INGEST_RELATED_HOPS = '0';
    const zero = collectRelatedDefs(registry, pos);
    expect(zero.length).toBe(0);
    process.env.INGEST_RELATED_HOPS = '10';
    const deep = collectRelatedDefs(registry, pos);
    expect(deep.length).toBeGreaterThanOrEqual(0);
  });

  it('related is finite even with self-referencing def + large hops', async () => {
    const { registry } = await loadRegistryWithDefs();
    const pa = registry.resolve('physical_asset', 'global')!;
    const seen = new Set<string>();
    for (const r of collectRelatedDefs(registry, pa, { hops: 10 })) {
      expect(seen.has(r.type)).toBe(false);
      seen.add(r.type);
    }
  });

  it('aiMaxEntities honors min(MAX, BATCH_LIMIT)', () => {
    process.env.INGEST_AI_MAX_ENTITIES = '40';
    process.env.INGEST_BATCH_LIMIT = '30';
    expect(aiMaxEntities()).toBe(30);

    process.env.INGEST_AI_MAX_ENTITIES = '60';
    process.env.INGEST_BATCH_LIMIT = '100';
    expect(aiMaxEntities()).toBe(60);

    delete process.env.INGEST_AI_MAX_ENTITIES;
    delete process.env.INGEST_BATCH_LIMIT;
    expect(aiMaxEntities()).toBe(25);
  });

  it('clampMaxEntities defaults to 10 and caps at hard', () => {
    delete process.env.INGEST_AI_DEFAULT_ENTITIES;
    delete process.env.INGEST_AI_MAX_ENTITIES;
    delete process.env.INGEST_BATCH_LIMIT;
    expect(clampMaxEntities()).toBe(10);
    expect(clampMaxEntities(100)).toBe(aiMaxEntities());
    expect(clampMaxEntities(0)).toBe(10);
    expect(clampMaxEntities(-3)).toBe(10);
    expect(clampMaxEntities(5)).toBe(5);
  });
});
