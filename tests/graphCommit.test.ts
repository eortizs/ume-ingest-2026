import { describe, it, expect } from 'vitest';
import {
  topoSortBatch,
  findMissingTargets,
} from '../src/lib/graphCommit';
import type { Entity } from 'ume-standard';

function ent(id: string, type: string, rels: Entity['relationships'] = []): Entity {
  return {
    id,
    name: id,
    type,
    tenantId: 'acme',
    lifecycle: { state: 'created', createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z' },
    properties: {},
    relationships: rels,
    markdown: '',
    createdBy: 'ingest:test',
  };
}

describe('graphCommit', () => {
  it('topoSortBatch puts targets before sources', () => {
    const parent = ent('p', 'pos_ticket');
    const line = ent('l', 'pos_ticket_line', [
      { targetId: 'p', targetType: 'pos_ticket', role: 'belongs_to_ticket', direction: 'outgoing' },
    ]);
    const ticketWithLine = ent('t', 'pos_ticket', [
      { targetId: 'l', targetType: 'pos_ticket_line', role: 'contains_line', direction: 'outgoing' },
    ]);
    const ordered = topoSortBatch([ticketWithLine, parent, line]);
    const ids = ordered.map((e) => e.id);
    expect(ids.indexOf('l')).toBeLessThan(ids.indexOf('t'));
    expect(ids.indexOf('p')).toBeLessThan(ids.indexOf('l'));
  });

  it('topoSortBatch throws on cycle', () => {
    const a = ent('a', 'task', [
      { targetId: 'b', targetType: 'task', role: 'r', direction: 'outgoing' },
    ]);
    const b = ent('b', 'task', [
      { targetId: 'a', targetType: 'task', role: 'r', direction: 'outgoing' },
    ]);
    expect(() => topoSortBatch([a, b])).toThrow(/cycle/i);
  });

  it('findMissingTargets ignores in-batch targets', () => {
    const a = ent('a', 'task');
    const b = ent('b', 'task', [
      { targetId: 'a', targetType: 'task', role: 'r', direction: 'outgoing' },
    ]);
    const missing = findMissingTargets([a, b], new Set());
    expect(missing).toEqual([]);
  });

  it('findMissingTargets flags external targets missing from store', () => {
    const a = ent('a', 'task', [
      { targetId: 'ext-1', targetType: 'task', role: 'r', direction: 'outgoing' },
    ]);
    const missing = findMissingTargets([a], new Set(['other']));
    expect(missing).toHaveLength(1);
    expect(missing[0]).toEqual({ id: 'a', role: 'r', targetId: 'ext-1' });
  });
});