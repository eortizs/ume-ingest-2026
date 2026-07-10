import type { EntityTypeDefinition, TypeRegistry } from 'ume-standard';

export interface CollectRelatedOptions {
  hops?: number;
}

export function collectRelatedDefs(
  registry: TypeRegistry,
  def: EntityTypeDefinition,
  opts: CollectRelatedOptions = {},
): EntityTypeDefinition[] {
  const maxHops = Math.max(0, opts.hops ?? defaultRelatedHops());
  const primary = `${def.tenant}::${def.type}`;
  const seen = new Set<string>([primary]);
  const out: EntityTypeDefinition[] = [];
  let frontier: EntityTypeDefinition[] = [def];
  let hops = 0;
  while (frontier.length > 0 && hops < maxHops) {
    const next: EntityTypeDefinition[] = [];
    for (const node of frontier) {
      for (const rel of node.allowedRelationships) {
        for (const target of rel.allowedTargetTypes) {
          const t = registry.resolve(target, 'global');
          if (!t) continue;
          const k = `${t.tenant}::${t.type}`;
          if (seen.has(k)) continue;
          seen.add(k);
          out.push(t);
          next.push(t);
        }
      }
    }
    frontier = next;
    hops++;
  }
  return out;
}

export function defaultRelatedHops(): number {
  const v = Number(process.env.INGEST_RELATED_HOPS ?? '4');
  if (!Number.isFinite(v) || v < 0) return 4;
  return Math.floor(v);
}

export function aiMaxEntities(): number {
  const hard = Math.min(
    Number(process.env.INGEST_AI_MAX_ENTITIES ?? 25),
    Number(process.env.INGEST_BATCH_LIMIT ?? 50),
  );
  if (!Number.isFinite(hard) || hard < 1) return 10;
  return Math.floor(hard);
}

export function clampMaxEntities(req?: number): number {
  const hard = aiMaxEntities();
  const def = Number(process.env.INGEST_AI_DEFAULT_ENTITIES ?? 10);
  const fallback = Number.isFinite(def) && def >= 1 && def <= hard ? def : 10;
  const want =
    typeof req === 'number' && Number.isFinite(req) && req >= 1 ? req : fallback;
  return Math.max(1, Math.min(want, hard));
}
