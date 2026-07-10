import 'server-only';
import { NextResponse } from 'next/server';
import { parse as parseCsv } from 'csv-parse/sync';
import { createUUIDv7 } from 'ume-standard';
import { loadRegistry, loadRegistryWithDefs } from '@/lib/registry';
import { runMapping, type IngestMapping } from '@/lib/mappingEngine';
import { extractWithLlm, callOpenRouter } from '@/lib/llmExtractor';
import { validateShapeBatch } from '@/lib/validateBatch';
import { clampMaxEntities, collectRelatedDefs } from '@/lib/relatedDefs';

export const runtime = 'nodejs';
/** Allow long multi-step LLM extraction under reverse proxy. */
export const maxDuration = 180;

const DEBUG =
  process.env.INGEST_DEBUG === '1' || process.env.LOG_LEVEL === 'debug';

function log(...args: unknown[]) {
  if (DEBUG) console.log('[structured]', new Date().toISOString(), ...args);
}

async function classifyTypeWithLlm(
  text: string,
  apiKey: string,
  model: string,
  availableTypes: Array<{
    type: string;
    displayName: string;
    tenant: string;
    summary: string;
  }>,
): Promise<{ type: string; tenant: string; reasoning: string } | { error: string }> {
  const catalog = availableTypes
    .map(
      (t) =>
        `- ${t.type} (tenant=${t.tenant}) — ${t.displayName}\n  ${t.summary}`,
    )
    .join('\n');
  const sys =
    `You are a UME schema classifier.\n` +
    `Pick the SINGLE best-matching UME *container* type for the data below.\n` +
    `Prefer composite roots (e.g. pos_ticket over pos_ticket_line when rows mix headers+lines).\n` +
    `Return ONLY JSON: { "type": "<typename>", "tenant": "<tenant>", "reasoning": "<one sentence>" }.\n` +
    `No text outside the JSON.\n\n` +
    `Available types:\n${catalog}`;
  try {
    log('classify:start', { model, types: availableTypes.length });
    const resp = await callOpenRouter(
      {
        model,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: text.slice(0, 12_000) },
        ],
        response_format: { type: 'json_object' },
        temperature: 0,
        max_tokens: 400,
      },
      apiKey,
    );
    const msg = resp.choices?.[0]?.message as {
      content?: string | null;
      reasoning?: string | null;
    };
    let raw = msg?.content ?? '';
    if (!raw && typeof msg?.reasoning === 'string') raw = msg.reasoning;
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    const parsed = JSON.parse(fence ? fence[1] : raw) as {
      type?: string;
      tenant?: string;
      reasoning?: string;
    };
    if (!parsed.type) return { error: 'classifier returned no type' };
    log('classify:ok', parsed.type, parsed.tenant);
    return {
      type: parsed.type,
      tenant: parsed.tenant ?? 'global',
      reasoning: parsed.reasoning ?? '',
    };
  } catch (e) {
    log('classify:error', (e as Error).message);
    return { error: `classifier failed: ${(e as Error).message}` };
  }
}

function rowsToText(
  rows: Array<Record<string, unknown>>,
  kind: 'csv' | 'json',
  maxRows = 80,
): string {
  const cols = Array.from(
    rows.reduce((set, r) => {
      for (const k of Object.keys(r)) set.add(k);
      return set;
    }, new Set<string>()),
  );
  const slice = rows.slice(0, maxRows);
  const header = `Source: ${kind} (${rows.length} rows, showing ${slice.length})\nColumns: ${cols.join(', ')}\n\nRows:\n`;
  const body = slice
    .map((r, i) => `Row ${i}: ${JSON.stringify(r)}`)
    .join('\n');
  return header + body;
}

