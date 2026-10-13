'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { CheckCircle2, CircleX, ExternalLink, Link2, Loader2, LockKeyhole } from 'lucide-react';

type VerificationRecord = {
  ok: boolean;
  valid: boolean;
  error?: string;
  reason?: string;
  did?: string;
  credentialStatus?: string;
  verificationMethod?: string;
  issuedAt?: string | null;
  expiresAt?: string | null;
  sandbox?: boolean;
  blockchain?: {
    anchored: boolean;
    valid: boolean;
    state: string;
    chainId: number;
    txHash: string | null;
  } | null;
  disclosure?: {
    personalDataDisclosed: boolean;
    detailAccess: string;
  };
};

function date(value?: string | null) {
  return value ? new Date(value).toLocaleDateString() : 'Not available';
}

export default function CredentialVerificationPage() {
  const params = useParams<{ did: string }>();
  const searchParams = useSearchParams();
  const did = useMemo(() => decodeURIComponent(params.did ?? ''), [params.did]);
  const claimHash = searchParams.get('h');
  const [record, setRecord] = useState<VerificationRecord | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!did) return;
    const endpoint = `/api/identity/verify/${encodeURIComponent(did)}${claimHash ? `?h=${encodeURIComponent(claimHash)}` : ''}`;
    void fetch(endpoint, { cache: 'no-store' })
      .then(async (response) => {
        const payload = await response.json() as VerificationRecord;
        setRecord(payload);
      })
      .catch(() => setRecord({ ok: false, valid: false, error: 'The verification service could not be reached.' }))
      .finally(() => setLoading(false));
  }, [did, claimHash]);

  const explorer = record?.blockchain?.chainId === 11155111 && record.blockchain.txHash
    ? `https://sepolia.etherscan.io/tx/${record.blockchain.txHash}`
    : null;

  return (
    <main className="minimal-page">
      <header className="minimal-nav">
        <Link href="/" className="minimal-brand">Prahari</Link>
      </header>

      <section className="mx-auto w-full max-w-2xl px-5 py-12 sm:py-16">
        {loading ? (
          <div className="minimal-card flex min-h-48 items-center justify-center gap-3 text-ink-soft">
            <Loader2 className="animate-spin" size={20} /> Checking credential…
          </div>
        ) : !record?.ok ? (
          <div className="minimal-card flex items-start gap-3">
            <CircleX className="mt-0.5 shrink-0 text-danger" size={24} />
            <div>
              <h1 className="text-xl font-semibold">Credential could not be verified</h1>
              <p className="mt-1 text-sm leading-6 text-ink-soft">{record?.error ?? 'No credential was found for this DID.'}</p>
            </div>
          </div>
        ) : (
          <div className="minimal-card space-y-6 sm:p-8">
            <div className="flex items-start gap-4">
              <div className={`grid size-11 shrink-0 place-items-center rounded-full ${record.valid ? 'bg-emerald-50 text-success' : 'bg-red-50 text-danger'}`}>
                {record.valid ? <CheckCircle2 size={24} /> : <CircleX size={24} />}
              </div>
              <div>
                <h1 className="ui-display text-3xl">{record.valid ? 'Credential is valid' : 'Credential is not valid'}</h1>
                <p className="mt-1 text-sm text-ink-soft">
                  {record.valid ? 'Signature, expiry and revocation status checked.' : record.reason ?? 'This credential does not pass verification.'}
                </p>
                {record.sandbox && <p className="mt-2 text-xs text-ink-soft">Issued through sandbox verification — not a government-recognised document.</p>}
              </div>
            </div>

            <dl className="grid gap-x-8 gap-y-4 border-y border-line py-5 text-sm sm:grid-cols-2">
              {[
                ['Verification method', record.verificationMethod],
                ['Status', record.credentialStatus],
                ['Valid until', date(record.expiresAt)],
                ['DID', record.did],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt className="text-xs text-ink-soft">{label}</dt>
                  <dd className={`mt-1 text-sm ${label === 'DID' ? 'break-all font-mono' : ''}`}>{value || 'Not available'}</dd>
                </div>
              ))}
            </dl>

            <div className="space-y-3 text-sm text-ink-soft">
              <p className="flex items-start gap-2">
                <LockKeyhole className="mt-0.5 size-4 shrink-0" />
                {record.disclosure?.detailAccess ?? 'This check does not reveal personal details, document data, contacts or location.'}
              </p>
              <p className="flex items-start gap-2">
                <Link2 className="mt-0.5 size-4 shrink-0" />
                {record.blockchain?.anchored && record.blockchain.valid
                  ? `Credential hash anchored on chain ${record.blockchain.chainId}. No personal data is on-chain.`
                  : 'No blockchain anchor found for this credential.'}
              </p>
              {explorer && (
                <a href={explorer} target="_blank" rel="noreferrer" className="minimal-button minimal-button-secondary">
                  View on Sepolia Etherscan <ExternalLink size={14} />
                </a>
              )}
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
