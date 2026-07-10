'use client';

import { useState } from 'react';
import type { PreviewState } from './EntityPreviewTable';

interface TypeInfo {
  type: string;
  displayName: string;
}

const UI_DEFAULT_ENTITIES = 10;
const UI_HARD_ENTITIES = Math.min(
  Number(
    (typeof process !== 'undefined' &&
      process.env?.NEXT_PUBLIC_INGEST_AI_MAX_ENTITIES) ||
      25,
  ),
  Number(
    (typeof process !== 'undefined' && process.env?.NEXT_PUBLIC_INGEST_BATCH_LIMIT) ||
      50,
  ),
) || 25;

export default function UnstructuredIngestForm({
  types,
  onPreview,
}: {
  types: TypeInfo[];
  onPreview: (p: PreviewState) => void;
}) {
  const [targetType, setTargetType] = useState<string>('');
  const [tenantId, setTenantId] = useState<string>('');
  const [text, setText] = useState<string>('');
  const [file, setFile] = useState<File | null>(null);
  const [maxEntities, setMaxEntities] = useState<number>(UI_DEFAULT_ENTITIES);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.set('targetType', targetType);
      fd.set('tenantId', tenantId);
      fd.set('maxEntities', String(maxEntities));
      if (text) fd.set('text', text);
      else if (file) fd.set('file', file);
      const r = await fetch('/ingest/api/unstructured/', {
        method: 'POST',
        body: fd,
      });
      const j = await r.json();
      if (!r.ok || !j.ok) {
        setError(j.error ?? `HTTP ${r.status}`);
        onPreview({
          ok: false,
          entities: [],
          validation: [],
          warnings: j.warnings ?? [],
          error: j.error,
        });
        return;
      }
      onPreview({
        ok: !!j.ok,
        entities: j.entities ?? [],
        validation: j.validation ?? [],
        warnings: j.warnings ?? [],
        thinking: j.thinking,
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>No estructurado (texto → OpenRouter LLM)</h2>
      <p className="subtle">
        Pega texto o sube <code>.txt</code> / <code>.pdf</code> (texto extraído,
        sin OCR). El LLM emite JSON canon-corregido; el server inyecta{' '}
        <code>lifecycle</code>, <code>createdBy</code>.
      </p>

      <form onSubmit={submit}>
        <div className="row">
          <div>
            <label>targetType</label>
            <select
              value={targetType}
              onChange={(e) => setTargetType(e.target.value)}
              required
            >
              <option value="">— elegir —</option>
              {types.map((t) => (
                <option key={t.type} value={t.type}>
                  {t.type} ({t.displayName})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label>tenantId</label>
            <input
              type="text"
              value={tenantId}
              onChange={(e) => setTenantId(e.target.value)}
              placeholder="acme"
              required
            />
          </div>
        </div>

        <label>Texto pegado</label>
        <textarea
          rows={8}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Pega aquí la nota / correo / descripción…"
        />

        <label>…o sube .txt / .pdf</label>
        <input
          type="file"
          accept=".txt,.md,.pdf"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />

        <div className="row">
          <div>
            <label>maxEntities</label>
            <input
              type="number"
              min={1}
              max={UI_HARD_ENTITIES}
              value={maxEntities}
              onChange={(e) =>
                setMaxEntities(
                  Math.max(1, Math.min(UI_HARD_ENTITIES, Number(e.target.value))),
                )
              }
            />
          </div>
          <div />
        </div>

        <div style={{ marginTop: 12 }}>
          <button
            className="primary"
            disabled={busy || (!text && !file)}
            type="submit"
          >
            {busy ? 'Llamando a OpenRouter…' : 'Extraer'}
          </button>
        </div>
        {error && <div className="error">{error}</div>}
      </form>
    </section>
  );
}