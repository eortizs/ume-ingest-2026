# UME Ingest

Web app para ingesta de entidades UME v0.2.0. Reutiliza el core canónico en
[`../ume-standard`](../ume-standard) (PostgresStore, TypeRegistry, validators).

- **Surface**: Next.js App Router + TS, `basePath: '/ingest'`.
- **Deploy**: `ume.people-ia.com/ingest`.
- **Persistencia**: PostgresStore compartido (`ume-pg`).
- **Auth**: ninguna (v1, demo/VPN).

## Quickstart (dev)

```bash
# 1. Asegurar ume-pg arriba
cd ../ume-standard && npm run db:up && cd -

# 2. Instalar
npm install

# 3. Variables (server-only)
cp .env.example .env.local
# pegar OPENROUTER_API_KEY si vas a usar el flujo no estructurado

# 4. Dev server
npm run dev   # http://127.0.0.1:3001/ingest

# 5. Typecheck + tests (sin Docker/LLM)
npm run typecheck
npm test
```

## Flujos

### Estructurado (CSV / JSON + mapping)

POST `/ingest/api/structured` (multipart):

- `mapping` (JSON string, requerido) — declarativo.
- `tenantId` (opcional, constante).
- `file` o `json` (uno de los dos).

Devuelve preview shape-validado; commit vía POST `/ingest/api/commit`.

### No estructurado (texto / .txt / .pdf)

POST `/ingest/api/unstructured` (multipart):

- `targetType`, `tenantId` (requeridos).
- `text` (pegado) o `file` (.txt/.pdf).
- `maxEntities` (default **10**; tope duro `min(INGEST_AI_MAX_ENTITIES ?? 25, INGEST_BATCH_LIMIT ?? 50)`).

Usa OpenRouter (`OPENROUTER_API_KEY`, `LLM_MODEL`). El system prompt exige
`response_format: json_object` con un envelope `{ "thinking": "<CoT>", "entities": [...] }`
para que el CoT no se pierda fuera del JSON válido. Self-heal: 3 intentos totales
sobre **parse fail** o **shape-AJV fail** (errores se re-inyectan al LLM).
El server inyecta `lifecycle` y `createdBy` (default AI:
`process.env.INGEST_CREATED_BY ?? 'ingest:ai-agent'`) para corregir omissions
del LLM, y fuerza `tenantId` del request sobre lo que emita el modelo.

El **pack local** de tipos (`schemas/types/*.json`, plano) se mergea tras
los fixtures canónicos de `ume-standard`; los nuevos tipos (p.ej.
`pos_ticket` + `pos_ticket_line`) aparecen automáticamente en el selector
`targetType` del UI y en `/ingest/api/types`.

## Canon reconciliation

El normalizador en `src/lib/normalizeEntity.ts` aplica:

- Renombra `tenant` → `tenantId`.
- Rechaza campos root no permitidos (los 9 canónicos).
- Genera UUIDv7 si falta `id`.
- Rellena `lifecycle` y `createdBy`.
- Limpia relaciones malformadas.
- `forceTenantId` siempre gana (para flujo AI multi-tenant).
- `stripUnknownRoots` para tolerar LLM que invente `status` u otros root no-R1
  (alias + strip; nunca se reintroduce `status` canónico).

Ver `/root/.local/share/kilo/plans/1783646217350-ume-ingest-web.md` para el
plan completo y decisiones locked.

## AI expansion (appendix v1.2 reconciled)

Implementa la *intención* del draft de apéndice sobre el canon R1 + Appendix-01:

- **Composition prompt** (`src/lib/llmExtractor.ts`): JSON envelope bajo
  `response_format: json_object` con campo `thinking` para el CoT;
  inyecta target + tipos relacionados (registry.resolve); permite desconectar
  contenedores compuestos (p.ej. `pos_ticket` + `pos_ticket_line`). Fallback
  acepta también `<thinking>...</thinking>` legacy o JSON puro sin thinking.
