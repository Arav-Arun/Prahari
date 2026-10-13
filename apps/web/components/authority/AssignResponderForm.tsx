'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';

interface AssignResponderFormProps {
  incident: any;
  /** Registered responders with a live position, for the automatic option. */
  canAutoDispatch: boolean;
  onAssigned: (incident: any) => void;
  onClose: () => void;
}

/** Records who is going to the traveller; the traveller sees it on their SOS card. */
export default function AssignResponderForm({ incident, canAutoDispatch, onAssigned, onClose }: AssignResponderFormProps) {
  const [unit, setUnit] = useState(incident.assignedResponderName ?? incident.assignedResponderUnitId ?? '');
  const [eta, setEta] = useState(incident.etaMinutes != null ? String(incident.etaMinutes) : '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const update = async (body: Record<string, unknown>) => {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch('/api/incidents', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ incidentId: incident.incidentId, ...body }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error ?? 'The assignment could not be saved.');
      onAssigned(data.incident);
    } catch (cause: any) {
      setError(cause.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="mt-4 rounded-xl border border-line bg-surface-2 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        const minutes = Number.parseInt(eta, 10);
        void update({
          status: 'DISPATCHED',
          assignedResponderUnitId: unit.trim(),
          assignedResponderName: unit.trim(),
          ...(Number.isFinite(minutes) && minutes > 0 ? { etaMinutes: minutes } : {}),
        });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_8rem]">
        <label className="text-xs font-medium text-ink-soft">
          Unit or officer
          <input required value={unit} onChange={(event) => setUnit(event.target.value)} placeholder="e.g. PCR van 14, Brahmpuri" className="nb-input mt-1 text-sm" />
        </label>
        <label className="text-xs font-medium text-ink-soft">
          ETA (minutes)
          <input type="number" min={1} max={240} value={eta} onChange={(event) => setEta(event.target.value)} className="nb-input mt-1 text-sm" />
        </label>
      </div>
      {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="submit" disabled={saving || !unit.trim()} className="minimal-button minimal-button-primary">
          {saving && <Loader2 className="size-4 animate-spin" />} Assign
        </button>
        {canAutoDispatch && (
          <button type="button" disabled={saving} onClick={() => void update({ action: 'AUTO_DISPATCH' })} className="minimal-button minimal-button-secondary">
            Nearest registered unit
          </button>
        )}
        <button type="button" onClick={onClose} className="minimal-button minimal-button-secondary">Cancel</button>
        <p className="text-xs text-ink-soft">The traveller sees this on their SOS card.</p>
      </div>
    </form>
  );
}
