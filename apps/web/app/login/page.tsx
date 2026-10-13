'use client';

import React, { useState, Suspense } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { useRouter, useSearchParams } from 'next/navigation';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { DEMO_ACCOUNTS_ENABLED } from '@/lib/demoAccounts';

type Tab = 'tourist' | 'staff';

const DEMO_STAFF = [
  { label: 'Authority', email: 'officer.sharma@police.gov.in' },
  { label: 'Responder', email: 'responder@police.gov.in' },
];

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirect = searchParams.get('redirect') ?? '';
  const [tab, setTab] = useState<Tab>(
    searchParams.get('role') === 'staff' || redirect.startsWith('/authority') ? 'staff' : 'tourist'
  );

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [identifier, setIdentifier] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signIn = async (url: string, body: unknown, home: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!data.success) {
        setError(data.error || 'Sign-in failed.');
        return;
      }
      const target = redirect.startsWith(home) ? redirect : home;
      router.push(target as Route);
      router.refresh();
    } catch {
      setError('Connection error. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const switchTab = (next: Tab) => {
    setTab(next);
    setError(null);
  };

  return (
    <div className="minimal-page flex min-h-screen flex-col">
      <header className="minimal-nav">
        <Link href="/" className="minimal-brand">Prahari</Link>
        <Link href="/onboarding" className="minimal-text-link">Create tourist ID</Link>
      </header>

      <main className="flex flex-1 items-center justify-center p-5">
        <div className="w-full max-w-sm">
          <h1 className="ui-display text-center text-3xl">Sign in</h1>

          <div className="mt-6 grid grid-cols-2 gap-1 rounded-xl border border-line bg-surface-2 p-1 text-sm font-semibold">
            {(['tourist', 'staff'] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => switchTab(value)}
                className={`rounded-lg py-2 transition ${tab === value ? 'bg-surface text-ink shadow-sm' : 'text-ink-soft hover:text-ink'}`}
              >
                {value === 'tourist' ? 'Traveller' : 'Authority staff'}
              </button>
            ))}
          </div>

          <div className="minimal-card mt-4 space-y-4">
            {error && (
              <p role="alert" className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/5 p-3 text-sm text-danger">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {error}
              </p>
            )}

            {tab === 'tourist' ? (
              <form
                className="space-y-4"
                onSubmit={(e) => { e.preventDefault(); void signIn('/api/auth/tourist-login', { identifier, recoveryAccessCode: recoveryCode }, '/citizen'); }}
              >
                <label className="block text-sm font-medium">
                  Tourist ID or DID
                  <input required value={identifier} onChange={(e) => setIdentifier(e.target.value)} placeholder="DTI-… or did:prahari:…" className="nb-input mt-1.5 font-mono text-sm" />
                </label>
                <label className="block text-sm font-medium">
                  Recovery code
                  <input required type="password" value={recoveryCode} onChange={(e) => setRecoveryCode(e.target.value)} placeholder="From when your ID was issued" className="nb-input mt-1.5 font-mono text-sm" />
                </label>
                <button type="submit" disabled={loading} className="minimal-button minimal-button-primary w-full">
                  {loading && <Loader2 className="size-4 animate-spin" />} Sign in
                </button>
                <p className="text-center text-sm text-ink-soft">
                  No ID yet? <Link href="/onboarding" className="font-medium text-ink underline">Create one</Link>
                </p>
              </form>
            ) : (
              <form
                className="space-y-4"
                onSubmit={(e) => { e.preventDefault(); void signIn('/api/auth/login', { email, password }, '/authority'); }}
              >
                <label className="block text-sm font-medium">
                  Email
                  <input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="nb-input mt-1.5 text-sm" />
                </label>
                <label className="block text-sm font-medium">
                  Password
                  <input required type="password" value={password} onChange={(e) => setPassword(e.target.value)} className="nb-input mt-1.5 text-sm" />
                </label>
                <button type="submit" disabled={loading} className="minimal-button minimal-button-primary w-full">
                  {loading && <Loader2 className="size-4 animate-spin" />} Sign in
                </button>
                {DEMO_ACCOUNTS_ENABLED && <div className="border-t border-line pt-4">
                  <p className="text-xs text-ink-soft">Demo accounts</p>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    {DEMO_STAFF.map((account) => (
                      <button
                        key={account.email}
                        type="button"
                        disabled={loading}
                        onClick={() => void signIn('/api/auth/login', { email: account.email, password: 'Prahari@123' }, '/authority')}
                        className="minimal-button minimal-button-secondary text-xs"
                      >
                        {account.label}
                      </button>
                    ))}
                  </div>
                </div>}
              </form>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