- **Self-heal**: parse + shape AJV (3 intentos, errores re-inyectados al LLM).
- **POS pack local** (`schemas/types/pos_ticket.json`,
  `pos_ticket_line.json`): `critical|medium|low` + `criticality_score`
  (canon Appendix-01). El LLM nunca debe usar `relevance: "high"` (test
  negativo en `tests/ingest-ai.test.ts`).
- **Topological commit** (`src/lib/graphCommit.ts`): orden topológico,
  detección de ciclos, targets faltantes.
- **Batch merge ids**: el commit mete los IDs del batch en `existingIds` antes
  del `validateFullBatch` para evitar falsos negativos en relaciones
  intra-batch (`store.ensureSchema()` + `store.listIds()`).
- **createdBy AI**: el path LLM usa
  `process.env.INGEST_CREATED_BY ?? 'ingest:ai-agent'`; el path estructurado
  mantiene `'ingest:web'` por defecto.
- **`ume-standard` no modificado**; el pack local no toca el gate cert.

Plan SoT: `/root/.local/share/kilo/plans/1783655801474-ume-ingest-ai-expansion.md`.

## Recursive depth (vertical composition)

Infinit-depth de-nesting en el path AI: cada nivel de composición es un
*root entity* conectado por aristas tipadas; nunca se anidan sub-estructuras
dentro de `properties`.

- **Arsenal local** (`schemas/types/`):
  - `physical_asset.json` — overlay sobre el canon `ume-standard` (unión
    `brand`/`model`/`serial_number` + `asset_class` opcional
    `hotel|room|bathroom|fixture|part|other` + `specifications`). Auto-edge
    `contains_component` con edge props (`relevance` ∈ `critical|medium|low`,
    `criticality_score` 0–1).
  - `travel_itinerary.json`, `travel_day.json`, `travel_booking.json`,
    `travel_activity.json` — pack de viaje global (itinerario → día →
    booking/activity).
  - Reemplazo por `tenant::type` en el merge local — no duplica filas en
    `/ingest/api/types`.
- **BFS related** (`src/lib/relatedDefs.ts`): `collectRelatedDefs` ahora
  visita hasta `INGEST_RELATED_HOPS` (default **4**) saltos; primario
  siempre separado, no se duplica en la lista de relacionados; los self-edges
  no producen loop infinito.
- **Hard cap `maxEntities`** (`src/lib/relatedDefs.ts#aiMaxEntities`):
  `min(INGEST_AI_MAX_ENTITIES ?? 25, INGEST_BATCH_LIMIT ?? 50)`. UI, ruta
  y extractor comparten la misma resolución (`clampMaxEntities`).
- **Prompt INFINITE DEPTH** (`src/lib/llmExtractor.ts`): bloque de reglas
  que prohíbe anidar compuestos dentro de `properties`, obliga a encadenar
  aristas tipadas y a emitir edge props cuando el rol las requiere.
- **Cert** (`tests/infinite-depth.test.ts`): cadena de 5 niveles
  (hotel → room → bathroom → fixture → part) pasa `validateShapeBatch` +
  `topoSortBatch`; el borde `fixture → part` lleva `relevance: critical`,
  `criticality_score: 0.95`. Negativos: `relevance: "high"` y edge props
  faltantes fallan shape.
- **Read-only SQL** (`docs/RECURSIVE-HIERARCHY.sql`): CTEs `descendants`,
  `ancestors`, `subtree` con columnas de `ume-standard/sql/001_init.sql`.
  Documental, no expuesto como endpoint HTTP.

## Estructura

```
src/
  app/                 Next App Router
    api/{types,structured,unstructured,commit}/route.ts
    layout.tsx, page.tsx, globals.css
  components/          Forms + preview table (EntityPreviewTable expande multi-entidad / rels)
  lib/                 registry (con pack local), normalizeEntity,
                       mappingEngine, textExtract, llmExtractor (composition + self-heal),
                       validateBatch, store, graphCommit (topological commit)
schemas/types/         Local type pack (POS ticket fixtures — no canónico)
tests/                 Vitest (no Docker/LLM) — incluye ingest-ai POS mock
docs/DEPLOY.md         Nginx + compose
```