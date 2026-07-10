'use client';

import { useState } from 'react';
import type { PreviewState } from './EntityPreviewTable';

interface TypeInfo {
  type: string;
  displayName: string;
}

const SAMPLE_MAPPING = `{
  "source": "csv demo",
  "targetType": "task",
  "mapping": {
    "id": "generate_uuidv7()",
    "name": "source.title",
    "tenantId": "__tenant__",
    "properties": {
      "status": "source.status",
      "priority": "source.priority"
    }
  }
}`;

export default function StructuredIngestForm({
  types,
  onPreview,
}: {
  types: TypeInfo[];
  onPreview: (p: PreviewState) => void;
}) {
  const [targetType, setTargetType] = useState<string>('');
  const [tenantId, setTenantId] = useState<string>('');
  const [mappingJson, setMappingJson] = useState<string>(SAMPLE_MAPPING);
  const [jsonText, setJsonText] = useState<string>('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.set('mapping', mappingJson);
      if (tenantId) fd.set('tenantId', tenantId);
      if (targetType) {
        try {
          const m = JSON.parse(mappingJson);
          m.targetType = targetType;
          setMappingJson(JSON.stringify(m, null, 2));
          fd.set('mapping', JSON.stringify(m));
        } catch {
          /* ignore, server will validate */
        }
      }
      if (file) fd.set('file', file);
      else if (jsonText) fd.set('json', jsonText);

      const r = await fetch('/ingest/api/structured', {
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
          warnings: [],
          error: j.error,
        });
        return;
      }
      onPreview({
        ok: !!j.ok,
        entities: j.entities ?? [],
        validation: j.validation ?? [],
        warnings: j.warnings ?? [],
        mappingErrors: j.mappingErrors,
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>Estructurado (CSV / JSON + mapping)</h2>
      <p className="subtle">
        Sube un CSV/JSON + un mapping JSON declarativo. La validación es{' '}
        <code>shape</code> previa al commit.
      </p>

      <form onSubmit={submit}>
        <div className="row">
          <div>
            <label>targetType</label>
            <select
              value={targetType}
              onChange={(e) => setTargetType(e.target.value)}
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
            <label>tenantId (constante si no se mapea)</label>
            <input
              type="text"
              value={tenantId}
              onChange={(e) => setTenantId(e.target.value)}
              placeholder="acme"
            />
          </div>
        </div>

        <label>Mapping (JSON)</label>
        <textarea
          rows={14}
          value={mappingJson}
          onChange={(e) => setMappingJson(e.target.value)}
        />

        <label>Archivo (CSV o JSON array)</label>
        <input
          type="file"
          accept=".csv,.json,.txt"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />

        <label>…o pega JSON aquí</label>
        <textarea
          rows={4}
          value={jsonText}
          onChange={(e) => setJsonText(e.target.value)}
          placeholder='[{"title":"Foo","status":"open","priority":"high"}]'
        />

        <div style={{ marginTop: 12 }}>
          <button className="primary" disabled={busy} type="submit">
            {busy ? 'Procesando…' : 'Previsualizar'}
          </button>
        </div>
        {error && <div className="error">{error}</div>}
      </form>
    </section>
  );
}