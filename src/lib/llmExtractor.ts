import 'server-only';
import type {
  Entity,
  EntityTypeDefinition,
  TypeRegistry,
  ValidationError,
} from 'ume-standard';
import { buildJournalMarkdown } from 'ume-standard';
import {
  normalizeEntityDetailed,
  NormalizationError,
} from './normalizeEntity.js';
import { validateShapeBatch } from './validateBatch.js';
import { aiMaxEntities } from './relatedDefs.js';

export interface LlmExtractRequest {
  text: string;
  targetType: string;
  tenantId: string;
  typeDef: EntityTypeDefinition;
  relatedDefs?: EntityTypeDefinition[];
  maxEntities?: number;
}

export interface LlmExtractResult {
  ok: boolean;
  entities: Entity[];
  warnings: string[];
  thinking?: string;
  error?: string;
}

export interface OpenRouterMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OpenRouterChatRequest {
  model: string;
  messages: OpenRouterMessage[];
  response_format?: { type: 'json_object' };
  temperature?: number;
}

export interface OpenRouterChatResponse {
  choices: Array<{
    message: { role: string; content: string };
  }>;
}

export type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}>;

export const __test_hooks = {
  setFetch(f: FetchLike | null) {
    fetchImpl = f;
  },
};

let fetchImpl: FetchLike | null = null;

function getFetch(): FetchLike {
  if (fetchImpl) return fetchImpl;
  return ((...args: Parameters<typeof fetch>) =>
    fetch(...args)) as unknown as FetchLike;
}

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

export interface ParsedAgentResponse {
  entities: unknown[];
  thinking?: string;
}

export function parseAgentResponse(text: string): ParsedAgentResponse {
  let work = text;
  const thinkMatch = work.match(/<thinking>([\s\S]*?)<\/thinking>/i);
  const tagThinking = thinkMatch ? thinkMatch[1].trim() : undefined;
  const fence = work.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1] : work;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    throw new Error('LLM response is not valid JSON.');
  }
  if (Array.isArray(parsed)) {
    return { entities: parsed, thinking: tagThinking };
  }
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as { entities?: unknown; thinking?: unknown };
    if (!Array.isArray(obj.entities)) {
      throw new Error('LLM response has no "entities" array.');
    }
    const fieldThinking =
      typeof obj.thinking === 'string' && obj.thinking.trim()
        ? obj.thinking.trim()
        : undefined;
    return { entities: obj.entities, thinking: fieldThinking ?? tagThinking };
  }
  throw new Error('LLM response has no "entities" array.');
}

function describeDef(d: EntityTypeDefinition): string {
  const props = JSON.stringify(d.propertiesSchema ?? {}, null, 2);
  const rels = d.allowedRelationships
    .map((r) => {
      const targets = r.allowedTargetTypes.join(', ');
      const rp = r.relationshipPropertiesSchema
        ? ` Edge props (required schema): ${JSON.stringify(r.relationshipPropertiesSchema)}.`
        : '';
      return `- role "${r.role}" -> [${targets}].${rp}`;
    })
    .join('\n');
  return `Type "${d.type}" (${d.displayName ?? d.type})\nProperties schema:\n${props}\nAllowed relationships:\n${rels || '- (none)'}`;
}

function buildSystemPrompt(
  def: EntityTypeDefinition,
  related: EntityTypeDefinition[],
  max: number,
): string {
  const relatedBlock = related.length
    ? `\nRelated types you may emit as children in the same composition:\n${related.map(describeDef).join('\n\n')}\n`
    : '';

  return [
    `You are a UME (Universal Model of Entities) agent extractor (UME v0.2.0).`,
    `Primary requested container type: "${def.type}".`,
    ``,
    describeDef(def),
    relatedBlock,
    `COMPOSITION RULES:`,
    `1. Output ONE JSON object (no other prose) of the form:`,
    `   { "thinking": "<your CoT reasoning>", "entities": [ ... ] }`,
    `   with at most ${max} entity/entities.`,
    `2. If the text describes a composite (e.g. a POS ticket with line items, a hotel with rooms, an itinerary with bookings), DISCONNECT it into multiple root entities: one of "${def.type}" plus child entities of the allowed target types.`,
    `3. Each entity MUST have exactly these ROOT fields: id (uuid string; server may regenerate), name (non-empty string), type (must resolve to a known type from the schemas above), tenantId (string).`,
    `4. NEVER use root fields "tenant", "status", or nest "createdBy"/"lifecycle" — server fills those.`,
    `5. Edge relevance: only set "properties" on a relationship if the role schema REQUIRES edge properties (provided above). When required, edge properties must include "relevance" (enum: critical | medium | low) and "criticality_score" (number 0–1). NEVER use "high" — that is non-canonical.`,
    `6. Within a single batch, reference newly-created entities via relationships using the SAME uuid you assigned in this response. Server will reorder writes topologically.`,
    `7. Be conservative: if information is missing, drop the field; do NOT invent.`,
    `8. Put your full reasoning into the JSON "thinking" field. Do NOT emit any text outside the JSON object.`,
    ``,
    `INFINITE DEPTH (de-nesting rule):`,
    `a. Each emitted entity is a ROOT entity — NEVER nest composite sub-structures inside another entity's "properties" (e.g. no "rooms": [...] inside a hotel entity; no "lines": [...] inside a ticket entity). Promote every meaningful micro-level into its own root entity connected by a typed relationship.`,
    `b. To represent hierarchy, chain typed edges across multiple root entities (parent → child → grand-child ...). For self-recursive types (e.g. physical_asset with role "contains_component"), connect a parent to a child that itself may have children via the same role.`,
    `c. Assign edge "properties" (relevance + criticality_score) whenever the role schema REQUIRES them — typically for self-recursive or cross-cutting composition edges.`,
    `d. Respect the cap of ${max} entities: trim leaf-level detail before coarsening the spine.`,
  ].join('\n');
}

