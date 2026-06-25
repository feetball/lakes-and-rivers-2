import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { ADMIN_COOKIE, adminConfigured, verifySessionToken } from '@/lib/auth';

// Lets the client decide whether to show the login form / admin controls.
// Returns the current admin auth state without leaking whether a specific
// credential is valid.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const store = await cookies();
  const token = store.get(ADMIN_COOKIE)?.value;
  const authed = verifySessionToken(token, Date.now());
  return NextResponse.json(
    { authed, configured: adminConfigured() },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
