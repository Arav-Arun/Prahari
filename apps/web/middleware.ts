import { NextRequest, NextResponse } from 'next/server';
import { verifySessionToken, SESSION_COOKIE_NAME, type UserRole } from '@/lib/auth/session';

// Pages that require a signed-in role. API routes run their own guards.
const ROLE_ROUTE_MAP: Record<string, UserRole[]> = {
  '/authority': ['admin', 'authority', 'responder'],
  '/citizen': ['tourist'],
};

const homeFor = (role: UserRole) => (role === 'tourist' ? '/citizen' : '/authority');

const protectedPrefixFor = (pathname: string) =>
  Object.keys(ROLE_ROUTE_MAP).find((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const cookie = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = cookie ? await verifySessionToken(cookie) : null;

  // Signed-in users skip the login page.
  if (pathname === '/login') {
    if (!session) return NextResponse.next();
    const redirectTarget = request.nextUrl.searchParams.get('redirect');
    const targetPrefix = redirectTarget?.startsWith('/') ? protectedPrefixFor(redirectTarget) : undefined;
    const destination = targetPrefix && ROLE_ROUTE_MAP[targetPrefix].includes(session.role)
      ? redirectTarget!
      : homeFor(session.role);
    return NextResponse.redirect(new URL(destination, request.url));
  }

  const protectedPrefix = protectedPrefixFor(pathname);
  if (!protectedPrefix) return NextResponse.next();

  if (!session) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('redirect', pathname);
    return NextResponse.redirect(loginUrl);
  }

  if (!ROLE_ROUTE_MAP[protectedPrefix].includes(session.role)) {
    return NextResponse.redirect(new URL(homeFor(session.role), request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/login', '/authority/:path*', '/citizen/:path*'],
};