function errorsToPrompt(errors: ValidationError[]): string {
  const grouped: Record<number, string[]> = {};
  for (const e of errors) {
    const k = e.layer ?? 0;
    (grouped[k] ||= []).push(`${e.path}: ${e.message}`);
  }
  return Object.entries(grouped)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([k, msgs]) => `[layer ${k}] ${msgs.join('; ')}`)
    .join('\n');
}

export async function callOpenRouter(
  req: OpenRouterChatRequest,
  apiKey: string,
): Promise<OpenRouterChatResponse> {
  const f = getFetch();
  const res = await f(ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenRouter ${res.status}: ${body.slice(0, 500)}`);
  }
  return (await res.json()) as OpenRouterChatResponse;
}

export async function extractWithLlm(
  req: LlmExtractRequest,
  apiKey: string,
  model: string,
  registry: TypeRegistry,
): Promise<LlmExtractResult> {
  const hard = aiMaxEntities();
  const max = Math.max(1, Math.min(req.maxEntities ?? 10, hard));
  const warnings: string[] = [];
  const aiCreatedBy =
    process.env.INGEST_CREATED_BY ?? 'ingest:ai-agent';
  const system = buildSystemPrompt(req.typeDef, req.relatedDefs ?? [], max);
  const userMsg = `Text to extract entities from:\n\n"""${req.text.slice(0, 60_000)}"""`;

  const baseMessages: OpenRouterMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: userMsg },
  ];

  const maxAttempts = 3;
  let attempt = 0;
  let lastError: string | undefined;
  let parsed: ParsedAgentResponse | undefined;
  let entities: Entity[] = [];
  let lastShapeErrors: ValidationError[] = [];

  while (attempt < maxAttempts) {
    const messages: OpenRouterMessage[] = [...baseMessages];
    if (lastError) {
      messages.push({
        role: 'user',
        content:
          `Previous output failed with errors:\n${lastError}\n` +
          `Return ONLY the corrected JSON object { "thinking": "<CoT>", "entities": [ ... ] }. ` +
          `No text outside the JSON object.`,
      });
    }
    let raw: string;
    try {
      const resp = await callOpenRouter(
        {
          model,
          messages,
          response_format: { type: 'json_object' },
          temperature: 0.2,
        },
        apiKey,
      );
      raw = resp.choices?.[0]?.message?.content ?? '';
    } catch (e) {
      lastError = (e as Error).message;
      attempt++;
      if (attempt >= maxAttempts) {
        return {
          ok: false,
          entities: [],
          warnings,
          error: `LLM failed after ${attempt} attempts: ${lastError}`,
        };
      }
      continue;
    }

    try {
      parsed = parseAgentResponse(raw);
    } catch (e) {
      lastError = (e as Error).message;
      attempt++;
      if (attempt >= maxAttempts) {
        return {
          ok: false,
          entities: [],
          warnings,
          error: `LLM failed after ${attempt} attempts: ${lastError}`,
        };
      }
      continue;
    }

    entities = [];
    const allStripped: string[] = [];
    for (const rawE of parsed.entities) {
      if (!rawE || typeof rawE !== 'object') {
        warnings.push('Skipped non-object entity from LLM.');
        continue;
      }
      const rec = rawE as Record<string, unknown>;
      try {
        const r = normalizeEntityDetailed(rec, {
          createdBy: aiCreatedBy,
          forceTenantId: req.tenantId,
          stripUnknownRoots: true,
        });
        allStripped.push(...r.stripped);
        let ent = r.entity;
        if (
          ent.type === 'journal_entry' &&
          (!ent.markdown || ent.markdown.length < 40)
        ) {
          ent = {
            ...ent,
            markdown:
              buildJournalMarkdown(ent.properties as never) ?? ent.markdown,
          };
        }
        entities.push(ent);
      } catch (e) {
        if (e instanceof NormalizationError) {
          warnings.push(`normalize: ${e.message}`);
        } else {
          warnings.push(`normalize: ${(e as Error).message}`);
        }
      }
    }
    if (allStripped.length > 0) {
      warnings.push(`stripped non-R1 root fields: ${allStripped.join(', ')}`);
    }

    const shape = validateShapeBatch(entities, registry);
    lastShapeErrors = shape.rows
      .flatMap((r) => r.errors ?? [])
      .map((e) => ({ ...e, layer: (e.layer ?? 3) as 1 | 2 | 3 }));
    if (shape.ok && entities.length > 0) {
      break;
    }

    lastError = errorsToPrompt(lastShapeErrors);
    attempt++;
    if (attempt >= maxAttempts) {
      return {
        ok: false,
        entities: [],
        warnings,
        thinking: parsed.thinking,
        error: `LLM failed after ${attempt} attempts: shape validation failed: ${lastError}`,
      };
    }
  }

  if (entities.length === 0) {
    return {
      ok: false,
      entities: [],
      warnings,
      thinking: parsed?.thinking,
      error: 'LLM produced no entities',
    };
  }

  return {
    ok: true,
    entities,
    warnings,
    thinking: parsed?.thinking,
  };
}