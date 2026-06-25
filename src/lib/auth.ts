import { createHmac, timingSafeEqual } from 'crypto';

// Minimal single-admin auth. There is no database: the admin password lives in
// ADMIN_PASSWORD and the session is a signed (HMAC-SHA256) HTTP-only cookie.
//
// Cookie value format: `<expiryMs>.<hexSignature>` where the signature is
// HMAC(SESSION_SECRET, expiryMs). We sign only the expiry — there's a single
// account, so the cookie just attests "an admin authenticated, valid until
// <expiry>". Stateless: no server-side session store to keep.

export const ADMIN_COOKIE = 'tfm_admin';
// 7 days. Long enough to be convenient for a single operator, short enough that
// a leaked cookie self-expires.
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function sessionSecret(): string | null {
  // Fall back to ADMIN_PASSWORD so a single env var is enough to get started;
  // SESSION_SECRET lets you rotate sessions without changing the password.
  return process.env.SESSION_SECRET || process.env.ADMIN_PASSWORD || null;
}

/** Whether admin login is configured at all. */
export function adminConfigured(): boolean {
  return Boolean(process.env.ADMIN_PASSWORD) && Boolean(sessionSecret());
}

function timingSafeStrEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  // timingSafeEqual throws on length mismatch; hash both to a fixed length so
  // the comparison itself doesn't leak length, then compare in constant time.
  const ah = createHmac('sha256', 'len').update(ab).digest();
  const bh = createHmac('sha256', 'len').update(bb).digest();
  return timingSafeEqual(ah, bh);
}

/** Validate a submitted password against ADMIN_PASSWORD (constant-time). */
export function checkPassword(password: string): boolean {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return false;
  return timingSafeStrEqual(password, expected);
}

function sign(payload: string): string {
  const secret = sessionSecret();
  if (!secret) throw new Error('SESSION_SECRET/ADMIN_PASSWORD not set');
  return createHmac('sha256', secret).update(payload).digest('hex');
}

/** Mint a signed session cookie value valid for SESSION_TTL_MS. */
export function createSessionToken(nowMs: number): { value: string; maxAgeSec: number } {
  const expiry = nowMs + SESSION_TTL_MS;
  const payload = String(expiry);
  return { value: `${payload}.${sign(payload)}`, maxAgeSec: Math.floor(SESSION_TTL_MS / 1000) };
}

/** Verify a session cookie value: correct signature and not expired. */
export function verifySessionToken(token: string | undefined, nowMs: number): boolean {
  if (!token) return false;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  let expected: string;
  try {
    expected = sign(payload);
  } catch {
    return false;
  }
  if (!timingSafeStrEqual(sig, expected)) return false;
  const expiry = Number(payload);
  return Number.isFinite(expiry) && expiry > nowMs;
}
