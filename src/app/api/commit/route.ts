import 'server-only';
import { NextResponse } from 'next/server';
import { loadRegistry } from '@/lib/registry';
import { validateFullBatch } from '@/lib/validateBatch';
import { commitGraph } from '@/lib/graphCommit';
import { getStore, getPool } from '@/lib/store';
import type { Entity } from 'ume-standard';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  let body: { entities?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: 'invalid JSON body' },
      { status: 400 },
    );
  }
  const entities = body.entities;
  if (!Array.isArray(entities) || entities.length === 0) {
    return NextResponse.json(
      { ok: false, error: 'entities[] required' },
      { status: 400 },
    );
  }
  const limit = Number(process.env.INGEST_BATCH_LIMIT ?? '50');
  if (entities.length > limit) {
    return NextResponse.json(
      { ok: false, error: `batch too large: ${entities.length} > ${limit}` },
      { status: 413 },
    );
  }

  const registry = await loadRegistry();
  const list = entities as Entity[];
  const batchIds = new Set(list.map((e) => e.id));

  let existingIds: Set<string>;
  try {
    const store = getStore('full');
    await store.ensureSchema();
    existingIds = await store.listIds();
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `db unreachable: ${(e as Error).message}` },
      { status: 503 },
    );
  }

  const mergedIds = new Set<string>([...existingIds, ...batchIds]);

  const full = await validateFullBatch(list, registry, mergedIds);

  const okEntities = full.rows
    .filter((r) => r.ok && r.entity)
    .map((r) => r.entity as Entity);
  const bad = full.rows
    .filter((r) => !r.ok)
    .map((r) => ({ index: r.index, errors: r.errors }));

  let results: { id: string; ok: boolean; error?: string }[] = [];
  let graphError: string | undefined;
  if (okEntities.length > 0) {
    try {
      const r = await commitGraph(okEntities, registry, getPool());
      results = r.committed;
      if (r.missingTargets.length > 0) {
        graphError = `missing targets: ${JSON.stringify(r.missingTargets)}`;
      } else if (!r.ok && r.error) {
        graphError = r.error;
      }
    } catch (e) {
      return NextResponse.json(
        { ok: false, error: `commit failed: ${(e as Error).message}` },
        { status: 503 },
      );
    }
  }

  return NextResponse.json({
    ok: bad.length === 0 && results.every((r) => r.ok) && !graphError,
    committed: results,
    rejected: bad,
    error: graphError,
  });
}