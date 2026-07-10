import 'server-only';
import { NextResponse } from 'next/server';
import { loadRegistryWithDefs, registrySummary } from '@/lib/registry';

export const runtime = 'nodejs';

export async function GET() {
  try {
    const { defs } = await loadRegistryWithDefs();
    return NextResponse.json({
      ok: true,
      types: registrySummary(defs),
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message },
      { status: 500 },
    );
  }
}