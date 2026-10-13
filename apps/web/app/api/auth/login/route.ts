import { NextRequest, NextResponse } from 'next/server';
import { getUserByEmail } from '@/lib/db';
import { verifyPassword } from '@/lib/auth/crypto';
import { createSessionToken, setSessionCookie } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const { email, password } = await request.json();

    if (!email || !password) {
      return NextResponse.json(
        { success: false, error: 'Email and password are required.' },
        { status: 400 }
      );
    }

    const user = await getUserByEmail(String(email));
    if (!user || !verifyPassword(String(password), user.passwordHash, user.salt)) {
      return NextResponse.json(
        { success: false, error: 'Invalid email or password.' },
        { status: 401 }
      );
    }

    if (user.active === false) {
      return NextResponse.json(
        { success: false, error: 'Account has been deactivated. Contact an administrator.' },
        { status: 403 }
      );
    }

    const sessionToken = await createSessionToken({
      userId: user.userId,
      role: user.role,
      email: user.email,
      name: user.name,
      entityId: user.entityId ?? undefined,
      department: user.department ?? undefined,
      badge: user.badge ?? undefined,
    });

    const response = NextResponse.json({
      success: true,
      user: {
        userId: user.userId,
        email: user.email,
        name: user.name,
        role: user.role,
        department: user.department,
        badge: user.badge,
      },
    });
    setSessionCookie(response, sessionToken);
    return response;
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message || 'Login failed.' },
      { status: 500 }
    );
  }
}
