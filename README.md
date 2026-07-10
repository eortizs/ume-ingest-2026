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
- `maxEntities` (default 3).

Usa OpenRouter (`OPENROUTER_API_KEY`, `LLM_MODEL`). Self-heal ×2 sobre JSON
inválido. El server inyecta `lifecycle` y `createdBy` para corregir omissions
del LLM.

## Canon reconciliation

El normalizador en `src/lib/normalizeEntity.ts` aplica:

- Renombra `tenant` → `tenantId`.
- Rechaza campos root no permitidos (los 9 canónicos).
- Genera UUIDv7 si falta `id`.
- Rellena `lifecycle` y `createdBy`.
- Limpia relaciones malformadas.

Ver `/root/.local/share/kilo/plans/1783646217350-ume-ingest-web.md` para el
plan completo y decisiones locked.

## Estructura

```
src/
  app/                 Next App Router
    api/{types,structured,unstructured,commit}/route.ts
    layout.tsx, page.tsx, globals.css
  components/          Forms + preview table
  lib/                 registry, normalizeEntity, mappingEngine, textExtract,
                       llmExtractor, validateBatch, store
tests/                 Vitest (no Docker/LLM)
docs/DEPLOY.md         Nginx + compose
```