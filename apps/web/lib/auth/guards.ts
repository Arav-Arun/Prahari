import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest, type AuthSession, type UserRole } from './session';

interface AuthResultSuccess {
  session: AuthSession;
  errorResponse: null;
}

interface AuthResultFailure {
  session: null;
  errorResponse: NextResponse;
}

type AuthResult = AuthResultSuccess | AuthResultFailure;

/**
 * Route authorization guard for API routes.
 *
 * Checks if request is authenticated and, optionally, if the user role is authorized.
 *
 * Usage:
 * ```ts
 * const auth = requireAuth(request, ['admin', 'authority']);
 * if (auth.errorResponse) return auth.errorResponse;
 * const { session } = auth;
 * ```
 */
export async function requireAuth(
  request: NextRequest,
  allowedRoles?: UserRole[]
): Promise<AuthResult> {
  const session = await getSessionFromRequest(request);

  if (!session) {
    return {
      session: null,
      errorResponse: NextResponse.json(
        {
          success: false,
          error: 'Authentication required. Please provide a valid session cookie or Bearer token.',
          code: 'UNAUTHENTICATED',
        },
        { status: 401 }
      ),
    };
  }

  if (allowedRoles && allowedRoles.length > 0 && !allowedRoles.includes(session.role)) {
    return {
      session: null,
      errorResponse: NextResponse.json(
        {
          success: false,
          error: `Forbidden. Role '${session.role}' is not authorized to access this resource.`,
          code: 'FORBIDDEN',
        },
        { status: 403 }
      ),
    };
  }

  return {
    session,
    errorResponse: null,
  };
}

/**
 * Checks if the authenticated user has access to a specific tourist record.
 * Admins, Authorities, and Responders have full access.
 * Tourists can only access their own records.
 */
export function canAccessTouristData(session: AuthSession, targetTouristId: string): boolean {
  if (session.role === 'admin' || session.role === 'authority' || session.role === 'responder') {
    return true;
  }
  if (session.role === 'tourist') {
    return (
      session.touristId === targetTouristId ||
      session.entityId === targetTouristId ||
      session.userId === targetTouristId
    );
  }
  return false;
}
