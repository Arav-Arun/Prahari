/**
 * The built-in demo staff logins are on in development. In production they are
 * off unless NEXT_PUBLIC_DEMO_ACCOUNTS=true, because their password is public.
 */
export const DEMO_ACCOUNTS_ENABLED =
  process.env.NODE_ENV !== 'production' || process.env.NEXT_PUBLIC_DEMO_ACCOUNTS === 'true';
