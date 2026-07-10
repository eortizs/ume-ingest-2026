import 'server-only';
import { PostgresStore, type Entity, type TypeRegistry } from 'ume-standard';
import type { Pool } from 'pg';

export interface GraphCommitResult {
  ok: boolean;
  committed: { id: string; ok: boolean; error?: string }[];
  cycles: string[][];
  missingTargets: { id: string; role: string; targetId: string }[];
  error?: string;
}

export function topoSortBatch(entities: Entity[]): Entity[] {
  const byId = new Map(entities.map((e) => [e.id, e] as const));
  const inBatchIds = new Set(byId.keys());
  const visited = new Set<string>();
  const onStack = new Set<string>();
  const order: Entity[] = [];
  const cycles: string[][] = [];

  function visit(id: string, path: string[]): void {
    if (visited.has(id)) return;
    if (onStack.has(id)) {
      const start = path.indexOf(id);
      cycles.push(path.slice(start).concat(id));
      return;
    }
    const e = byId.get(id);
    if (!e) {
      visited.add(id);
      return;
    }
    onStack.add(id);
    for (const rel of e.relationships ?? []) {
      if (inBatchIds.has(rel.targetId)) {
        visit(rel.targetId, [...path, id]);
      }
    }
    onStack.delete(id);
    visited.add(id);
    order.push(e);
  }

  for (const e of entities) {
    if (!visited.has(e.id)) visit(e.id, []);
  }

  if (cycles.length > 0) {
    throw new Error(
      `Cycle detected in batch: ${cycles.map((c) => c.join('->')).join('; ')}`,
    );
  }

  return order;
}

export function findMissingTargets(
  entities: Entity[],
  existingIds: Set<string>,
): { id: string; role: string; targetId: string }[] {
  const inBatchIds = new Set(entities.map((e) => e.id));
  const missing: { id: string; role: string; targetId: string }[] = [];
  for (const e of entities) {
    for (const rel of e.relationships ?? []) {
      if (inBatchIds.has(rel.targetId)) continue;
      if (!existingIds.has(rel.targetId)) {
        missing.push({
          id: e.id,
          role: rel.role,
          targetId: rel.targetId,
        });
      }
    }
  }
  return missing;
}

export async function commitGraph(
  entities: Entity[],
  registry: TypeRegistry,
  pool: Pool,
): Promise<GraphCommitResult> {
  const store = new PostgresStore(pool, { mode: 'full' });
  await store.ensureSchema();

  const list = await store.listIds();
  const missing = findMissingTargets(entities, list);
  if (missing.length > 0) {
    return {
      ok: false,
      committed: [],
      cycles: [],
      missingTargets: missing,
      error: `missing ${missing.length} relationship target(s)`,
    };
  }

  let ordered: Entity[];
  try {
    ordered = topoSortBatch(entities);
  } catch (e) {
    return {
      ok: false,
      committed: [],
      cycles: [],
      missingTargets: [],
      error: (e as Error).message,
    };
  }

  const committed: { id: string; ok: boolean; error?: string }[] = [];
  for (const e of ordered) {
    try {
      await store.put(e, registry);
      committed.push({ id: e.id, ok: true });
    } catch (err) {
      committed.push({
        id: e.id,
        ok: false,
        error: (err as Error).message,
      });
    }
  }

  return {
    ok: committed.every((r) => r.ok),
    committed,
    cycles: [],
    missingTargets: [],
  };
}