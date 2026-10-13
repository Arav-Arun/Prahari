'use client';

import React from 'react';

interface IncidentItem {
  id?: string;
  incidentId: string;
  touristId?: string;
  touristName?: string;
  type?: string;
  severity?: string;
  status?: string;
  riskScore?: number | null;
  assignedResponderUnitId?: string | null;
  assignedResponderName?: string | null;
  etaMinutes?: number | null;
  transportType?: string;
  hopCount?: number;
}

interface IncidentQueueProps {
  incidents: IncidentItem[];
  selectedIncidentId?: string | null;
  onSelectIncident: (incident: IncidentItem) => void;
}

const TRANSPORT_LABELS: Record<string, string> = {
  PEER_MESH: 'Relayed by a nearby phone',
  BLE_RELAY: 'Relayed by a BLE gateway',
  LOCAL_QUEUE: 'Delayed upload',
};

export default function IncidentQueue({ incidents, selectedIncidentId, onSelectIncident }: IncidentQueueProps) {
  return (
    <section className="minimal-card h-full">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-lg font-semibold">Open incidents</h2>
        <span className="text-sm text-ink-soft">{incidents.length}</span>
      </div>

      {incidents.length === 0 ? (
        <p className="mt-6 text-sm leading-6 text-ink-soft">No open incidents. New SOS alerts and safety reviews appear here.</p>
      ) : (
        <div className="mt-4 space-y-2">
          {incidents.map((incident) => {
            const selected = selectedIncidentId === incident.incidentId;
            const critical = String(incident.severity ?? '').toLowerCase() === 'critical';
            const relay = TRANSPORT_LABELS[incident.transportType ?? ''];
            return (
              <button
                type="button"
                key={incident.id ?? incident.incidentId}
                onClick={() => onSelectIncident(incident)}
                className={`w-full rounded-xl border p-4 text-left transition ${selected ? 'border-ink bg-surface-2' : 'border-line hover:border-stone-300'}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2">
                      <span className={`size-2 shrink-0 rounded-full ${critical ? 'bg-danger' : 'bg-amber-500'}`} />
                      <span className="truncate font-mono text-sm font-semibold">{incident.incidentId}</span>
                    </p>
                    <p className="mt-1.5 truncate text-sm text-ink-soft">{incident.touristName ?? incident.touristId ?? 'Unknown traveller'}</p>
                  </div>
                  <span className="shrink-0 rounded-md bg-surface-2 px-2 py-1 text-[11px] font-medium text-ink-soft">{incident.type ?? 'Report'}</span>
                </div>
                <p className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-soft">
                  <span>{incident.assignedResponderName || incident.assignedResponderUnitId ? `Assigned ${incident.assignedResponderName || incident.assignedResponderUnitId}` : 'Unassigned'}</span>
                  {incident.etaMinutes != null && <span>ETA {incident.etaMinutes} min</span>}
                  {incident.riskScore != null && <span>Risk {incident.riskScore}/100</span>}
                  {relay && <span>{relay}</span>}
                </p>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
