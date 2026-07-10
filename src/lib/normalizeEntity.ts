import {
  createUUIDv7,
  type Entity,
  type Lifecycle,
  type LifecycleState,
} from 'ume-standard';

const ROOT_FIELDS = new Set([
  'id',
  'name',
  'type',
  'tenantId',
  'lifecycle',
  'properties',
  'relationships',
  'markdown',
  'createdBy',
]);

const ILLEGAL_KEY_ALIASES: Record<string, string> = {
  tenant: 'tenantId',
  organization_id: 'tenantId',
  organizationId: 'tenantId',
};

const LIFECYCLE_STATES: LifecycleState[] = [
  'created',
  'provisioned',
  'running',
  'stopped',
  'archived',
  'deleted',
];

function asLifecycleState(v: string): LifecycleState {
  return (LIFECYCLE_STATES as string[]).includes(v)
    ? (v as LifecycleState)
    : 'created';
}

export interface NormalizeOptions {
  createdBy?: string;
  now?: () => Date;
  forceTenantId?: string;
  stripUnknownRoots?: boolean;
}

export class NormalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NormalizationError';
  }
}

export interface NormalizeResult {
  entity: Entity;
  stripped: string[];
  aliased: string[];
}

export function normalizeEntity(
  raw: Record<string, unknown>,
  opts: NormalizeOptions = {},
): Entity {
  return normalizeEntityDetailed(raw, opts).entity;
}

export function normalizeEntityDetailed(
  raw: Record<string, unknown>,
  opts: NormalizeOptions = {},
): NormalizeResult {
  const now = opts.now ?? (() => new Date());
  const createdBy = opts.createdBy ?? 'ingest:web';
  const strip = opts.stripUnknownRoots ?? false;
  const cleaned: Record<string, unknown> = {};
  const aliased: string[] = [];
  const stripped: string[] = [];

  for (const [k, v] of Object.entries(raw)) {
    if (ILLEGAL_KEY_ALIASES[k]) {
      cleaned[ILLEGAL_KEY_ALIASES[k]] = v;
      aliased.push(k);
    } else {
      cleaned[k] = v;
    }
  }

  if (opts.forceTenantId && opts.forceTenantId.trim()) {
    cleaned.tenantId = opts.forceTenantId;
  }

  for (const k of Object.keys(cleaned)) {
    if (!ROOT_FIELDS.has(k)) {
      if (strip) {
        delete cleaned[k];
        stripped.push(k);
        continue;
      }
      throw new NormalizationError(
        `Illegal root field "${k}". Allowed: ${[...ROOT_FIELDS].join(', ')}`,
      );
    }
  }

  const type = cleaned.type;
  if (typeof type !== 'string' || !type) {
    throw new NormalizationError('Missing or invalid "type".');
  }

  const name = cleaned.name;
  if (typeof name !== 'string' || !name.trim()) {
    throw new NormalizationError('Missing or invalid "name".');
  }

  const tenantId = cleaned.tenantId;
  if (typeof tenantId !== 'string' || !tenantId.trim()) {
    throw new NormalizationError('Missing or invalid "tenantId".');
  }

  const id =
    typeof cleaned.id === 'string' && cleaned.id.length > 0
      ? cleaned.id
      : createUUIDv7();

  const lifecycle = normalizeLifecycle(cleaned.lifecycle, now);
  const properties =
    cleaned.properties && typeof cleaned.properties === 'object'
      ? (cleaned.properties as Record<string, unknown>)
      : {};
  const relationships = normalizeRelationships(cleaned.relationships);
  const markdown =
    typeof cleaned.markdown === 'string' ? cleaned.markdown : '';
  const cb = cleaned.createdBy;
  const createdByFinal =
    typeof cb === 'string' && cb.length > 0 ? cb : createdBy;

  return {
    entity: {
      id,
      name: name.trim(),
      type,
      tenantId: tenantId.trim(),
      lifecycle,
      properties,
      relationships,
      markdown,
      createdBy: createdByFinal,
    },
    stripped,
    aliased,
  };
}

function normalizeLifecycle(raw: unknown, now: () => Date): Lifecycle {
  const ts = now().toISOString();
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>;
    const state =
      typeof r.state === 'string'
        ? asLifecycleState(r.state)
        : 'created';
    const createdAt =
      typeof r.createdAt === 'string' && r.createdAt
        ? r.createdAt
        : ts;
    const updatedAt =
      typeof r.updatedAt === 'string' && r.updatedAt
        ? r.updatedAt
        : ts;
    return { state, createdAt, updatedAt };
  }
  return { state: 'created', createdAt: ts, updatedAt: ts };
}

function normalizeRelationships(raw: unknown): Entity['relationships'] {
  if (!Array.isArray(raw)) return [];
  const out: Entity['relationships'] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const rec = r as Record<string, unknown>;
    if (typeof rec.targetId !== 'string' || !rec.targetId) continue;
    if (typeof rec.targetType !== 'string' || !rec.targetType) continue;
    if (typeof rec.role !== 'string' || !rec.role) continue;
    const dir =
      rec.direction === 'incoming' || rec.direction === 'bidirectional'
        ? rec.direction
        : 'outgoing';
    const properties =
      rec.properties && typeof rec.properties === 'object'
        ? (rec.properties as Record<string, unknown>)
        : undefined;
    const rel: Entity['relationships'][number] = {
      targetId: rec.targetId,
      targetType: rec.targetType,
      role: rec.role,
      direction: dir,
    };
    if (properties) rel.properties = properties;
    out.push(rel);
  }
  return out;
}

export const __testing = { ROOT_FIELDS, ILLEGAL_KEY_ALIASES };