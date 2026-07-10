-- UME Ingest — recursive hierarchy read path
-- Schema columns match ume-standard/sql/001_init.sql:
--   entity_relationships(source_id, target_id, role, direction, properties)
-- Conventions used by the physical_asset overlay:
--   source_id = parent (composite), target_id = component (sub-part)
--   role      = 'contains_component'
--   properties.relevance ∈ {critical, medium, low}
--   properties.criticality_score ∈ [0, 1]
--
-- Postgres ≥ 12 (recursive CTE in standard SQL).

-- 1. Single root: full descendant chain (depth-limited, depth = 0 is root).
WITH RECURSIVE descendants AS (
  SELECT
    e.id,
    e.tenant_id,
    e.type,
    e.name,
    r.target_id,
    r.role,
    r.properties,
    1 AS depth
  FROM entities e
  JOIN entity_relationships r ON r.source_id = e.id
  WHERE e.id = $1                     -- $1 = root entity id (uuid)
    AND e.tenant_id = $2              -- $2 = tenant_id
    AND r.role = 'contains_component'

  UNION ALL

  SELECT
    e.id,
    e.tenant_id,
    e.type,
    e.name,
    r.target_id,
    r.role,
    r.properties,
    d.depth + 1
  FROM descendants d
  JOIN entity_relationships r ON r.source_id = d.target_id
  WHERE r.role = 'contains_component'
    AND d.depth < $3                  -- $3 = max depth (defensive; safe up to ~32)
)
SELECT
  d.id           AS descendant_id,
  d.tenant_id,
  d.type         AS descendant_type,
  d.name         AS descendant_name,
  d.depth,
  d.properties   AS edge_properties
FROM descendants d
ORDER BY d.depth, d.id;

-- 2. All ancestors of a single leaf (reverse traversal up to the root).
WITH RECURSIVE ancestors AS (
  SELECT
    e.id,
    e.tenant_id,
    e.type,
    e.name,
    e.id AS root_id,
    0 AS depth
  FROM entities e
  WHERE e.id = $1                     -- $1 = leaf entity id
    AND e.tenant_id = $2

  UNION ALL

  SELECT
    e.id,
    e.tenant_id,
    e.type,
    e.name,
    a.root_id,
    a.depth + 1
  FROM ancestors a
  JOIN entity_relationships r ON r.target_id = a.id
  JOIN entities e ON e.id = r.source_id
  WHERE r.role = 'contains_component'
    AND a.depth < $3
)
SELECT
  e.id         AS ancestor_id,
  e.tenant_id,
  e.type       AS ancestor_type,
  e.name       AS ancestor_name,
  a.depth      AS hops_from_leaf
FROM ancestors a
JOIN entities e ON e.id = a.id
ORDER BY a.depth DESC;

-- 3. Sibling-friendly: list every node in a subtree with materialized path
--    (useful for tree rendering).
WITH RECURSIVE subtree AS (
  SELECT
    e.id,
    e.tenant_id,
    e.type,
    e.name,
    ARRAY[e.id]::uuid[] AS path,
    0 AS depth
  FROM entities e
  WHERE e.id = $1                     -- $1 = root entity id
    AND e.tenant_id = $2

  UNION ALL

  SELECT
    e.id,
    e.tenant_id,
    e.type,
    e.name,
    s.path || e.id,
    s.depth + 1
  FROM subtree s
  JOIN entity_relationships r ON r.source_id = s.id
  JOIN entities e ON e.id = r.target_id
  WHERE r.role = 'contains_component'
    AND NOT (e.id = ANY(s.path))      -- cycle guard
    AND s.depth < $3
)
SELECT
  s.id,
  s.tenant_id,
  s.type,
  s.name,
  s.depth,
  s.path
FROM subtree s
ORDER BY s.depth, s.path;

-- Notes:
-- - Writable envelope: not exposed as an HTTP CTE endpoint; this file is docs
--   only. Use POST /ingest/api/unstructured to ingest via the LLM path.
-- - The physical_asset overlay (schemas/types/physical_asset.json) is required
--   for shape validation; without it the role 'contains_component' will fail
--   layer 2 (allowed target type not in schema).
-- - Cycles cannot exist in pure-decomposition trees (parent != child by id),
--   but we guard with $3 cap + path membership to keep queries bounded.
