import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { ADMIN_COOKIE, adminConfigured, checkPassword, createSessionToken } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request) {
  if (!adminConfigured()) {
    return NextResponse.json({ ok: false, error: 'admin login not configured' }, { status: 503 });
  }
  let password = '';
  try {
    const body = await req.json();
    password = typeof body?.password === 'string' ? body.password : '';
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid body' }, { status: 400 });
  }
  if (!checkPassword(password)) {
    return NextResponse.json({ ok: false, error: 'invalid credentials' }, { status: 401 });
  }
  const { value, maxAgeSec } = createSessionToken(Date.now());
  const store = await cookies();
  store.set(ADMIN_COOKIE, value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    maxAge: maxAgeSec,
  });
  return NextResponse.json({ ok: true });
}
