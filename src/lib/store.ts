import 'server-only';
import pg from 'pg';
import { PostgresStore, type TypeRegistry, type Entity } from 'ume-standard';

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (pool) return pool;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set.');
  }
  pool = new pg.Pool({ connectionString: url, max: 5 });
  return pool;
}

export function getStore(mode: 'full' | 'shape' = 'full'): PostgresStore {
  return new PostgresStore(getPool(), { mode });
}

export async function commitEntities(
  entities: Entity[],
  registry: TypeRegistry,
): Promise<{ id: string; ok: boolean; error?: string }[]> {
  const store = getStore();
  await store.ensureSchema();
  const out: { id: string; ok: boolean; error?: string }[] = [];
  for (const e of entities) {
    try {
      await store.put(e, registry);
      out.push({ id: e.id, ok: true });
    } catch (err) {
      out.push({ id: e.id, ok: false, error: (err as Error).message });
    }
  }
  return out;
}