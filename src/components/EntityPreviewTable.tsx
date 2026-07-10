'use client';

import { Fragment, useState } from 'react';
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
  thinking?: string;
  error?: string;
}

interface Rel {
  targetId?: string;
  targetType?: string;
  role?: string;
  direction?: string;
  properties?: Record<string, unknown>;
}

export default function EntityPreviewTable({ state }: { state: PreviewState }) {
  const [committing, setCommitting] = useState(false);
  const [commitResult, setCommitResult] = useState<{
    ok: boolean;
    committed?: Array<{ id: string; ok: boolean; error?: string }>;
    rejected?: Array<{ index: number; errors?: PreviewRow['errors'] }>;
    error?: string;
  } | null>(null);
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});

  const okCount = state.validation.filter((r) => r.ok).length;
  const failCount = state.validation.filter((r) => !r.ok).length;
  const idIndex = new Map<string, number>();
  state.entities.forEach((e, i) => {
    if (typeof e.id === 'string') idIndex.set(e.id, i);
  });

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

  function targetLabel(targetId: string | undefined): string {
    if (!targetId) return '∅';
    const i = idIndex.get(targetId);
    if (i === undefined) return targetId;
    const t = state.entities[i];
    return `#${i} ${String(t.name)} (${String(t.type)})`;
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
      {state.thinking && (
        <details className="thinking">
          <summary>CoT (thinking)</summary>
          <pre style={{ whiteSpace: 'pre-wrap' }}>{state.thinking}</pre>
        </details>
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
            const rels = ((e.relationships as Rel[]) ?? []);
            const open = expanded[i] ?? false;
            const md = typeof e.markdown === 'string' ? e.markdown.trim() : '';
            return (
              <Fragment key={i}>
                <tr>
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
                    <button
                      type="button"
                      onClick={() =>
                        setExpanded((s) => ({ ...s, [i]: !open }))
                      }
                      style={{ fontSize: 12 }}
                    >
                      {rels.length} {open ? '▾' : '▸'}
                    </button>
                  </td>
                  <td>
                    {row?.errors && row.errors.length > 0 && (
                      <ValidationErrors errors={row.errors} />
                    )}
                  </td>
                </tr>
                {open && (rels.length > 0 || md) && (
                  <tr>
                    <td colSpan={8} style={{ background: '#f7f7f7' }}>
                      {rels.length > 0 && (
                        <ul style={{ margin: '0 0 8px 18px' }}>
                          {rels.map((r, j) => (
                            <li key={j}>
                              <code>{r.role}</code> →{' '}
                              <code>{r.targetType}</code> @{' '}
                              <code>{targetLabel(r.targetId)}</code>
                              {r.properties && (
                                <>
                                  {' '}
                                  <span className="subtle">
                                    props: {JSON.stringify(r.properties)}
                                  </span>
                                </>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                      {md && (
                        <details>
                          <summary className="subtle">
                            markdown ({(md.length)} chars)
                          </summary>
                          <pre
                            style={{
                              whiteSpace: 'pre-wrap',
                              maxHeight: 200,
                              overflow: 'auto',
                            }}
                          >
                            {md.slice(0, 2000)}
                          </pre>
                        </details>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
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