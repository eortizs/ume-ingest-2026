import 'server-only';
import type { Entity, EntityTypeDefinition } from 'ume-standard';
import { buildJournalMarkdown } from 'ume-standard';
import { normalizeEntity, NormalizationError } from './normalizeEntity.js';

export interface LlmExtractRequest {
  text: string;
  targetType: string;
  tenantId: string;
  typeDef: EntityTypeDefinition;
  maxEntities?: number;
}

export interface LlmExtractResult {
  ok: boolean;
  entities: Entity[];
  warnings: string[];
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

function buildSystemPrompt(def: EntityTypeDefinition, max: number): string {
  const allowedRoles = def.allowedRelationships
    .map((r: EntityTypeDefinition['allowedRelationships'][number]) => {
      const targets = r.allowedTargetTypes.join(', ');
      const props = r.relationshipPropertiesSchema
        ? ` Edge properties required schema: ${JSON.stringify(r.relationshipPropertiesSchema)}.`
        : '';
      return `- role "${r.role}" -> targetType [${targets}].${props}`;
    })
    .join('\n');

  const propSchema = JSON.stringify(def.propertiesSchema, null, 2);

  return [
    `You are a UME (Universal Model of Entities) extractor.`,
    `Target type: "${def.type}".`,
    `Properties schema (JSON Schema draft-07):`,
    propSchema,
    ``,
    `Allowed relationships:`,
    allowedRoles || '- (none defined)',
    ``,
    `RULES (UME v0.2.0 canonical):`,
    `1. Output a JSON object: { "entities": [ ... ] } with at most ${max} entity/entities.`,
    `2. Every entity MUST have exactly these ROOT fields:`,
    `   id (uuid string; server may regenerate), name (non-empty string), type (== "${def.type}"), tenantId (string).`,
    `3. DO NOT include "lifecycle", "createdBy", "markdown" at root — the server fills them.`,
    `4. properties is an object matching the schema above; omit unknowns.`,
    `5. relationships is an array. Each item: { role, targetType, targetId, direction?, properties? }.`,
    `   - targetId must be a UUID you know exists; if unknown, OMIT the relationship.`,
    `   - Only set "properties" on a relationship if the role schema REQUIRES edge properties.`,
    `6. NEVER use "tenant" — always "tenantId".`,
    `7. Be conservative: if information is missing, drop the field; do NOT invent.`,
    `8. Wrap reasoning in <thinking>...</thinking> then output the JSON block.`,
    ``,
    `Return ONLY the JSON block (or thinking+JSON). No prose outside.`,
  ].join('\n');
}

function parseEntities(text: string): unknown[] {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1] : text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    throw new Error('LLM response is not valid JSON.');
  }
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as { entities?: unknown };
    if (Array.isArray(obj.entities)) return obj.entities;
  }
  throw new Error('LLM response has no "entities" array.');
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
): Promise<LlmExtractResult> {
  const max = Math.max(1, Math.min(req.maxEntities ?? 3, 10));
  const warnings: string[] = [];
  const system = buildSystemPrompt(req.typeDef, max);
  const userMsg = `Text to extract entities from:\n\n"""${req.text.slice(0, 60_000)}"""`;

  const baseMessages: OpenRouterMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: userMsg },
  ];

  let attempt = 0;
  let lastError: string | undefined;
  let entitiesRaw: unknown[] = [];

  while (attempt < 3) {
    const messages: OpenRouterMessage[] = [...baseMessages];
    if (lastError) {
      messages.push({
        role: 'user',
        content:
          `Previous output failed with errors:\n${lastError}\n` +
          `Return ONLY corrected JSON.`,
      });
    }
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
      const content = resp.choices?.[0]?.message?.content ?? '';
      entitiesRaw = parseEntities(content);
      break;
    } catch (e) {
      lastError = (e as Error).message;
      attempt++;
      if (attempt >= 3) {
        return {
          ok: false,
          entities: [],
          warnings,
          error: `LLM failed after ${attempt} attempts: ${lastError}`,
        };
      }
    }
  }

  const entities: Entity[] = [];
  for (const raw of entitiesRaw) {
    if (!raw || typeof raw !== 'object') {
      warnings.push('Skipped non-object entity from LLM.');
      continue;
    }
    const rec = raw as Record<string, unknown>;
    const enriched: Record<string, unknown> = {
      ...rec,
      type: rec.type ?? req.targetType,
      tenantId: rec.tenantId ?? req.tenantId,
    };
    try {
      let ent = normalizeEntity(enriched);
      if (
        ent.type === 'journal_entry' &&
        (!ent.markdown || ent.markdown.length < 40)
      ) {
        ent = {
          ...ent,
          markdown: buildJournalMarkdown(ent.properties as never) ?? ent.markdown,
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

  return { ok: entities.length > 0, entities, warnings };
}