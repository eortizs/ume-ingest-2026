import { describe, it, expect } from 'vitest';
import { createUUIDv7, type Entity } from 'ume-standard';
import { loadRegistryWithDefs } from '../src/lib/registry';
import { validateShapeBatch } from '../src/lib/validateBatch';
import {
  topoSortBatch,
  findMissingTargets,
} from '../src/lib/graphCommit';
import {
  normalizeEntity,
  normalizeEntityDetailed,
  NormalizationError,
} from '../src/lib/normalizeEntity';

function mk(
  type: string,
  props: Record<string, unknown> = {},
  rels: Entity['relationships'] = [],
  name?: string,
): Entity {
  const ent = normalizeEntity({
    id: createUUIDv7(),
    name: name ?? `${type}-${props.asset_class ?? 'item'}`,
    type,
    tenantId: 'acme',
    properties: props,
    relationships: rels,
  });
  return ent;
}

function edge(
  role: string,
  targetId: string,
  targetType: string,
  props?: Record<string, unknown>,
): Entity['relationships'][number] {
  const r: Entity['relationships'][number] = {
    role,
    targetId,
    targetType,
    direction: 'outgoing',
  };
  if (props) r.properties = props;
  return r;
}

describe('infinite-depth vertical composition (offline)', () => {
  it('local pack overlays physical_asset with union props + self-edge', async () => {
    const { defs } = await loadRegistryWithDefs();
    const pa = defs.find((d) => d.type === 'physical_asset');
    expect(pa).toBeDefined();
    expect(pa!.tenant).toBe('global');
    expect(pa!.allowedRelationships.length).toBe(1);
    const rel = pa!.allowedRelationships[0];
    expect(rel.role).toBe('contains_component');
    expect(rel.allowedTargetTypes).toEqual(['physical_asset']);
    expect(rel.relationshipPropertiesSchema).toBeDefined();
    const props = (pa!.propertiesSchema as Record<string, unknown>)
      .properties as Record<string, unknown>;
    expect(props.brand).toBeDefined();
    expect(props.model).toBeDefined();
    expect(props.serial_number).toBeDefined();
    expect(props.asset_class).toBeDefined();
    expect(props.specifications).toBeDefined();
  });

  it('travel pack resolves: itinerary -> day -> booking + activity', async () => {
    const { registry } = await loadRegistryWithDefs();
    for (const t of [
      'travel_itinerary',
      'travel_day',
      'travel_booking',
      'travel_activity',
    ]) {
      const d = registry.resolve(t, 'global');
      expect(d, `resolve ${t}`).toBeDefined();
    }
    const itin = registry.resolve('travel_itinerary', 'global')!;
    expect(
      itin.allowedRelationships.find((r) => r.role === 'has_day')?.allowedTargetTypes,
    ).toEqual(['travel_day']);
    const day = registry.resolve('travel_day', 'global')!;
    expect(
      day.allowedRelationships.find((r) => r.role === 'has_booking')
        ?.allowedTargetTypes,
    ).toEqual(['travel_booking']);
    expect(
      day.allowedRelationships.find((r) => r.role === 'has_activity')
        ?.allowedTargetTypes,
    ).toEqual(['travel_activity']);
  });

  it('no duplicate physical_asset in registry summary', async () => {
    const { defs } = await loadRegistryWithDefs();
    const pa = defs.filter((d) => d.type === 'physical_asset');
    expect(pa.length).toBe(1);
  });

  it('brand-only physical_asset payload stays shape-OK under overlay', async () => {
    const { registry } = await loadRegistryWithDefs();
    const pa = registry.resolve('physical_asset', 'global')!;
    const ent = mk('physical_asset', {
      brand: 'ACME',
      model: 'M1',
      serial_number: 'SN-1',
    });
    expect(ent.tenantId).toBe('acme');
    const r = validateShapeBatch([ent], registry);
    expect(r.ok).toBe(true);
    expect(pa.allowedRelationships[0].role).toBe('contains_component');
  });

  it('5-level hotel chain (parent->child): topo + shape OK with critical edge on fixture -> part', async () => {
    const { registry } = await loadRegistryWithDefs();
    const tenantId = 'acme';
    const part = mk(
      'physical_asset',
      { asset_class: 'part', serial_number: 'P-001' },
      [],
      'Valve cartridge',
    );
    const fixture = mk(
      'physical_asset',
      { asset_class: 'fixture', model: 'F-01' },
      [edge('contains_component', part.id, 'physical_asset', {
        relevance: 'critical',
        criticality_score: 0.95,
        reason: 'critical valve part',
      })],
      'Faucet',
    );
    const bath = mk(
      'physical_asset',
      { asset_class: 'bathroom', serial_number: 'B-101' },
      [edge('contains_component', fixture.id, 'physical_asset', {
        relevance: 'medium',
        criticality_score: 0.6,
        reason: 'fixture inside bath',
      })],
      'Bath 101',
    );
    const room = mk(
      'physical_asset',
      { asset_class: 'room', serial_number: 'R-101' },
      [edge('contains_component', bath.id, 'physical_asset', {
        relevance: 'low',
        criticality_score: 0.3,
        reason: 'bath inside room',
      })],
      'Room 101',
    );
    const hotel = mk(
      'physical_asset',
      { asset_class: 'hotel', brand: 'Hilton' },
      [edge('contains_component', room.id, 'physical_asset', {
        relevance: 'medium',
        criticality_score: 0.7,
        reason: 'room inside hotel',
      })],
      'Hilton NYC',
    );

    const entities: Entity[] = [hotel, room, bath, fixture, part];
    for (const e of entities) e.tenantId = tenantId;

    const shape = validateShapeBatch(entities, registry);
    expect(shape.ok).toBe(true);

    const ordered = topoSortBatch(entities);
    const ids = ordered.map((e) => e.id);
    // parent->child: targets-first; leaf (part) commits first, root (hotel) last
    expect(ids.indexOf(part.id)).toBeLessThan(ids.indexOf(fixture.id));
    expect(ids.indexOf(fixture.id)).toBeLessThan(ids.indexOf(bath.id));
    expect(ids.indexOf(bath.id)).toBeLessThan(ids.indexOf(room.id));
    expect(ids.indexOf(room.id)).toBeLessThan(ids.indexOf(hotel.id));

    const fixtureEntity = entities.find((e) => e.id === fixture.id)!;
    const partEdge = fixtureEntity.relationships[0];
    expect(partEdge.properties?.relevance).toBe('critical');
    expect(partEdge.targetId).toBe(part.id);
    expect(partEdge.role).toBe('contains_component');

    const missing = findMissingTargets(entities, new Set());
    expect(missing).toEqual([]);
  });

  it('negative: relevance "high" fails shape', async () => {
    const { registry } = await loadRegistryWithDefs();
    const hotel = mk('physical_asset', { asset_class: 'hotel' }, [], 'H');
    const room = mk(
      'physical_asset',
      { asset_class: 'room' },
      [edge('contains_component', hotel.id, 'physical_asset', {
        relevance: 'high',
        criticality_score: 0.5,
      })],
      'R',
    );
    const r = validateShapeBatch([hotel, room], registry);
    expect(r.ok).toBe(false);
    const row = r.rows.find((x) => !x.ok);
    expect(row?.errors?.[0].message).toMatch(/relevance|enum|allowed values/i);
  });

  it('negative: missing edge required property fails shape', async () => {
    const { registry } = await loadRegistryWithDefs();
    const hotel = mk('physical_asset', { asset_class: 'hotel' }, [], 'H');
    const room = mk(
      'physical_asset',
      { asset_class: 'room' },
      // missing criticality_score (required by schema)
      [edge('contains_component', hotel.id, 'physical_asset', {
        relevance: 'critical',
      })],
      'R',
    );
    const r = validateShapeBatch([hotel, room], registry);
    expect(r.ok).toBe(false);
  });

  it('normalize keeps required-only payload valid (no asset_class required)', () => {
    const ent = normalizeEntityDetailed({
      name: 'X',
      type: 'physical_asset',
      tenantId: 'acme',
      properties: { brand: 'X' },
    });
    expect(ent.entity.properties.brand).toBe('X');
  });

  it('normalize rejects illegal root when stripUnknownRoots is off', () => {
    expect(() =>
      normalizeEntity({
        name: 'X',
        type: 'physical_asset',
        tenantId: 'acme',
        status: 'open',
      }),
    ).toThrow(NormalizationError);
  });
});
