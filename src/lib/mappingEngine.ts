import { createUUIDv7 } from 'ume-standard';
import { normalizeEntity, NormalizationError } from './normalizeEntity.js';

export interface IngestMapping {
  source?: string;
  targetType: string;
  tenantId?: string;
  mapping: {
    id?: string;
    name: string;
    tenantId?: string;
    properties: Record<string, string>;
    relationships?: Array<{
      role: string;
      targetType: string;
      targetId: string;
      direction?: 'outgoing' | 'incoming' | 'bidirectional';
      properties?: Record<string, string>;
    }>;
    markdown?: string;
  };
}

export interface RowError {
  index: number;
  message: string;
}

export interface MappingResult {
  ok: boolean;
  entities: Array<Record<string, unknown>>;
  errors: RowError[];
}

const LITERAL_PREFIX = '#';

function resolveExpression(
  expr: string | undefined,
  row: Record<string, unknown>,
  ctx: { tenantId?: string; index: number },
): { ok: true; value: unknown } | { ok: false; reason: string } {
  if (expr === undefined) return { ok: true, value: undefined };
  if (expr === 'generate_uuidv7()') return { ok: true, value: createUUIDv7() };
  if (expr.startsWith(LITERAL_PREFIX)) {
    return { ok: true, value: expr.slice(LITERAL_PREFIX.length) };
  }
  if (expr === '__tenant__') {
    if (!ctx.tenantId)
      return { ok: false, reason: 'no tenantId in context for __tenant__' };
    return { ok: true, value: ctx.tenantId };
  }
  if (expr.includes('.')) {
    const path = expr;
    const parts = path.split('.');
    let cur: unknown = row;
    for (const p of parts) {
      if (cur && typeof cur === 'object' && p in (cur as object)) {
        cur = (cur as Record<string, unknown>)[p];
      } else {
        return {
          ok: false,
          reason: `path "${path}" not found in row ${ctx.index}`,
        };
      }
    }
    return { ok: true, value: cur };
  }
  if (expr in row) {
    return { ok: true, value: row[expr] };
  }
  return { ok: true, value: expr };
}

export function mapRow(
  row: Record<string, unknown>,
  mapping: IngestMapping,
  index: number,
  defaultTenantId: string | undefined,
): { ok: true; raw: Record<string, unknown> } | { ok: false; reason: string } {
  const ctx = { tenantId: defaultTenantId, index };
  const m = mapping.mapping;
  const out: Record<string, unknown> = {
    type: mapping.targetType,
  };

  const nameR = resolveExpression(m.name, row, ctx);
  if (!nameR.ok) return nameR;
  if (nameR.value === undefined || nameR.value === null || nameR.value === '') {
    return { ok: false, reason: 'name is empty' };
  }
  out.name = nameR.value;

  if (m.tenantId) {
    const t = resolveExpression(m.tenantId, row, ctx);
    if (!t.ok) return t;
    out.tenantId = t.value;
  } else if (defaultTenantId) {
    out.tenantId = defaultTenantId;
  }

  if (m.id) {
    const idR = resolveExpression(m.id, row, ctx);
    if (!idR.ok) return idR;
    if (idR.value) out.id = idR.value;
  }

  const properties: Record<string, unknown> = {};
  for (const [sink, expr] of Object.entries(m.properties ?? {})) {
    const r = resolveExpression(expr, row, ctx);
    if (!r.ok) return r;
    if (r.value !== undefined) properties[sink] = r.value;
  }
  out.properties = properties;

  if (m.relationships && m.relationships.length > 0) {
    const rels: Array<Record<string, unknown>> = [];
    for (const rel of m.relationships) {
      const tidR = resolveExpression(rel.targetId, row, ctx);
      if (!tidR.ok) return tidR;
      if (!tidR.value) {
        return {
          ok: false,
          reason: `relationship "${rel.role}" targetId empty`,
        };
      }
      const item: Record<string, unknown> = {
        role: rel.role,
        targetType: rel.targetType,
        targetId: tidR.value,
        direction: rel.direction ?? 'outgoing',
      };
      if (rel.properties) {
        const rp: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(rel.properties)) {
          const r2 = resolveExpression(v, row, ctx);
          if (!r2.ok) return r2;
          rp[k] = r2.value;
        }
        item.properties = rp;
      }
      rels.push(item);
    }
    out.relationships = rels;
  } else {
    out.relationships = [];
  }

  if (m.markdown) {
    const mdR = resolveExpression(m.markdown, row, ctx);
    if (!mdR.ok) return mdR;
    if (mdR.value) out.markdown = mdR.value;
  }

  out.lifecycle = {
    state: 'created',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  return { ok: true, raw: out };
}

export function runMapping(
  rows: Array<Record<string, unknown>>,
  mapping: IngestMapping,
  defaultTenantId?: string,
): MappingResult {
  const entities: Array<Record<string, unknown>> = [];
  const errors: RowError[] = [];

  for (let i = 0; i < rows.length; i++) {
    const r = mapRow(rows[i], mapping, i, defaultTenantId);
    if (!r.ok) {
      errors.push({ index: i, message: r.reason });
      continue;
    }
    try {
      const normalized = normalizeEntity(r.raw);
      entities.push(normalized as unknown as Record<string, unknown>);
    } catch (e) {
      if (e instanceof NormalizationError) {
        errors.push({ index: i, message: e.message });
      } else {
        errors.push({ index: i, message: (e as Error).message });
      }
    }
  }

  return {
    ok: errors.length === 0,
    entities,
    errors,
  };
}