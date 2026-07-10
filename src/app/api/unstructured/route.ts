import 'server-only';
import { NextResponse } from 'next/server';
import { createUUIDv7 } from 'ume-standard';
import { loadRegistry } from '@/lib/registry';
import { extractTextFromFile } from '@/lib/textExtract';
import { extractWithLlm } from '@/lib/llmExtractor';
import { validateShapeBatch } from '@/lib/validateBatch';
import { collectRelatedDefs, clampMaxEntities } from '@/lib/relatedDefs';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const model = process.env.LLM_MODEL ?? 'deepseek/deepseek-v4-pro';
  if (!apiKey) {
    return NextResponse.json(
      { ok: false, error: 'OPENROUTER_API_KEY not configured' },
      { status: 503 },
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      { ok: false, error: 'expected multipart/form-data' },
      { status: 400 },
    );
  }

  const targetType = (form.get('targetType') as string | null) ?? '';
  const tenantId = (form.get('tenantId') as string | null) ?? '';
  const requestedMax = Number(form.get('maxEntities') ?? '0');
  const maxEntities = clampMaxEntities(
    Number.isFinite(requestedMax) && requestedMax >= 1 ? requestedMax : undefined,
  );
  const textField = form.get('text') as string | null;
  const file = form.get('file');

  if (!targetType || !tenantId) {
    return NextResponse.json(
      { ok: false, error: 'targetType and tenantId are required' },
      { status: 400 },
    );
  }

  const registry = await loadRegistry();
  const typeDef = registry.resolve(targetType, tenantId) ?? registry.resolve(targetType, 'global');
  if (!typeDef) {
    return NextResponse.json(
      { ok: false, error: `unknown type "${targetType}"` },
      { status: 400 },
    );
  }

  let extractedText = '';
  let warnings: string[] = [];
  if (typeof textField === 'string' && textField.length > 0) {
    extractedText = textField;
  } else if (file && file instanceof File) {
    const ext = await extractTextFromFile(file);
    extractedText = ext.text;
    if (ext.warning) warnings.push(ext.warning);
  } else {
    return NextResponse.json(
      { ok: false, error: 'no input: provide "text" or "file"' },
      { status: 400 },
    );
  }

  if (!extractedText.trim()) {
    return NextResponse.json(
      { ok: false, error: 'empty text after extraction' },
      { status: 400 },
    );
  }

  const relatedDefs = collectRelatedDefs(registry, typeDef);

  const llmResult = await extractWithLlm(
    {
      text: extractedText,
      targetType,
      tenantId,
      typeDef,
      relatedDefs,
      maxEntities,
    },
    apiKey,
    model,
    registry,
  );

  if (!llmResult.ok && llmResult.entities.length === 0) {
    return NextResponse.json(
      {
        ok: false,
        error: llmResult.error ?? 'LLM produced no entities',
        warnings: llmResult.warnings,
      },
      { status: 502 },
    );
  }

  warnings = warnings.concat(llmResult.warnings);
  const validation = validateShapeBatch(llmResult.entities, registry);

  return NextResponse.json({
    ok: validation.ok,
    jobId: createUUIDv7(),
    entities: llmResult.entities,
    validation: validation.rows.map((r) => ({
      index: r.index,
      ok: r.ok,
      errors: r.errors,
    })),
    warnings,
    thinking: llmResult.thinking,
  });
}

