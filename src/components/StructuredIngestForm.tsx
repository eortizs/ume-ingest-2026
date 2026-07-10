'use client';

import { useState } from 'react';
import type { PreviewState } from './EntityPreviewTable';

interface TypeInfo {
  type: string;
  displayName: string;
  tenant?: string;
}

export default function StructuredIngestForm({
  types,
  onPreview,
}: {
  types: TypeInfo[];
  onPreview: (p: PreviewState) => void;
}) {
  const [targetType, setTargetType] = useState<string>('');
  const [tenantId, setTenantId] = useState<string>('global');
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
      fd.set('tenantId', tenantId || 'global');
      if (targetType) fd.set('targetType', targetType);
      if (file) fd.set('file', file);
      else if (jsonText) fd.set('json', jsonText);

      const r = await fetch('/ingest/api/structured/', {
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
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>Estructurado (CSV / JSON — mapeo por LLM)</h2>
      <p className="subtle">
        Sube un archivo CSV o JSON. El LLM infiere el tipo de entidad y mapea
        cada fila. Si conoces el tipo de destino puedes seleccionarlo; si no,
        elige <code>(auto)</code> y el LLM lo decide.
      </p>

      <form onSubmit={submit}>
        <div className="row">
          <div>
            <label>Tipo de entidad destino</label>
            <select
              value={targetType}
              onChange={(e) => setTargetType(e.target.value)}
            >
              <option value="">(auto — el LLM decide)</option>
              {types.map((t) => (
                <option key={`${t.tenant ?? 'g'}::${t.type}`} value={t.type}>
                  {t.displayName} <code>{t.type}</code>
                </option>
              ))}
            </select>
          </div>
          <div>
            <label>Tenant</label>
            <input
              type="text"
              value={tenantId}
              onChange={(e) => setTenantId(e.target.value)}
              placeholder="global"
            />
          </div>
        </div>

        <label>Archivo (CSV o JSON)</label>
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
          placeholder='[{"title":"Foo","status":"open"}]'
        />

        <div style={{ marginTop: 12 }}>
          <button className="primary" disabled={busy} type="submit">
            {busy ? 'Procesando con LLM…' : 'Previsualizar'}
          </button>
        </div>
        {error && <div className="error">{error}</div>}
      </form>
    </section>
  );
}