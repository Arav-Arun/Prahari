'use client';

import React, { useEffect, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { QrCode, UserCheck, Link2 } from 'lucide-react';
import { generateDigitalIdQr } from '@/lib/services/digitalId';

interface DigitalIdTourist {
  touristId: string;
  name: string;
  nationality: string;
  did?: string | null;
  identityStatus?: string;
  credentialHash?: string | null;
  credentialStatus?: string | null;
  kycMethod?: string | null;
  credential?: { sandbox?: unknown; expirationDate?: string } | null;
  anchorTxHash?: string | null;
  anchorChainId?: number | null;
}

/** Human label + optional explorer link for a chain id. */
function chainLabel(chainId?: number | null): { name: string; explorer?: string } {
  switch (chainId) {
    case 11155111: return { name: 'Ethereum Sepolia', explorer: 'https://sepolia.etherscan.io/tx/' };
    case 1: return { name: 'Ethereum', explorer: 'https://etherscan.io/tx/' };
    case 31337: return { name: 'Local Hardhat' };
    default: return { name: chainId ? `Chain ${chainId}` : 'Blockchain' };
  }
}

/**
 * Renders an issued Digital Tourist ID. Requires a real, credentialed tourist —
 * there is deliberately no mock fallback, so an un-issued identity is visibly
 * un-issued rather than silently showing fabricated data.
 */
export default function DigitalIdCard({ tourist }: { tourist: DigitalIdTourist | null }) {
  const [qrCodeUrl, setQrCodeUrl] = useState<string>('');
  const [showQr, setShowQr] = useState<boolean>(false);

  const did = tourist?.did ?? null;
  const anchorTxHash = tourist?.anchorTxHash ?? null;
  const anchorExplorer = chainLabel(tourist?.anchorChainId).explorer;
  /** Anchored credentials point the QR at the public explorer receipt; everything
   *  else falls back to the hosted verify page (never a localhost origin). */
  const anchorTxUrl = anchorTxHash && anchorExplorer ? `${anchorExplorer}${anchorTxHash}` : null;

  useEffect(() => {
    if (!did) { setQrCodeUrl(''); return; }
    let payload = anchorTxUrl;
    if (!payload) {
      const base = process.env.NEXT_PUBLIC_APP_URL || window.location.origin;
      const verificationUrl = new URL(`/verify/${encodeURIComponent(did)}`, base);
      if (tourist?.credentialHash) verificationUrl.searchParams.set('h', tourist.credentialHash);
      payload = verificationUrl.toString();
    }
    generateDigitalIdQr(payload).then(setQrCodeUrl).catch(console.error);
  }, [did, tourist?.credentialHash, anchorTxUrl]);

  if (!tourist || !did) {
    return (
      <section className="minimal-card">
        <h2 className="font-semibold">No Digital Tourist ID yet</h2>
        <p className="mt-1 text-sm text-ink-soft">Verify your identity to get one.</p>
        <Link href="/onboarding" className="minimal-button minimal-button-primary mt-4">Start verification</Link>
      </section>
    );
  }

  const isSandbox = Boolean(tourist.credential?.sandbox);
  const revoked = tourist.credentialStatus === 'revoked' || tourist.credentialStatus === 'suspended';
  const anchor = anchorTxHash ? chainLabel(tourist.anchorChainId) : null;
  const shortTx = anchorTxHash ? `${anchorTxHash.slice(0, 10)}…${anchorTxHash.slice(-8)}` : '';

  return (
    <section className="minimal-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold">Digital Tourist ID</h2>
            {revoked ? (
              <span className="rounded-full bg-red-50 px-2.5 py-0.5 text-xs font-semibold text-red-800">{tourist.credentialStatus}</span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-800">
                <UserCheck className="size-3.5" /> Verified
              </span>
            )}
            {isSandbox && <span className="rounded-full bg-surface-2 px-2.5 py-0.5 text-xs font-medium text-ink-soft">Sandbox</span>}
          </div>
          <p className="mt-1 break-all font-mono text-xs text-ink-soft">{did}</p>
        </div>
        <button onClick={() => setShowQr(!showQr)} className="minimal-button minimal-button-secondary">
          <QrCode className="size-4" /> {showQr ? 'Hide QR' : 'Show QR'}
        </button>
      </div>

      {showQr ? (
        <div className="mt-5 flex flex-col items-center rounded-xl border border-line bg-surface-2 p-5">
          {qrCodeUrl ? (
            <Image src={qrCodeUrl} alt="Digital Tourist ID QR code" width={176} height={176} unoptimized className="size-44 rounded-lg border border-line bg-white p-2" />
          ) : (
            <div className="flex size-44 items-center justify-center text-xs text-ink-soft">Generating QR…</div>
          )}
          <p className="mt-3 max-w-sm text-center text-xs leading-5 text-ink-soft">
            {anchorTxUrl
              ? 'Opens the on-chain record of this credential. No personal details are in the code.'
              : 'Opens a page that confirms this credential is valid. No personal details are in the code.'}
          </p>
        </div>
      ) : (
        <dl className="mt-5 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          {[
            ['Holder', tourist.name],
            ['Tourist ID', tourist.touristId],
            ['Nationality', tourist.nationality],
            ['Verified with', tourist.kycMethod === 'passport' ? 'Passport MRZ' : 'Aadhaar'],
          ].map(([label, value]) => (
            <div key={label} className="rounded-lg border border-line bg-surface-2 p-3">
              <dt className="text-xs text-ink-soft">{label}</dt>
              <dd className={`mt-1 break-words font-medium ${label === 'Tourist ID' ? 'font-mono text-xs' : ''}`}>{value}</dd>
            </div>
          ))}
        </dl>
      )}

      <p className="mt-4 flex flex-wrap items-center gap-1.5 text-xs text-ink-soft">
        <Link2 className="size-3.5" />
        {anchor ? (
          <>
            Credential hash anchored on {anchor.name}
            {anchor.explorer ? (
              <a href={`${anchor.explorer}${anchorTxHash}`} target="_blank" rel="noopener noreferrer" className="font-mono text-ink underline">{shortTx}</a>
            ) : (
              <span className="font-mono">{shortTx}</span>
            )}
          </>
        ) : (
          'Signed credential. Not anchored on-chain (no registry configured).'
        )}
      </p>
    </section>
  );
}
