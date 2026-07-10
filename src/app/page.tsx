'use client';

import { useEffect, useState } from 'react';
import StructuredIngestForm from '@/components/StructuredIngestForm';
import UnstructuredIngestForm from '@/components/UnstructuredIngestForm';
import EntityPreviewTable, { type PreviewState } from '@/components/EntityPreviewTable';

type Tab = 'structured' | 'unstructured' | 'types';

interface TypeInfo {
  type: string;
  displayName: string;
  tenant: string;
  relationshipCount: number;
  propertyCount: number;
}

export default function Page() {
  const [tab, setTab] = useState<Tab>('structured');
  const [types, setTypes] = useState<TypeInfo[] | null>(null);
  const [typesError, setTypesError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);

  useEffect(() => {
    if (tab !== 'types' || types) return;
    fetch('/ingest/api/types')
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) setTypes(d.types);
        else setTypesError(d.error ?? 'unknown error');
      })
      .catch((e) => setTypesError(String(e)));
  }, [tab, types]);

  return (
    <main>
      <h1>UME Ingest</h1>
      <p className="subtle">
        Ingesta de entidades UME — canon v0.2.0. v1 sin auth, persistencia vía
        PostgresStore compartido (<code>ume-pg</code>).
      </p>

      <div className="tabs" role="tablist">
        <button
          className={tab === 'structured' ? 'active' : ''}
          onClick={() => setTab('structured')}
          role="tab"
        >
          Estructurado
        </button>
        <button
          className={tab === 'unstructured' ? 'active' : ''}
          onClick={() => setTab('unstructured')}
          role="tab"
        >
          No estructurado
        </button>
        <button
          className={tab === 'types' ? 'active' : ''}
          onClick={() => setTab('types')}
          role="tab"
        >
          Tipos
        </button>
      </div>

      {tab === 'structured' && (
        <StructuredIngestForm types={types ?? []} onPreview={setPreview} />
      )}
      {tab === 'unstructured' && (
        <UnstructuredIngestForm types={types ?? []} onPreview={setPreview} />
      )}
      {tab === 'types' && (
        <section className="card">
          {typesError && <div className="error">{typesError}</div>}
          {!typesError && !types && <p className="subtle">Cargando…</p>}
          {types && (
            <table className="preview">
              <thead>
                <tr>
                  <th>Tipo</th>
                  <th>Nombre</th>
                  <th>Tenant</th>
                  <th>Propiedades</th>
                  <th>Relaciones</th>
                </tr>
              </thead>
              <tbody>
                {types.map((t) => (
                  <tr key={t.type}>
                    <td>
                      <code>{t.type}</code>
                    </td>
                    <td>{t.displayName}</td>
                    <td>{t.tenant}</td>
                    <td>{t.propertyCount}</td>
                    <td>{t.relationshipCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {preview && <EntityPreviewTable state={preview} />}
    </main>
  );
}