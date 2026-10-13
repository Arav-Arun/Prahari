import { NextRequest, NextResponse } from 'next/server';

export type UserRole = 'admin' | 'authority' | 'responder' | 'tourist';

export interface AuthSession {
  userId: string;
  role: UserRole;
  email?: string;
  name: string;
  entityId?: string;
  touristId?: string;
  did?: string;
  department?: string;
  badge?: string;
  iat: number;
  exp: number;
}

export const SESSION_COOKIE_NAME = 'prahari_session';
const SESSION_DURATION_SEC = 7 * 24 * 60 * 60; // 7 days

let warnedDefaultSecret = false;

function getSecretKey(): string {
  const secret =
    process.env.SESSION_SECRET ||
    process.env.IDENTITY_SIGNING_KEY ||
    process.env.KYC_HASH_SALT;

  if (secret) return secret;
  // A key that ships with the code would let anyone forge a staff session.
  if (process.env.NODE_ENV === 'production') {
    throw new Error('SESSION_SECRET must be set in production.');
  }
  if (!warnedDefaultSecret) {
    warnedDefaultSecret = true;
    console.warn('[prahari] SESSION_SECRET is not set; using a development-only key.');
  }
  return 'prahari-development-session-key';
}

function base64UrlEncode(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64UrlDecode(str: string): string {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) {
    base64 += '=';
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Real HMAC-SHA256 over the encoded payload, using Web Crypto so the same code
 * runs in both the Edge middleware runtime and Node route handlers. Returns a
 * base64url-encoded signature.
 */
async function hmacSign(data: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  const bytes = new Uint8Array(signatureBuffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

/** Constant-time string comparison to avoid signature timing leaks. */
function timingSafeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Creates a signed stateless session token: `<base64url(payload)>.<base64url(hmac)>`.
 */
export async function createSessionToken(
  data: Omit<AuthSession, 'iat' | 'exp'>,
  durationSec: number = SESSION_DURATION_SEC
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: AuthSession = {
    ...data,
    iat: now,
    exp: now + durationSec,
  };

  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = await hmacSign(encodedPayload, getSecretKey());

  return `${encodedPayload}.${signature}`;
}

/**
 * Verifies a session token, returning the payload if the HMAC is valid and the
 * token is unexpired, or null otherwise.
 */
export async function verifySessionToken(token: string): Promise<AuthSession | null> {
  if (!token || typeof token !== 'string') return null;

  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [encodedPayload, signature] = parts;
  if (!encodedPayload || !signature) return null;

  try {
    const expectedSig = await hmacSign(encodedPayload, getSecretKey());
    if (!timingSafeStringEqual(signature, expectedSig)) {
      return null;
    }

    const session: AuthSession = JSON.parse(base64UrlDecode(encodedPayload));

    const now = Math.floor(Date.now() / 1000);
    if (session.exp && session.exp < now) {
      return null; // Expired
    }

    return session;
  } catch {
    return null;
  }
}

/**
 * Extracts and verifies session from NextRequest (Cookie or Authorization header).
 */
export async function getSessionFromRequest(request: NextRequest): Promise<AuthSession | null> {
  // 1. Check Cookie
  const cookieToken = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (cookieToken) {
    const session = await verifySessionToken(cookieToken);
    if (session) return session;
  }

  // 2. Check Authorization Header: Bearer <token>
  const authHeader = request.headers.get('authorization') || request.headers.get('Authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const bearerToken = authHeader.slice(7).trim();
    const session = await verifySessionToken(bearerToken);
    if (session) return session;
  }

  // 3. Fallback: Parse Cookie header string if request.cookies is empty
  const rawCookieHeader = request.headers.get('cookie') || request.headers.get('Cookie');
  if (rawCookieHeader) {
    const match = rawCookieHeader.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE_NAME}=([^;]+)`));
    if (match?.[1]) {
      const session = await verifySessionToken(decodeURIComponent(match[1]));
      if (session) return session;
    }
  }

  return null;
}

/**
 * Sets the session cookie on a NextResponse object.
 */
export function setSessionCookie(
  response: NextResponse,
  token: string,
  durationSec: number = SESSION_DURATION_SEC
): void {
  response.cookies.set({
    name: SESSION_COOKIE_NAME,
    value: token,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: durationSec,
  });
}

/**
 * Clears the session cookie on a NextResponse object.
 */
export function clearSessionCookie(response: NextResponse): void {
  response.cookies.set({
    name: SESSION_COOKIE_NAME,
    value: '',
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
}
