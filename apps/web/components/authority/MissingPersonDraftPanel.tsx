'use client';

import { useState } from 'react';
import { Clipboard, Loader2 } from 'lucide-react';

export default function MissingPersonDraftPanel({ incident, onSaved }: { incident: any; onSaved: (incident: any) => void }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const draft = incident?.missingPersonDraft;

  const generate = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/efir/missing-person-draft', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ incidentId: incident.incidentId }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.success) throw new Error(data?.error || 'Missing-person draft could not be generated.');
      onSaved(data.incident);
    } catch (cause: any) {
      setError(cause.message || 'Missing-person draft could not be generated.');
    } finally { setLoading(false); }
  };

  const copyDraft = async () => {
    if (!draft?.narrative || !navigator.clipboard) return;
    await navigator.clipboard.writeText(draft.narrative);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2_000);
  };

  return (
    <div className="space-y-3" aria-label="Missing-person draft">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Missing-person draft</h3>
          <p className="text-xs text-ink-soft">Built from the verified profile, last location, contacts and SOS text.</p>
        </div>
        <button onClick={generate} disabled={loading} className="minimal-button minimal-button-secondary text-xs">
          {loading && <Loader2 className="size-3 animate-spin" />}
          {draft ? 'Regenerate' : 'Generate'}
        </button>
      </div>
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
      {draft && (
        <div className="space-y-2">
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-xl border border-line bg-surface-2 p-3 font-sans text-xs leading-relaxed">{draft.narrative}</pre>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-ink-soft">
            <span>Not filed with police. Verify the facts before using it.</span>
            <button onClick={() => void copyDraft()} className="minimal-button minimal-button-secondary text-xs"><Clipboard className="size-3" />{copied ? 'Copied' : 'Copy'}</button>
          </div>
        </div>
      )}
    </div>
  );
}
