'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import {
  ArrowRight, ArrowLeft, CheckCircle2, AlertTriangle,
  Fingerprint, BookUser, Loader2, KeyRound, FlaskConical, Copy,
} from 'lucide-react';
import OfflineAreaSetup from '@/components/offline/OfflineAreaSetup';
import OfflineAreaDownload from '@/components/offline/OfflineAreaDownload';
import type { OfflineMapSelection } from '@/lib/offlineMap';
import { COMMUNICATION_LANGUAGES } from '@/lib/languages';
import { generateSandboxAadhaar } from '@/lib/kyc/verhoeff';
import { buildSandboxMrz } from '@/lib/kyc/passportMrz';

type Method = 'aadhaar' | 'passport';
type Step = 'method' | 'details' | 'otp' | 'consent' | 'done';

export default function OnboardingPage() {
  const [step, setStep] = useState<Step>('method');
  const [method, setMethod] = useState<Method>('aadhaar');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [fullName, setFullName] = useState('');
  const [aadhaar, setAadhaar] = useState('');
  const [mrz1, setMrz1] = useState('');
  const [mrz2, setMrz2] = useState('');

  const [sessionId, setSessionId] = useState('');
  const [maskedTarget, setMaskedTarget] = useState('');
  const [sandboxOtp, setSandboxOtp] = useState('');
  const [otp, setOtp] = useState('');

  // Set when the server reports that this document is already enrolled: the
  // existing holder's recovery code must be presented before their record is
  // overwritten.
  const [requiresRecoveryCode, setRequiresRecoveryCode] = useState(false);
  const [existingRecoveryCode, setExistingRecoveryCode] = useState('');

  const [trackingConsent, setTrackingConsent] = useState(true);
  const [contactName, setContactName] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [hotel, setHotel] = useState('');
  const [visitEndDate, setVisitEndDate] = useState(() => {
    const date = new Date();
    date.setDate(date.getDate() + 30);
    return date.toISOString().slice(0, 10);
  });
  const [itinerarySummary, setItinerarySummary] = useState('');
  const [clothingPhoto, setClothingPhoto] = useState<File | null>(null);
  const [clothingNotes, setClothingNotes] = useState('');
  const [clothingConsent, setClothingConsent] = useState(false);
  const [profileNotice, setProfileNotice] = useState<string | null>(null);
  const [offlineMapSelection, setOfflineMapSelection] = useState<OfflineMapSelection | null>(null);
  const [communicationLanguage, setCommunicationLanguage] = useState('en-IN');

  const [issued, setIssued] = useState<any | null>(null);

  const post = async (url: string, body: unknown) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json();
  };

  async function handleInitiate(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const data = await post('/api/kyc/initiate',
        method === 'aadhaar'
          ? { method, fullName, aadhaarNumber: aadhaar }
          : { method, mrzLine1: mrz1, mrzLine2: mrz2 });

      if (!data.ok) { setError(data.error); return; }

      setSessionId(data.sessionId);
      if (data.requiresOtp) {
        setMaskedTarget(data.maskedTarget ?? '');
        setSandboxOtp(data.sandboxOtp ?? '');
        setStep('otp');
      } else {
        if (data.subject?.fullName) setFullName(data.subject.fullName);
        setStep('consent');
      }
    } catch { setError('Could not reach the verification service.'); }
    finally { setBusy(false); }
  }

  async function handleOtp(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const data = await post('/api/kyc/verify', { sessionId, otp });
      if (!data.ok) {
        setError(data.error);
        if (data.locked) { setStep('details'); setOtp(''); }
        return;
      }
      setStep('consent');
    } catch { setError('Could not reach the verification service.'); }
    finally { setBusy(false); }
  }

  async function handleIssue(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      if (clothingPhoto && !clothingConsent) {
        setError('Please confirm that you consent to the photo being analysed for your emergency identification profile.');
        return;
      }
      const data = await post('/api/identity/issue', {
        sessionId,
        otp: method === 'aadhaar' ? otp : undefined,
        trackingConsent,
        communicationLanguage,
        visitEndsAt: `${visitEndDate}T23:59:59.000Z`,
        itinerary: { summary: itinerarySummary, visitEndsAt: `${visitEndDate}T23:59:59.000Z` },
        ...(contactPhone || contactEmail
          ? { emergencyContacts: [{ name: contactName || 'Emergency contact', phone: contactPhone, email: contactEmail, relationship: 'Primary' }] }
          : {}),
        ...(hotel ? { accommodation: { hotelName: hotel, address: '', city: '' } } : {}),
        ...(existingRecoveryCode.trim() ? { recoveryAccessCode: existingRecoveryCode.trim() } : {}),
      });
      if (!data.ok) {
        setError(data.error);
        if (data.requiresRecoveryCode) setRequiresRecoveryCode(true);
        return;
      }
      setRequiresRecoveryCode(false);
      setExistingRecoveryCode('');

      setProfileNotice(null);
      if (clothingPhoto || clothingNotes.trim()) {
        const profileForm = new FormData();
        if (clothingPhoto) profileForm.set('photo', clothingPhoto);
        if (clothingNotes.trim()) profileForm.set('notes', clothingNotes.trim());

        try {
          const profileResponse = await fetch(`/api/tourists/${encodeURIComponent(data.touristId)}/clothing-profile`, {
            method: 'POST',
            body: profileForm,
          });
          const profileData = await profileResponse.json();
          if (profileResponse.ok && profileData.success) {
            data.clothingProfile = profileData.profile;
          } else {
            setProfileNotice(profileData.error || 'Your ID was issued, but the emergency identification profile could not be saved.');
          }
        } catch {
          setProfileNotice('Your ID was issued, but the emergency identification profile could not be saved.');
        }
      }
      setIssued(data);
      setStep('done');
    } catch { setError('Could not issue the credential.'); }
    finally { setBusy(false); }
  }

  const progressSteps = ['Identity', 'Verify', 'Consent', 'Issued'];
  const activeProgressIndex = {
    method: 0,
    details: 0,
    otp: 1,
    consent: 2,
    done: 3,
  }[step];
  const progressTracker = (
    <ol className="onboarding-progress" aria-label="Onboarding progress">
      {progressSteps.map((label, index) => {
        const complete = index < activeProgressIndex;
        const active = index === activeProgressIndex;
        return (
          <li key={label} className={`onboarding-progress-item ${complete ? 'is-complete' : ''} ${active ? 'is-active' : ''}`}>
            <span className="onboarding-progress-marker">{complete ? <CheckCircle2 size={14} /> : index + 1}</span>
            <span>{label}</span>
          </li>
        );
      })}
    </ol>
  );

  return (
    <main className="onboarding-page">
      <section className="onboarding-workspace">
        <header className="onboarding-pane-header">
          <Link href="/" className="minimal-brand">Prahari</Link>
          <span>Digital Tourist ID</span>
        </header>
        <div className="onboarding-content">

        {step === 'method' && (
          <div>
            <h1 className="ui-display text-3xl text-ink">Choose how to verify</h1>
            <p className="mt-3 max-w-md text-sm leading-6 text-ink-soft">
              We only ask for what is needed to issue your Digital Tourist ID.
            </p>
          </div>
        )}

        {progressTracker}

        {error && (
          <div className="mb-6 flex items-start gap-2 rounded-nb border border-red-300 bg-red-50 p-4 text-sm text-danger">
            <AlertTriangle size={17} className="mt-0.5 shrink-0" /> <span>{error}</span>
          </div>
        )}

        {/* STEP 1 — method */}
        {step === 'method' && (
          <section className="onboarding-stage">
            <div className="space-y-3">
              {([
                { id: 'aadhaar' as const, icon: Fingerprint, title: 'Indian citizen', sub: 'Verify with Aadhaar + OTP' },
                { id: 'passport' as const, icon: BookUser, title: 'Foreign national', sub: 'Verify with passport MRZ' },
              ]).map(({ id, icon: Icon, title, sub }) => (
                <button
                  key={id}
                  onClick={() => { setMethod(id); setStep('details'); setError(null); }}
                  className="minimal-card minimal-card-link flex w-full items-center gap-3 p-5 text-left"
                >
                  <span className="grid size-10 place-items-center rounded-xl bg-surface-2 text-ink"><Icon size={20} /></span>
                  <span className="flex-1">
                    <span className="block text-base font-semibold text-ink">{title}</span>
                    <span className="mt-1 block text-sm text-ink-soft">{sub}</span>
                  </span>
                  <ArrowRight size={16} className="text-ink-soft" />
                </button>
              ))}
            </div>
          </section>
        )}

        {/* STEP 2 — details */}
        {step === 'details' && (
          <form onSubmit={handleInitiate} className="onboarding-stage space-y-4">
            {method === 'aadhaar' ? (
              <>
                <div>
                  <label className="text-sm font-semibold">Full name (as on Aadhaar)</label>
                  <input value={fullName} onChange={(e) => setFullName(e.target.value)} required
                    className="nb-input mt-1 text-sm font-semibold"
                    placeholder="Ralston Fernandes" />
                </div>
                <div>
                  <label className="text-sm font-semibold">Aadhaar number</label>
                  <input value={aadhaar} onChange={(e) => setAadhaar(e.target.value)} required inputMode="numeric"
                    className="nb-input mt-1 font-mono text-sm"
                    placeholder="XXXX XXXX XXXX" maxLength={14} />
                  <p className="mt-1.5 text-xs text-ink-soft">
                    Validated with the Verhoeff checksum. Never stored — only a salted hash is kept.
                  </p>
                  <button type="button" onClick={() => setAadhaar(generateSandboxAadhaar())}
                    className="mt-2 text-xs font-semibold text-ink underline">
                    Generate a valid sandbox number
                  </button>
                </div>
              </>
            ) : (
              <>
                <div>
                  <label className="text-sm font-semibold">Passport MRZ — line 1</label>
                  <input value={mrz1} onChange={(e) => setMrz1(e.target.value)} required
                    className="nb-input mt-1 font-mono text-xs uppercase"
                    placeholder="P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<" />
                </div>
                <div>
                  <label className="text-sm font-semibold">Passport MRZ — line 2</label>
                  <input value={mrz2} onChange={(e) => setMrz2(e.target.value)} required
                    className="nb-input mt-1 font-mono text-xs uppercase"
                    placeholder="L898902C36UTO7408122F3404159ZE184226B<<<<<16" />
                </div>
                <p className="text-xs text-ink-soft">
                  The two 44-character lines at the bottom of the photo page. Check digits are
                  verified against ICAO 9303 — a mistyped line is rejected.
                </p>
                <button type="button" onClick={() => { const specimen = buildSandboxMrz(); setMrz1(specimen.line1); setMrz2(specimen.line2); }}
                  className="text-xs font-semibold text-ink underline">
                  Generate an ICAO specimen passport
                </button>
              </>
            )}

            <div className="flex gap-3 pt-2">
              <button type="button" onClick={() => { setStep('method'); setError(null); }}
                className="minimal-button minimal-button-secondary">
                <ArrowLeft size={15} /> Back
              </button>
              <button type="submit" disabled={busy}
                className="minimal-button minimal-button-primary flex-1 disabled:opacity-60">
                {busy ? <Loader2 size={16} className="animate-spin" /> : <ArrowRight size={16} />}
                {busy ? 'Verifying…' : 'Verify identity'}
              </button>
            </div>
          </form>
        )}

        {/* STEP 3 — OTP */}
        {step === 'otp' && (
          <form onSubmit={handleOtp} className="onboarding-stage space-y-4">
            <div className="flex items-center gap-3">
              <KeyRound className="text-ink" size={22} />
              <div>
                <h2 className="font-bold">Enter the OTP</h2>
                <p className="text-sm text-ink-soft">Sent to the mobile linked with {maskedTarget}</p>
              </div>
            </div>

            {sandboxOtp && (
              <div className="flex items-center justify-between rounded-nb border border-amber-300 bg-amber-50 px-4 py-3">
                <div className="text-xs text-warning">
                  <strong>Sandbox OTP:</strong> <span className="font-mono text-base font-bold">{sandboxOtp}</span>
                  <span className="mt-0.5 block">No SMS is sent — a licensed provider would deliver this.</span>
                </div>
                <button type="button" onClick={() => setOtp(sandboxOtp)}
                  className="minimal-button minimal-button-secondary min-h-0 px-2.5 py-1.5 text-xs">
                  <Copy size={13} /> Fill
                </button>
              </div>
            )}

            <input value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))} required
              inputMode="numeric" maxLength={6}
              className="nb-input w-full text-center font-mono text-2xl tracking-[0.4em]"
              placeholder="000000" />
            <p className="text-xs text-ink-soft">Expires in 10 minutes. Three incorrect attempts locks the session.</p>

            <div className="flex gap-3 pt-1">
              <button type="button" onClick={() => { setStep('details'); setOtp(''); setError(null); }}
                className="minimal-button minimal-button-secondary">
                <ArrowLeft size={15} /> Back
              </button>
              <button type="submit" disabled={busy || otp.length !== 6}
                className="minimal-button minimal-button-primary flex-1 disabled:opacity-60">
                {busy ? <Loader2 size={16} className="animate-spin" /> : <CheckCircle2 size={16} />}
                {busy ? 'Checking…' : 'Confirm OTP'}
              </button>
            </div>
          </form>
        )}

        {/* STEP 4 — consent */}
        {step === 'consent' && (
          <form onSubmit={handleIssue} className="onboarding-stage space-y-4">
            <div className="flex items-center gap-2 rounded-nb bg-emerald-50 px-4 py-3 text-sm font-semibold text-success">
              <CheckCircle2 size={17} /> Identity verified{fullName ? ` — ${fullName}` : ''}
            </div>

            <label className="block pt-1 text-sm font-semibold">Language for messages with the authority desk
              <select value={communicationLanguage} onChange={(event) => setCommunicationLanguage(event.target.value)} className="nb-input mt-1 text-sm font-normal">
                {COMMUNICATION_LANGUAGES.map((language) => <option key={language.code} value={language.code}>{language.label}</option>)}
              </select>
              <span className="mt-1 block text-xs font-normal text-ink-soft">Officers&apos; replies are translated into it. You can still write in any language during an SOS.</span>
            </label>

            <h2 className="pt-1 font-bold">Emergency contact <span className="font-normal text-ink-soft">(optional)</span></h2>
            <p className="-mt-2 text-xs text-ink-soft">If you add an email, they are alerted with your location when you send an SOS.</p>
            <div className="grid gap-3 sm:grid-cols-3">
              <input aria-label="Contact name" value={contactName} onChange={(e) => setContactName(e.target.value)} placeholder="Contact name"
                className="nb-input text-sm" />
              <input aria-label="Contact phone" type="tel" value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} placeholder="+91 98765 43210"
                className="nb-input text-sm" />
              <input aria-label="Contact email" type="email" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} placeholder="contact@example.com"
                className="nb-input text-sm" />
            </div>

            <h2 className="pt-1 font-bold">Trip</h2>
            <input aria-label="Accommodation" value={hotel} onChange={(e) => setHotel(e.target.value)} placeholder="Where you are staying (optional)"
              className="nb-input text-sm" />
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
              <input aria-label="Itinerary" value={itinerarySummary} onChange={(e) => setItinerarySummary(e.target.value)}
                placeholder="Places you plan to visit (optional)" className="nb-input text-sm" />
              <label className="text-xs font-semibold text-ink-soft">
                Visit ends
                <input type="date" value={visitEndDate} min={new Date().toISOString().slice(0, 10)}
                  onChange={(e) => setVisitEndDate(e.target.value)} required className="nb-input mt-1 text-sm" />
              </label>
            </div>
            <p className="text-xs text-ink-soft">Your credential automatically expires when this visit ends. Itinerary details remain off-chain.</p>

            <section className="rounded-nb border border-line bg-surface p-4" aria-labelledby="emergency-profile-heading">
              <h2 id="emergency-profile-heading" className="font-bold text-ink">Emergency identification profile <span className="font-normal text-ink-soft">(optional)</span></h2>
              <p className="mt-1 text-xs leading-5 text-ink-soft">
                Add a recent full-body photo or describe what you are wearing. It becomes a written description that responders see only during an emergency. The photo itself is not kept.
              </p>

              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <label className="block text-xs font-semibold text-ink-soft">
                  Current photo
                  <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => setClothingPhoto(e.target.files?.[0] ?? null)}
                    className="mt-1.5 block w-full text-xs file:mr-3 file:rounded-md file:border-0 file:bg-accent file:px-3 file:py-2 file:text-xs file:font-bold file:text-white" />
                  <span className="mt-1 block font-normal">JPEG, PNG, or WebP · up to 5 MB{clothingPhoto ? ` · ${clothingPhoto.name}` : ''}</span>
                </label>
                <label className="block text-xs font-semibold text-ink-soft">
                  Clothing details
                  <textarea value={clothingNotes} onChange={(e) => setClothingNotes(e.target.value)} maxLength={1000} rows={3}
                    placeholder="e.g. blue rain jacket, black backpack, white trainers"
                    className="nb-input mt-1.5 min-h-24 resize-y text-sm font-normal" />
                </label>
              </div>

              {clothingPhoto && (
                <label className="mt-3 flex cursor-pointer items-start gap-2 text-xs text-ink-soft">
                  <input type="checkbox" checked={clothingConsent} onChange={(e) => setClothingConsent(e.target.checked)} className="mt-0.5 size-4 accent-accent" />
                  <span>I consent to this photo being sent to OpenAI to generate my emergency clothing description. The photo itself will not be stored by Prahari.</span>
                </label>
              )}
            </section>

            <OfflineAreaSetup value={offlineMapSelection} onChange={setOfflineMapSelection} />

            <label className="flex cursor-pointer items-start gap-3 rounded-nb border border-line bg-surface-2 p-4">
              <input type="checkbox" checked={trackingConsent} onChange={(e) => setTrackingConsent(e.target.checked)}
                className="mt-0.5 size-4 accent-accent" />
              <span className="text-sm">
                <strong className="block">Share my location with authorities</strong>
                <span className="text-ink-soft">
                  Location is visible to authorities only during an active emergency or an
                  authorised missing-person investigation. Revocable at any time.
                </span>
              </span>
            </label>

            {requiresRecoveryCode && (
              <label className="block rounded-nb border border-amber-300 bg-amber-50 p-4 text-sm">
                <span className="flex items-center gap-2 font-bold text-ink"><KeyRound size={16} /> This document is already enrolled</span>
                <span className="mt-1.5 block text-xs leading-5 text-ink-soft">
                  Enter the recovery code issued at the original enrolment to update that record.
                  Without it the existing traveller&apos;s identity cannot be replaced.
                </span>
                <input type="password" value={existingRecoveryCode} required
                  onChange={(e) => setExistingRecoveryCode(e.target.value)}
                  placeholder="Recovery code from the original enrolment"
                  className="nb-input mt-2 font-mono text-sm" />
              </label>
            )}

            <button type="submit" disabled={busy}
              className="minimal-button minimal-button-primary w-full disabled:opacity-60">
              {busy ? <Loader2 size={16} className="animate-spin" /> : <ArrowRight size={16} />}
              {busy ? 'Issuing credential…' : 'Issue my Digital Tourist ID'}
            </button>
          </form>
        )}

        {/* STEP 5 — done */}
        {step === 'done' && issued && (
          <div className="onboarding-stage space-y-4">
            <div className="flex items-center gap-3">
              <div className="grid size-11 place-items-center rounded-full bg-emerald-100 text-success">
                <CheckCircle2 size={24} />
              </div>
              <div>
                <h2 className="text-lg font-bold">Credential issued</h2>
                <p className="text-sm text-ink-soft">
                  {issued.reissued ? 'Existing identity re-verified.' : 'Your Digital Tourist ID is active.'}
                </p>
              </div>
            </div>

            <dl className="grid gap-2 rounded-nb bg-surface-2 p-4 text-xs">
              {[
                ['Tourist ID', issued.touristId],
                ['DID', issued.did],
                ['Credential hash', issued.credentialHash],
                ['Valid until', new Date(issued.expiresAt).toLocaleDateString()],
              ].map(([k, v]) => (
                <div key={k as string} className="flex flex-wrap justify-between gap-2">
                  <dt className="font-semibold text-ink-soft">{k}</dt>
                  <dd className="break-all font-mono text-ink">{v as string}</dd>
                </div>
              ))}
            </dl>

            {issued.recoveryAccessCode && (
              <div className="rounded-nb border border-amber-300 bg-amber-50 p-4 text-sm text-ink">
                <p className="font-bold">Save your recovery code now</p>
                <p className="mt-1 text-xs leading-5 text-ink-soft">It restores access to your traveller dashboard with your Digital Tourist ID. It will not be shown again and Prahari stores only a salted verifier.</p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <code className="rounded border border-amber-300 bg-white px-2.5 py-2 font-mono text-xs text-ink break-all">{issued.recoveryAccessCode}</code>
                  <button type="button" onClick={() => void navigator.clipboard?.writeText(issued.recoveryAccessCode)} className="minimal-button minimal-button-secondary px-3 py-2 text-xs"><Copy size={14} /> Copy code</button>
                </div>
              </div>
            )}

            {issued.clothingProfile && (
              <div className="rounded-nb border border-line bg-surface-2 p-4 text-sm text-ink">
                <p className="font-bold">Emergency identification profile saved</p>
                <p className="mt-1.5 leading-6 text-ink-soft">{issued.clothingProfile.summary}</p>
                <p className="mt-2 text-xs text-ink-soft">Available only to authorised responders during an emergency investigation.</p>
              </div>
            )}

            {profileNotice && (
              <div className="rounded-nb border border-amber-300 bg-amber-50 p-3 text-sm text-warning">{profileNotice}</div>
            )}

            <OfflineAreaDownload selection={offlineMapSelection} />

            <div className="flex flex-wrap gap-3">
              <Link href="/citizen"
                className="minimal-button minimal-button-primary flex-1">
                Open my safety dashboard <ArrowRight size={15} />
              </Link>
              <Link href={`/verify/${encodeURIComponent(issued.did)}`}
                className="minimal-button minimal-button-secondary">
                Verify credential
              </Link>
            </div>
          </div>
        )}

        </div>

        {/* This disclosure must remain visible while verification is simulated. */}
        <footer className="onboarding-demo-note">
          <FlaskConical size={16} className="shrink-0" />
          <p><strong>Demo verification</strong>Aadhaar and passport checks are local; no UIDAI lookup is performed and this credential is not government-recognised.</p>
        </footer>
      </section>

      <aside className="onboarding-visual" role="img" aria-label="A sunlit mountain trail with a safety beacon">
        <div className="onboarding-visual-copy">
          <p>A safer path begins before you arrive.</p>
        </div>
      </aside>
    </main>
  );
}

