'use client';

import { useState } from 'react';
import ValidationErrors from './ValidationErrors';

export interface PreviewRow {
  index: number;
  ok: boolean;
  errors?: Array<{ path: string; message: string; layer: 1 | 2 | 3 }>;
}

export interface PreviewState {
  ok: boolean;
  entities: Array<Record<string, unknown>>;
  validation: PreviewRow[];
  warnings: string[];
  mappingErrors?: Array<{ index: number; message: string }>;
  error?: string;
}

export default function EntityPreviewTable({ state }: { state: PreviewState }) {
  const [committing, setCommitting] = useState(false);
  const [commitResult, setCommitResult] = useState<{
    ok: boolean;
    committed?: Array<{ id: string; ok: boolean; error?: string }>;
    rejected?: Array<{ index: number; errors?: PreviewRow['errors'] }>;
    error?: string;
  } | null>(null);

  const okCount = state.validation.filter((r) => r.ok).length;
  const failCount = state.validation.filter((r) => !r.ok).length;

  async function commit() {
    setCommitting(true);
    setCommitResult(null);
    try {
      const r = await fetch('/ingest/api/commit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ entities: state.entities }),
      });
      const j = await r.json();
      setCommitResult(j);
    } catch (e) {
      setCommitResult({ ok: false, error: String(e) });
    } finally {
      setCommitting(false);
    }
  }

  return (
    <section className="card">
      <h2>Preview</h2>
      <p className="subtle">
        {state.entities.length} entidades — {okCount} OK / {failCount} con
        errores de shape.
      </p>

      {state.error && <div className="error">{state.error}</div>}
      {state.warnings.length > 0 && (
        <div className="warn">
          <strong>Warnings:</strong>
          <ul style={{ margin: '4px 0 0 16px' }}>
            {state.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}
      {state.mappingErrors && state.mappingErrors.length > 0 && (
        <div className="warn">
          <strong>Errores de mapping:</strong>
          <ul style={{ margin: '4px 0 0 16px' }}>
            {state.mappingErrors.map((m, i) => (
              <li key={i}>
                row {m.index}: {m.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      <table className="preview">
        <thead>
          <tr>
            <th>#</th>
            <th>OK</th>
            <th>type</th>
            <th>name</th>
            <th>tenantId</th>
            <th>props</th>
            <th>rels</th>
            <th>errores</th>
          </tr>
        </thead>
        <tbody>
          {state.entities.map((e, i) => {
            const row = state.validation[i];
            return (
              <tr key={i}>
                <td>{i}</td>
                <td>{row?.ok ? '✓' : '✗'}</td>
                <td>
                  <code>{String(e.type)}</code>
                </td>
                <td>{String(e.name)}</td>
                <td>{String(e.tenantId)}</td>
                <td>
                  {Object.keys((e.properties as object) ?? {}).length}
                </td>
                <td>
                  {((e.relationships as unknown[]) ?? []).length}
                </td>
                <td>
                  {row?.errors && row.errors.length > 0 && (
                    <ValidationErrors errors={row.errors} />
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div style={{ marginTop: 12 }}>
        <button
          className="primary"
          disabled={committing || state.entities.length === 0}
          onClick={commit}
        >
          {committing ? 'Commiteando…' : 'Commit a Postgres'}
        </button>
      </div>

      {commitResult && (
        <div style={{ marginTop: 12 }}>
          {commitResult.error && (
            <div className="error">{commitResult.error}</div>
          )}
          {commitResult.committed && commitResult.committed.length > 0 && (
            <div className="ok">
              Committed {commitResult.committed.length} entidades:
              <ul style={{ margin: '4px 0 0 16px' }}>
                {commitResult.committed.map((c) => (
                  <li key={c.id}>
                    <code>{c.id}</code> {c.ok ? 'OK' : `✗ ${c.error}`}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {commitResult.rejected && commitResult.rejected.length > 0 && (
            <div className="warn">
              Rechazadas (full-mode): {commitResult.rejected.length}
            </div>
          )}
        </div>
      )}
    </section>
  );
}