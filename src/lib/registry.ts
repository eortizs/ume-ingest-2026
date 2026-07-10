import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TypeRegistry, type EntityTypeDefinition } from 'ume-standard';

const here = dirname(fileURLToPath(import.meta.url));

function fixturesDir(): string {
  return resolve(here, '../../node_modules/ume-standard/schemas/fixtures/types');
}

function localPackDir(): string {
  return resolve(process.cwd(), 'schemas/types');
}

let cached: { registry: TypeRegistry; defs: EntityTypeDefinition[] } | null =
  null;

function keyOf(d: EntityTypeDefinition): string {
  return `${d.tenant}::${d.type}`;
}

export async function loadRegistry(): Promise<TypeRegistry> {
  return (await loadRegistryWithDefs()).registry;
}

export async function loadRegistryWithDefs(): Promise<{
  registry: TypeRegistry;
  defs: EntityTypeDefinition[];
}> {
  if (cached) return cached;
  const byKey = new Map<string, EntityTypeDefinition>();

  const dir = fixturesDir();
  const entries = await readdir(dir);
  const files = entries.filter((e) => e.endsWith('.json')).sort();
  for (const f of files) {
    const raw = await readFile(resolve(dir, f), 'utf8');
    const def = JSON.parse(raw) as EntityTypeDefinition;
    byKey.set(keyOf(def), def);
  }

  const localDir = localPackDir();
  let localFiles: string[] = [];
  try {
    const localEntries = await readdir(localDir);
    localFiles = localEntries.filter((e) => e.endsWith('.json')).sort();
  } catch {
    localFiles = [];
  }
  for (const f of localFiles) {
    const raw = await readFile(resolve(localDir, f), 'utf8');
    const def = JSON.parse(raw) as EntityTypeDefinition;
    byKey.set(keyOf(def), def);
  }

  const defs = [...byKey.values()];
  const reg = new TypeRegistry();
  for (const d of defs) reg.add(d);
  cached = { registry: reg, defs };
  return cached;
}

export function registrySummary(defs: EntityTypeDefinition[]): Array<{
  type: string;
  displayName: string;
  tenant: string;
  relationshipCount: number;
  propertyCount: number;
}> {
  return defs.map((d) => ({
    type: d.type,
    displayName: d.displayName ?? d.type,
    tenant: d.tenant,
    relationshipCount: d.allowedRelationships.length,
    propertyCount: Object.keys(d.propertiesSchema ?? {}).length,
  }));
}
