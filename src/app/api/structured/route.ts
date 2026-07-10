import 'server-only';
import { NextResponse } from 'next/server';
import { parse as parseCsv } from 'csv-parse/sync';
import { createUUIDv7 } from 'ume-standard';
import { loadRegistry } from '@/lib/registry';
import { runMapping, type IngestMapping } from '@/lib/mappingEngine';
import { validateShapeBatch } from '@/lib/validateBatch';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const limit = Number(process.env.INGEST_BATCH_LIMIT ?? '50');
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      { ok: false, error: 'expected multipart/form-data' },
      { status: 400 },
    );
  }

  const file = form.get('file');
  const mappingRaw = form.get('mapping');
  const tenantId = (form.get('tenantId') as string | null) ?? undefined;
  const rawJson = form.get('json') as string | null;

  if (!mappingRaw || typeof mappingRaw !== 'string') {
    return NextResponse.json(
      { ok: false, error: 'missing "mapping" (JSON string)' },
      { status: 400 },
    );
  }

  let mapping: IngestMapping;
  try {
    mapping = JSON.parse(mappingRaw);
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `invalid mapping JSON: ${(e as Error).message}` },
      { status: 400 },
    );
  }
  if (!mapping?.targetType || !mapping?.mapping?.name) {
    return NextResponse.json(
      { ok: false, error: 'mapping requires targetType + mapping.name' },
      { status: 400 },
    );
  }

  let rows: Array<Record<string, unknown>> = [];
  try {
    if (file && file instanceof File) {
      const buf = Buffer.from(await file.arrayBuffer());
      const lower = file.name.toLowerCase();
      if (lower.endsWith('.json')) {
        const parsed = JSON.parse(buf.toString('utf8'));
        rows = Array.isArray(parsed) ? parsed : [parsed];
      } else {
        rows = parseCsv(buf.toString('utf8'), {
          columns: true,
          skip_empty_lines: true,
          trim: true,
        }) as Array<Record<string, unknown>>;
      }
    } else if (rawJson) {
      const parsed = JSON.parse(rawJson);
      rows = Array.isArray(parsed) ? parsed : [parsed];
    } else {
      return NextResponse.json(
        { ok: false, error: 'no input: provide "file" or "json"' },
        { status: 400 },
      );
    }
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `parse error: ${(e as Error).message}` },
      { status: 400 },
    );
  }

  if (rows.length === 0) {
    return NextResponse.json(
      { ok: true, entities: [], validation: [], warnings: ['empty input'], jobId: createUUIDv7() },
    );
  }
  if (rows.length > limit) {
    return NextResponse.json(
      { ok: false, error: `batch too large: ${rows.length} > ${limit}` },
      { status: 413 },
    );
  }

  const mapped = runMapping(rows, mapping, tenantId);
  const registry = await loadRegistry();
  const validation = validateShapeBatch(
    mapped.entities as unknown as Parameters<typeof validateShapeBatch>[0],
    registry,
  );

  const jobId = createUUIDv7();
  return NextResponse.json({
    ok: validation.ok,
    jobId,
    entities: mapped.entities,
    mappingErrors: mapped.errors,
    validation: validation.rows.map((r) => ({
      index: r.index,
      ok: r.ok,
      errors: r.errors,
    })),
    warnings: [],
  });
}