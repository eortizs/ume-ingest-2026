import {
  validateEntity,
  type Entity,
  type EntityTypeDefinition,
  type LifecycleState,
  TypeRegistry,
} from 'ume-standard';

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

export interface BatchRowResult {
  index: number;
  ok: boolean;
  errors?: Array<{ path: string; message: string; layer: 1 | 2 | 3 }>;
  entity?: Entity;
}

export interface BatchValidationResult {
  ok: boolean;
  rows: BatchRowResult[];
}

export function resolveTypeDef(
  registry: TypeRegistry,
  type: string,
  tenantId: string,
): EntityTypeDefinition | undefined {
  return registry.resolve(type, tenantId) ?? registry.resolve(type, 'global');
}

export function validateShapeBatch(
  entities: Entity[],
  registry: TypeRegistry,
): BatchValidationResult {
  const rows: BatchRowResult[] = [];
  let allOk = true;
  for (let i = 0; i < entities.length; i++) {
    const e = entities[i];
    const def = resolveTypeDef(registry, e.type, e.tenantId);
    if (!def) {
      rows.push({
        index: i,
        ok: false,
        errors: [
          {
            path: 'type',
            message: `unknown type "${e.type}" for tenant "${e.tenantId}"`,
            layer: 1,
          },
        ],
      });
      allOk = false;
      continue;
    }
    const result = validateEntity(e, registry, { mode: 'shape' });
    if (result.ok) {
      rows.push({ index: i, ok: true, entity: e });
    } else {
      rows.push({ index: i, ok: false, errors: result.errors });
      allOk = false;
    }
  }
  return { ok: allOk, rows };
}

export async function validateFullBatch(
  entities: Entity[],
  registry: TypeRegistry,
  existingIds: Set<string>,
): Promise<BatchValidationResult> {
  const rows: BatchRowResult[] = [];
  let allOk = true;
  for (let i = 0; i < entities.length; i++) {
    const e = entities[i];
    const def = resolveTypeDef(registry, e.type, e.tenantId);
    if (!def) {
      rows.push({
        index: i,
        ok: false,
        errors: [
          {
            path: 'type',
            message: `unknown type "${e.type}" for tenant "${e.tenantId}"`,
            layer: 1,
          },
        ],
      });
      allOk = false;
      continue;
    }
    const result = validateEntity(e, registry, {
      mode: 'full',
      existingIds,
    });
    if (result.ok) {
      rows.push({ index: i, ok: true, entity: e });
    } else {
      rows.push({ index: i, ok: false, errors: result.errors });
      allOk = false;
    }
  }
  return { ok: allOk, rows };
}

export { asLifecycleState };