export async function POST(req: Request) {
  const started = Date.now();
  log('POST begin');
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
  const tenantId = (form.get('tenantId') as string | null) ?? 'global';
  const rawJson = form.get('json') as string | null;
  const targetTypeRaw = (form.get('targetType') as string | null) ?? '';
  const targetType = targetTypeRaw.trim();
  const maxEntities = clampMaxEntities(
    Number(form.get('maxEntities') ?? '0') || undefined,
  );
  const mappingRaw = form.get('mapping') as string | null;

  let rows: Array<Record<string, unknown>> = [];
  let kind: 'csv' | 'json' = 'csv';
  try {
    if (file && file instanceof File) {
      const buf = Buffer.from(await file.arrayBuffer());
      const lower = file.name.toLowerCase();
      log('file', file.name, buf.length);
      if (lower.endsWith('.json')) {
        const p = JSON.parse(buf.toString('utf8'));
        rows = Array.isArray(p) ? p : [p];
        kind = 'json';
      } else {
        rows = parseCsv(buf.toString('utf8'), {
          columns: true,
          skip_empty_lines: true,
          trim: true,
        }) as Array<Record<string, unknown>>;
        kind = 'csv';
      }
    } else if (rawJson) {
      const p = JSON.parse(rawJson);
      rows = Array.isArray(p) ? p : [p];
      kind = 'json';
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

  log('parsed rows', rows.length, kind);
  if (rows.length === 0) {
    return NextResponse.json({
      ok: true,
      entities: [],
      validation: [],
      warnings: ['empty input'],
      jobId: createUUIDv7(),
    });
  }
  if (rows.length > limit) {
    return NextResponse.json(
      { ok: false, error: `batch too large: ${rows.length} > ${limit}` },
      { status: 413 },
    );
  }

  // Optional deterministic escape hatch (API only).
  if (mappingRaw && typeof mappingRaw === 'string' && mappingRaw.trim()) {
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
    const mapped = runMapping(rows, mapping, tenantId);
    const registry = await loadRegistry();
    const validation = validateShapeBatch(
      mapped.entities as unknown as Parameters<typeof validateShapeBatch>[0],
      registry,
    );
    return NextResponse.json({
      ok: validation.ok,
      jobId: createUUIDv7(),
      entities: mapped.entities,
      mappingErrors: mapped.errors,
      validation: validation.rows.map((r) => ({
        index: r.index,
        ok: r.ok,
        errors: r.errors,
      })),
      warnings: [],
      mode: 'deterministic-mapping',
    });
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  const model = process.env.LLM_MODEL ?? 'deepseek/deepseek-v4-pro';
  if (!apiKey) {
    return NextResponse.json(
      { ok: false, error: 'OPENROUTER_API_KEY not configured' },
      { status: 503 },
    );
  }

  const { registry, defs } = await loadRegistryWithDefs();
  const availableTypes = defs.map((d) => ({
    type: d.type,
    displayName: d.displayName ?? d.type,
    tenant: d.tenant,
    summary:
      `props=${Object.keys(d.propertiesSchema ?? {}).join(',') || '-'}; ` +
      `rels=${
        d.allowedRelationships
          .map((r) => `${r.role}->${r.allowedTargetTypes.join('|')}`)
          .join(',') || '-'
      }`,
  }));

  let chosenType = targetType;
  let chosenTenant = tenantId;
  let classifyReasoning = '';
  const text = rowsToText(rows, kind);

  if (!chosenType) {
    const cls = await classifyTypeWithLlm(
      text,
      apiKey,
      model,
      availableTypes,
    );
    if ('error' in cls) {
      return NextResponse.json(
        {
          ok: false,
          error: cls.error,
          hint: 'Provide targetType explicitly to skip auto-detection.',
          mode: 'llm',
        },
        { status: 502 },
      );
    }
    chosenType = cls.type;
    chosenTenant = cls.tenant || tenantId;
    classifyReasoning = cls.reasoning;
  }

  const typeDef =
    registry.resolve(chosenType, chosenTenant) ??
    registry.resolve(chosenType, 'global');
  if (!typeDef) {
    return NextResponse.json(
      {
        ok: false,
        error: `unknown type "${chosenType}" (tenant=${chosenTenant})`,
      },
      { status: 400 },
    );
  }

  const relatedDefs = collectRelatedDefs(registry, typeDef);
  log('extract:start', { chosenType, related: relatedDefs.length, maxEntities });
  const llm = await extractWithLlm(
    {
      text,
      targetType: chosenType,
      tenantId: chosenTenant,
      typeDef,
      relatedDefs,
      maxEntities,
    },
    apiKey,
    model,
    registry,
  );
  log('extract:done', {
    ok: llm.ok,
    entities: llm.entities.length,
    error: llm.error,
    ms: Date.now() - started,
  });

  const validation = validateShapeBatch(llm.entities, registry);
  return NextResponse.json({
    ok: llm.ok && validation.ok,
    jobId: createUUIDv7(),
    entities: llm.entities,
    validation: validation.rows.map((r) => ({
      index: r.index,
      ok: r.ok,
      errors: r.errors,
    })),
    warnings: llm.warnings,
    thinking: llm.thinking,
    chosenType,
    chosenTenant,
    classifyReasoning,
    mode: 'llm',
    elapsedMs: Date.now() - started,
    error: llm.ok ? undefined : llm.error,
  });
}
