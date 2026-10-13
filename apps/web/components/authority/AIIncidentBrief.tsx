'use client';

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { COMMUNICATION_LANGUAGES } from '@/lib/languages';

type Brief = {
  overview: string;
  priorityActions: string[];
  questionsForTraveller: string[];
  uncertainties: string[];
};

export default function AIIncidentBrief({ incidentId }: { incidentId: string }) {
  const [brief, setBrief] = useState<Brief | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [briefLanguage, setBriefLanguage] = useState('en-IN');

  useEffect(() => {
    setBrief(null);
    setError(null);
  }, [incidentId]);

  const generate = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/authority/incidents/${encodeURIComponent(incidentId)}/brief`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outputLanguage: briefLanguage }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.success) throw new Error(data?.error || 'The AI brief could not be generated.');
      setBrief(data.brief);
    } catch (error: any) {
      setError(error.message || 'The AI brief could not be generated.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-3" aria-label="AI case brief">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">AI case brief</h3>
          <p className="text-xs text-ink-soft">A Sarvam AI summary to help review. Check it against the record.</p>
        </div>
        <div className="flex items-center gap-2">
          <select value={briefLanguage} onChange={(event) => setBriefLanguage(event.target.value)} className="rounded-lg border border-line bg-surface px-2 py-1.5 text-xs">
            {COMMUNICATION_LANGUAGES.map((language) => <option key={language.code} value={language.code}>{language.label}</option>)}
          </select>
          <button onClick={generate} disabled={loading} className="minimal-button minimal-button-secondary text-xs">
            {loading && <Loader2 size={13} className="animate-spin" />}
            {loading ? 'Preparing…' : brief ? 'Refresh' : 'Generate'}
          </button>
        </div>
      </div>
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
      {brief && (
        <div className="space-y-4 rounded-xl border border-line p-4 text-sm">
          <p className="leading-6">{brief.overview}</p>
          <div className="grid gap-4 md:grid-cols-3">
            <BriefList title="Priority checks" items={brief.priorityActions} />
            <BriefList title="Ask the traveller" items={brief.questionsForTraveller} />
            <BriefList title="Uncertain or missing" items={brief.uncertainties} />
          </div>
        </div>
      )}
    </div>
  );
}

function BriefList({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <p className="text-xs font-semibold text-ink-soft">{title}</p>
      {items.length ? (
        <ul className="mt-2 list-disc space-y-1 pl-4 text-xs leading-5">{items.map((item, index) => <li key={`${title}-${index}`}>{item}</li>)}</ul>
      ) : (
        <p className="mt-2 text-xs text-ink-soft">None.</p>
      )}
    </div>
  );
}
