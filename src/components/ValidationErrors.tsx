'use client';

export default function ValidationErrors({
  errors,
}: {
  errors: Array<{ path: string; message: string; layer: 1 | 2 | 3 }>;
}) {
  return (
    <ul style={{ margin: 0, paddingLeft: 14 }}>
      {errors.map((e, i) => (
        <li key={i} style={{ color: '#b91c1c' }}>
          <strong>L{e.layer}</strong> <code>{e.path}</code>: {e.message}
        </li>
      ))}
    </ul>
  );
}