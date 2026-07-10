# Deployment — UME Ingest

ume-ingest corre como app Next.js (App Router) bajo `basePath: '/ingest'`,
expuesta públicamente en `ume.people-ia.com/ingest` vía reverse proxy.

## Variables de entorno (server-side; NUNCA al cliente)

```env
DATABASE_URL=postgres://ume:ume@127.0.0.1:54329/ume
OPENROUTER_API_KEY=sk-or-v1-...
LLM_MODEL=deepseek/deepseek-v4-pro
INGEST_BATCH_LIMIT=50
INGEST_CREATED_BY=ingest:web
# Nota: el path AI usa `INGEST_CREATED_BY ?? 'ingest:ai-agent'` si la env
# está unset. Para forzar `ingest:web` también en extracciones AI, ponerlo acá.
```

El operador debe copiar las claves desde el archivo padre `/home/UME/.env`
(opcional) a `/home/UME/ume-ingest/.env.local` (no committear).

## Build & run

```bash
npm install
npm run build
npm run start         # puerto 3001, basePath /ingest
```

o con Docker compose (app only — Postgres se reusa):

```yaml
# /home/UME/ume-ingest/docker-compose.yml (resumen)
services:
  ume-ingest:
    build: .
    ports:
      - "127.0.0.1:3001:3001"
    environment:
      DATABASE_URL: postgres://ume:ume@host.docker.internal:54329/ume
      OPENROUTER_API_KEY: ${OPENROUTER_API_KEY}
      LLM_MODEL: ${LLM_MODEL}
```

## Reverse proxy (nginx en people-ia.com)

```nginx
location /ingest {
  proxy_pass http://127.0.0.1:3001/ingest;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  client_max_body_size 20m;
}
```

## Pre-requisitos runtime

1. **Postgres compartido**: el servicio `ume-pg` de `ume-standard` debe estar
   arriba. Ejecutar desde `/home/UME/ume-standard`:
   ```bash
   npm run db:up
   ```
2. **OpenRouter key** presente en `.env.local` para el flujo no estructurado.

## Smoke manual

1. Abrir `https://ume.people-ia.com/ingest/`.
2. Tab "Tipos": confirmar carga (debe listar 13 tipos — 11 fixtures + 2 POS locales).
3. Tab "Estructurado": subir CSV mínimo (targetType `task`, mapping default)
   → preview OK → "Commit a Postgres".
4. `psql postgresql://ume:ume@127.0.0.1:54329/ume -c 'select count(*) from entities;'`
   debe incrementarse.
5. Tab "No estructurado": pegar una nota corta + `targetType=task` → preview.
6. **Smoke POS (AI composition)**:
   - targetType `pos_ticket`, tenantId `acme`, maxEntities 5.
   - pegar texto p.ej. `ACME Coffee Ticket — total $42.50 USD. 1 line: Coffee x2 @ $5.`
   - preview debe mostrar **2 entidades** (`pos_ticket` + `pos_ticket_line`)
     con `tenantId=acme` y la rel `contains_line` con `relevance: critical`,
     `criticality_score: 0.9`.
   - commit → confirmar filas nuevas en `entities` + `entity_relationships`.
   - Repetir con `relevance: "high"` en el texto (o prompt con seed LLM) →
     preview debe mostrar error de shape en la entidad que tenga la relación
     mala (no debe commitear).

## Conformance esperado

- `npm run typecheck` limpio.
- `npm test` (vitest) verde — sin Docker ni LLM.
- ume-standard `npm test` y `npm run gate` siguen verdes (no se toca core).