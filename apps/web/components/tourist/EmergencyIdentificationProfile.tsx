'use client';

import { ChangeEvent, FormEvent, useRef, useState } from 'react';
import Image from 'next/image';
import { CheckCircle2, ImagePlus, Loader2, X } from 'lucide-react';

type EmergencyIdentificationProfileProps = {
  touristId: string | null;
  profile?: any;
  onSaved?: (profile: any) => void;
  onClose: () => void;
};

export default function EmergencyIdentificationProfile({ touristId, profile, onSaved, onClose }: EmergencyIdentificationProfileProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [notes, setNotes] = useState(profile?.manualNotes || '');
  const [photo, setPhoto] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [photoConsent, setPhotoConsent] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const choosePhoto = (event: ChangeEvent<HTMLInputElement>) => {
    const next = event.target.files?.[0] || null;
    setError(null);
    if (!next) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(next.type) || next.size > 5 * 1024 * 1024) {
      setPhoto(null);
      setPreviewUrl(null);
      setError('Choose a JPEG, PNG, or WebP image up to 5 MB.');
      return;
    }
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPhoto(next);
    setPreviewUrl(URL.createObjectURL(next));
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!touristId) {
      setError('Your verified traveller profile is still loading. Please try again shortly.');
      return;
    }
    if (!photo && !notes.trim()) {
      setError('Add a current photo or write what you are wearing.');
      return;
    }
    if (photo && !photoConsent) {
      setError('Confirm consent before analysing a photo.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const formData = new FormData();
      if (photo) formData.append('photo', photo);
      formData.append('notes', notes.trim());
      const response = await fetch(`/api/tourists/${encodeURIComponent(touristId)}/clothing-profile`, { method: 'POST', body: formData });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.success) throw new Error(data?.error || 'The emergency identification profile could not be saved.');
      setSaved(true);
      onSaved?.(data.profile);
    } catch (cause: any) {
      setError(cause.message || 'The emergency identification profile could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="emergency-profile-title">
      <div className="modal-frame">
        <div className="modal-panel max-w-xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="emergency-profile-title" className="ui-display text-2xl">Identification profile</h2>
            <p className="mt-1 text-sm leading-5 text-ink-soft">What you look like today, so responders can find you. Write it, or let AI describe a photo.</p>
          </div>
          <button onClick={onClose} className="minimal-button minimal-button-secondary px-2.5" aria-label="Close">
            <X className="size-4" />
          </button>
        </div>

        {saved ? (
          <div className="py-8 text-center">
            <CheckCircle2 className="mx-auto size-10 text-success" />
            <h3 className="mt-3 font-semibold">Emergency profile saved</h3>
            <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-ink-soft">Only the structured description is retained. It can be shown to authorised officers when an emergency or missing-person case is being handled.</p>
            <button onClick={onClose} className="minimal-button minimal-button-primary mt-5">Done</button>
          </div>
        ) : (
          <form onSubmit={save} className="mt-5 space-y-5">
            {error && <p role="alert" className="rounded-lg border border-danger/30 bg-danger/5 p-3 text-sm text-danger">{error}</p>}
            {profile?.summary && (
              <section className="rounded-lg border border-line bg-surface-2 p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-ink-soft">Current profile</p>
                <p className="mt-1 text-sm leading-6 text-ink">{profile.summary}</p>
                <p className="mt-2 text-xs text-ink-soft">Updated {profile.analysedAt ? new Date(profile.analysedAt).toLocaleString() : 'previously'} · {profile.photoAnalysed ? 'Photo analysed' : 'Written description'}</p>
              </section>
            )}
            <div>
              <label htmlFor="profile-notes" className="block text-sm font-semibold">What are you wearing or carrying?</label>
              <textarea id="profile-notes" value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={1_500} rows={4} className="nb-input mt-2 text-sm" placeholder="e.g. blue rain jacket, black backpack, white trainers, red cap" />
            </div>
            <div>
              <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/webp" onChange={choosePhoto} className="hidden" />
              <button type="button" onClick={() => fileInputRef.current?.click()} className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-line bg-surface-2 px-4 py-5 text-sm font-semibold text-ink hover:border-ink-soft">
                <ImagePlus className="size-5 text-ink-soft" /> {photo ? 'Replace photo' : 'Add a photo (optional)'}
              </button>
              <p className="mt-2 text-xs text-ink-soft">JPEG, PNG or WebP, up to 5 MB. The photo is not kept after analysis.</p>
              {previewUrl && <Image src={previewUrl} alt="Selected profile preview" unoptimized width={720} height={480} className="mt-3 max-h-48 w-auto rounded-lg border border-line object-contain" />}
            </div>
            {photo && (
              <label className="flex cursor-pointer gap-3 rounded-lg border border-line bg-surface-2 p-3 text-sm leading-5 text-ink-soft">
                <input type="checkbox" checked={photoConsent} onChange={(event) => setPhotoConsent(event.target.checked)} className="mt-1 size-4" />
                <span>I consent to this photo being sent to an AI service to write the description. It will not be stored.</span>
              </label>
            )}
            <p className="text-xs leading-5 text-ink-soft">Only authorised staff handling an active emergency or missing-person case can see this profile.</p>
            <button type="submit" disabled={saving} className="minimal-button minimal-button-primary w-full justify-center disabled:cursor-not-allowed disabled:opacity-60">
              {saving ? <><Loader2 className="size-4 animate-spin" /> Creating profile…</> : 'Save emergency profile'}
            </button>
          </form>
        )}
      </div>
    </div>
  </div>
);
}
