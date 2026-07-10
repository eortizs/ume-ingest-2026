import 'server-only';
import { NextResponse } from 'next/server';
import { loadRegistry } from '@/lib/registry';
import { commitEntities } from '@/lib/store';
import { validateFullBatch } from '@/lib/validateBatch';
import { getStore } from '@/lib/store';
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
  const store = getStore('shape');
  let existingIds: Set<string>;
  try {
    existingIds = await store.listIds();
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `db unreachable: ${(e as Error).message}` },
      { status: 503 },
    );
  }

  const full = await validateFullBatch(list, registry, existingIds);

  const okEntities = full.rows
    .filter((r) => r.ok && r.entity)
    .map((r) => r.entity as Entity);
  const bad = full.rows
    .filter((r) => !r.ok)
    .map((r) => ({ index: r.index, errors: r.errors }));

  let results: { id: string; ok: boolean; error?: string }[] = [];
  if (okEntities.length > 0) {
    try {
      results = await commitEntities(okEntities, registry);
    } catch (e) {
      return NextResponse.json(
        { ok: false, error: `commit failed: ${(e as Error).message}` },
        { status: 503 },
      );
    }
  }

  return NextResponse.json({
    ok: bad.length === 0 && results.every((r) => r.ok),
    committed: results,
    rejected: bad,
  });
}