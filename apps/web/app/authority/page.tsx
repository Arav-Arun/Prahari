'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { LogOut, Plus, RefreshCw, X } from 'lucide-react';
import MapView from '@/components/maps/MapView';
import IncidentQueue from '@/components/authority/IncidentQueue';
import MeshRouteBadge from '@/components/authority/MeshRouteBadge';
import AuthorityEmergencyChat from '@/components/authority/AuthorityEmergencyChat';
import AIIncidentBrief from '@/components/authority/AIIncidentBrief';
import MissingPersonDraftPanel from '@/components/authority/MissingPersonDraftPanel';
import AssignResponderForm from '@/components/authority/AssignResponderForm';
import { languageCodeFromPreference, travellerLanguageLabel } from '@/lib/languages';
import { subscribeToPrahariLive } from '@/lib/supabaseRealtime';
import dynamic from 'next/dynamic';

const GeofencePickerMap = dynamic(() => import('@/components/maps/GeofencePickerMap'), { ssr: false });

type DashboardStats = {
  activeTourists: number;
  liveIncidents: number;
  highRiskZones: number;
  respondersAvailable: number;
  respondersTotal: number;
};

function coordinatesForDisplay(location?: { lat?: number; lng?: number } | null) {
  if (typeof location?.lat !== 'number' || typeof location?.lng !== 'number') return 'Not reported';
  return `${location.lat.toFixed(4)}, ${location.lng.toFixed(4)}`;
}

function isAvailable(responder: any) {
  return String(responder.status ?? '').toLowerCase() === 'available';
}

function hasRecentLocation(timestamp?: string) {
  const reportedAt = timestamp ? new Date(timestamp).getTime() : Number.NaN;
  const ageMs = Date.now() - reportedAt;
  return Number.isFinite(reportedAt) && ageMs >= -60_000 && ageMs <= 5 * 60_000;
}

function lastReportedForDisplay(timestamp?: string) {
  if (!timestamp) return 'Not reported';
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return 'Not reported';
  return date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

export default function AuthorityPage() {
  const [currentUser, setCurrentUser] = useState<any | null>(null);
  const [incidents, setIncidents] = useState<any[]>([]);
  const [geofences, setGeofences] = useState<any[]>([]);
  const [responders, setResponders] = useState<any[]>([]);
  const [consentedTravellers, setConsentedTravellers] = useState<any[]>([]);
  const [liveLocations, setLiveLocations] = useState<Record<string, { touristId: string; lat: number; lng: number; timestamp?: string }>>({});
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [selectedIncident, setSelectedIncident] = useState<any | null>(null);
  const [assigningIncidentId, setAssigningIncidentId] = useState<string | null>(null);
  const [investigationData, setInvestigationData] = useState<{ tourist: any | null; locations: any[]; loading: boolean }>({
    tourist: null,
    locations: [],
    loading: false,
  });
  const [efirs, setEfirs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [efirLoading, setEfirLoading] = useState(false);
  const [socketConnected, setSocketConnected] = useState(false);
  const [realtimeDelivery, setRealtimeDelivery] = useState<'checking' | 'verified' | 'fallback'>('checking');
  const [showGeofenceForm, setShowGeofenceForm] = useState(false);
  const [geofenceError, setGeofenceError] = useState<string | null>(null);
  const [geofenceSaving, setGeofenceSaving] = useState(false);
  const [geofenceUpdatingId, setGeofenceUpdatingId] = useState<string | null>(null);
  const [geofenceForm, setGeofenceForm] = useState({
    name: '',
    type: 'high_risk',
    severity: 'high',
    description: '',
    coordinates: '',
  });
  const realtimeProbeNonce = useRef<string | null>(null);
  const realtimeProbeTimer = useRef<number | null>(null);

  /**
   * A browser has one session cookie per origin, not per tab. If a traveller
   * signs in from another tab, an already-rendered authority desk must not
   * continue to look authenticated until the next protected action fails.
   */
  const requireAuthoritySession = useCallback(async () => {
    try {
      const response = await fetch('/api/auth/me', { cache: 'no-store' });
      const data = await response.json().catch(() => null);
      const role = data?.user?.role;
      if (!response.ok || !data?.authenticated || !['authority', 'admin', 'responder'].includes(role)) {
        setCurrentUser(null);
        window.location.assign('/login?redirect=/authority');
        return null;
      }
      setCurrentUser(data.user);
      return data.user;
    } catch {
      setCurrentUser(null);
      window.location.assign('/login?redirect=/authority');
      return null;
    }
  }, []);

  const verifyRealtimeDelivery = useCallback(async () => {
    if (realtimeProbeTimer.current) window.clearTimeout(realtimeProbeTimer.current);
    const nonce = crypto.randomUUID().replaceAll('-', '');
    realtimeProbeNonce.current = nonce;
    setRealtimeDelivery('checking');
    try {
      const response = await fetch('/api/realtime/probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nonce }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result?.delivery?.accepted) {
        setRealtimeDelivery('fallback');
        return;
      }
      realtimeProbeTimer.current = window.setTimeout(() => {
        if (realtimeProbeNonce.current === nonce) setRealtimeDelivery('fallback');
      }, 5_000);
    } catch {
      setRealtimeDelivery('fallback');
    }
  }, []);

  const fetchEfirs = useCallback(async () => {
    try {
      setEfirLoading(true);
      const response = await fetch('/api/efir');
      const data = await response.json();
      if (response.ok && data.success) setEfirs(data.efirs ?? []);
    } catch (error) {
      console.error('Unable to refresh incident-draft queue:', error);
    } finally {
      setEfirLoading(false);
    }
  }, []);

  const fetchDashboardData = useCallback(async (silent = false) => {
    try {
      if (!silent) setLoading(true);
      const session = await requireAuthoritySession();
      if (!session) return;
      const [incRes, geoRes, statRes, responderRes, touristRes] = await Promise.all([
        fetch('/api/incidents'),
        fetch('/api/geofences'),
        fetch('/api/stats'),
        fetch('/api/responders'),
        fetch('/api/tourists'),
      ]);
      const [incData, geoData, statData, responderData, touristData] = await Promise.all([
        incRes.json(), geoRes.json(), statRes.json(), responderRes.json(), touristRes.json(),
      ]);

      const incList = (incRes.ok && incData.success && Array.isArray(incData.incidents)) ? incData.incidents : [];
      setIncidents(incList);

      const geoList = (geoRes.ok && geoData.success && Array.isArray(geoData.geofences))
        ? geoData.geofences.map((g: any) => ({
            id: g.id ?? g.name,
            name: g.name,
            coordinates: g.coordinates ?? g.geometry?.coordinates?.[0] ?? [],
            severity: g.severity,
          }))
        : [];
      setGeofences(geoList);

      if (statRes.ok && statData.success) {
        setStats(statData.stats);
      } else {
        setStats(null);
      }

      const respList = (responderRes.ok && responderData.success && Array.isArray(responderData.responders))
        ? responderData.responders.map((r: any) => ({
            id: r.id ?? r.responderId,
            unitId: r.unitId ?? r.responderId,
            name: r.name ?? r.responderId ?? 'Unnamed responder',
            status: r.status,
            lat: r.location?.lat,
            lng: r.location?.lng,
            type: r.type ?? r.department,
          })).filter((r: any) => typeof r.lat === 'number' && typeof r.lng === 'number')
        : [];
      setResponders(respList);

      if (touristRes.ok && touristData.success) {
        const consentedTouristRows = (touristData.tourists ?? [])
          .filter((tourist: any) => tourist.trackingConsent !== false);
        setConsentedTravellers(consentedTouristRows);
        const reportedLocations = Object.fromEntries(
          consentedTouristRows
            .filter((t: any) => typeof t.currentLocation?.lat === 'number' && typeof t.currentLocation?.lng === 'number' && hasRecentLocation(t.currentLocation.timestamp))
            .map((t: any) => [t.touristId, {
              touristId: t.touristId,
              lat: t.currentLocation.lat,
              lng: t.currentLocation.lng,
              timestamp: t.currentLocation.timestamp,
            }])
        );
        setLiveLocations(reportedLocations);
      } else {
        setLiveLocations({});
        setConsentedTravellers([]);
      }
    } catch (error) {
      console.error('Unable to refresh authority dashboard:', error);
    } finally {
      if (!silent) setLoading(false);
    }
  }, [requireAuthoritySession]);

  useEffect(() => {
    void fetchDashboardData();
    void fetchEfirs();

    const refreshTimer = window.setInterval(() => void fetchDashboardData(true), 15_000);
    return () => window.clearInterval(refreshTimer);
  }, [fetchDashboardData, fetchEfirs]);

  useEffect(() => {
    if (!showGeofenceForm) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setShowGeofenceForm(false); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [showGeofenceForm]);

  useEffect(() => subscribeToPrahariLive({
    onConnectionChange: (connected) => {
      setSocketConnected(connected);
      if (connected) void verifyRealtimeDelivery();
      else setRealtimeDelivery('fallback');
    },
    onIncidentCreated: () => { void fetchDashboardData(true); void fetchEfirs(); },
    onIncidentUpdated: () => { void fetchDashboardData(true); void fetchEfirs(); },
    onTouristLocation: () => void fetchDashboardData(true),
    onProbe: (probe: any) => {
      if (probe?.nonce && probe.nonce === realtimeProbeNonce.current) {
        if (realtimeProbeTimer.current) window.clearTimeout(realtimeProbeTimer.current);
        setRealtimeDelivery('verified');
      }
    },
  }), [fetchDashboardData, fetchEfirs, verifyRealtimeDelivery]);

  useEffect(() => () => {
    if (realtimeProbeTimer.current) window.clearTimeout(realtimeProbeTimer.current);
  }, []);

  useEffect(() => {
    if (!selectedIncident?.touristId) {
      setInvestigationData({ tourist: null, locations: [], loading: false });
      return;
    }

    let cancelled = false;
    setInvestigationData((previous) => ({ ...previous, loading: true }));
    Promise.all([
      fetch(`/api/tourists/${encodeURIComponent(selectedIncident.touristId)}`).then((response) => response.json()).catch(() => null),
      fetch(`/api/locations?touristId=${encodeURIComponent(selectedIncident.touristId)}`).then((response) => response.json()).catch(() => null),
    ]).then(([touristResult, locationResult]) => {
      if (!cancelled) {
        setInvestigationData({
          tourist: touristResult?.success ? touristResult.tourist : null,
          locations: locationResult?.success ? locationResult.history ?? [] : [],
          loading: false,
        });
      }
    });
    return () => { cancelled = true; };
  }, [selectedIncident?.touristId]);

  const handleResolveIncident = async () => {
    if (!selectedIncident) return;
    try {
      const response = await fetch('/api/incidents', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          incidentId: selectedIncident.incidentId,
          status: 'RESOLVED',
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error ?? 'Unable to resolve incident.');
      setSelectedIncident(null);
      void fetchDashboardData(true);
    } catch (error: any) {
      window.alert(error.message ?? 'Unable to resolve incident.');
    }
  };

  const handleEfirAction = async (incidentId: string, action: 'APPROVE' | 'REJECT') => {
    try {
      const response = await fetch('/api/efir', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ incidentId, action }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error ?? 'Unable to update incident draft.');
      await fetchEfirs();
    } catch (error: any) {
      window.alert(error.message ?? 'Unable to update incident draft.');
    }
  };

  const handleCreateGeofence = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setGeofenceError(null);

    const coordinates = geofenceForm.coordinates
      .split(/\n|;/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.split(',').map((value) => Number(value.trim())));

    const validCoordinates = coordinates.length >= 3 && coordinates.every(
      ([lat, lng]) => Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
    );
    if (!validCoordinates) {
      setGeofenceError('Enter at least three valid latitude, longitude pairs—one pair per line.');
      return;
    }

    const closedCoordinates = [...coordinates] as Array<[number, number]>;
    const first = closedCoordinates[0];
    const last = closedCoordinates[closedCoordinates.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) closedCoordinates.push(first);

    try {
      setGeofenceSaving(true);
      const response = await fetch('/api/geofences', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: geofenceForm.name.trim(),
          type: geofenceForm.type,
          severity: geofenceForm.severity,
          description: geofenceForm.description.trim(),
          coordinates: closedCoordinates,
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error ?? 'Unable to create geofence.');
      setShowGeofenceForm(false);
      setGeofenceForm({ name: '', type: 'high_risk', severity: 'high', description: '', coordinates: '' });
      await fetchDashboardData(true);
    } catch (error: any) {
      setGeofenceError(error.message ?? 'Unable to create geofence.');
    } finally {
      setGeofenceSaving(false);
    }
  };

  const handleDeactivateGeofence = async (geofence: any) => {
    if (!geofence?.id || geofenceUpdatingId) return;
    if (!window.confirm(`Deactivate ${geofence.name}? It will stop generating safety evaluations but remain retained in the operational database.`)) return;
    try {
      setGeofenceUpdatingId(geofence.id);
      const response = await fetch('/api/geofences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: geofence.id, active: false }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error ?? 'Unable to deactivate geofence.');
      await fetchDashboardData(true);
    } catch (error: any) {
      window.alert(error.message ?? 'Unable to deactivate geofence.');
    } finally {
      setGeofenceUpdatingId(null);
    }
  };

  const geofencePoints = geofenceForm.coordinates
    .split('\n')
    .map((line) => line.split(',').map((value) => parseFloat(value.trim())))
    .filter((parts) => parts.length >= 2 && !isNaN(parts[0]) && !isNaN(parts[1]))
    .map((parts) => [parts[0], parts[1]] as [number, number]);

  const liveIncidents = incidents.filter((incident) => !['resolved', 'cancelled', 'rejected'].includes(String(incident.status ?? '').toLowerCase()));
  const activeIncidentTouristIds = new Set(liveIncidents.map((incident) => incident.touristId));
  const mapIncidents = incidents
    .filter((incident) => {
      const recordedAt = new Date(incident.createdAt ?? 0).getTime();
      return Number.isFinite(recordedAt) && recordedAt >= Date.now() - 30 * 24 * 60 * 60 * 1000;
    })
    .filter((incident) => typeof incident.location?.lat === 'number' && typeof incident.location?.lng === 'number')
    .map((incident) => ({
      id: incident.id ?? incident.incidentId,
      incidentId: incident.incidentId,
      type: incident.type,
      lat: incident.location.lat,
      lng: incident.location.lng,
      severity: incident.severity,
    }));

  const profile = investigationData.tourist?.clothingProfile;

  return (
    <div className="minimal-page">
      <header className="minimal-nav">
        <Link href="/" className="minimal-brand">Prahari</Link>
        <div className="flex items-center gap-2">
          {currentUser && <span className="hidden text-sm text-ink-soft md:inline">{currentUser.name} · {currentUser.role}</span>}
          <button onClick={() => void fetchDashboardData()} className="minimal-button minimal-button-secondary" disabled={loading} aria-label="Refresh">
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
          </button>
          <button onClick={() => { setGeofenceError(null); setShowGeofenceForm(true); }} className="minimal-button minimal-button-secondary" aria-label="New geofence">
            <Plus size={16} /><span className="hidden sm:inline">Geofence</span>
          </button>
          <button
            onClick={async () => { await fetch('/api/auth/logout', { method: 'POST' }); window.location.href = '/login'; }}
            className="minimal-button minimal-button-secondary"
            aria-label="Sign out"
          >
            <LogOut size={16} /><span className="hidden sm:inline">Sign out</span>
          </button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl px-5 py-8 sm:py-10">
        <section className="flex flex-wrap items-end justify-between gap-4">
          <h1 className="ui-display text-3xl sm:text-4xl">Operations</h1>
          <span className="text-sm text-ink-soft">
            {realtimeDelivery === 'verified' ? 'Live updates on' : socketConnected && realtimeDelivery === 'checking' ? 'Connecting to live updates…' : 'Refreshing every 15 seconds'}
          </span>
        </section>

        <section className="mt-6 grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
          <Metric label="Registered travellers" value={stats?.activeTourists} />
          <Metric label="Open incidents" value={stats?.liveIncidents} tone={stats?.liveIncidents ? 'text-danger' : undefined} />
          <Metric label="High-risk geofences" value={stats?.highRiskZones} />
          <Metric label="Available responders" value={stats ? `${stats.respondersAvailable}/${stats.respondersTotal}` : undefined} />
        </section>

        <section className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.65fr)_minmax(340px,0.85fr)]">
          <div className="minimal-card">
            <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3">
              <h2 className="text-lg font-semibold">Map</h2>
              <span className="text-sm text-ink-soft">{Object.keys(liveLocations).length} traveller{Object.keys(liveLocations).length === 1 ? '' : 's'} sharing location</span>
            </div>
            <MapView liveTourists={Object.values(liveLocations)} geofences={geofences} incidents={mapIncidents} responders={responders} />
          </div>
          <IncidentQueue incidents={liveIncidents} selectedIncidentId={selectedIncident?.incidentId} onSelectIncident={setSelectedIncident} />
        </section>

        {selectedIncident && (
          <section className="minimal-card mt-5" aria-label="Incident review">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h2 className="font-mono text-xl font-semibold">{selectedIncident.incidentId}</h2>
                <p className="mt-1 text-sm text-ink-soft">{selectedIncident.type} · {coordinatesForDisplay(selectedIncident.location)}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button onClick={() => setAssigningIncidentId(selectedIncident.incidentId)} className="minimal-button minimal-button-primary">
                  {selectedIncident.assignedResponderName || selectedIncident.assignedResponderUnitId ? 'Reassign' : 'Assign help'}
                </button>
                <button onClick={handleResolveIncident} className="minimal-button minimal-button-secondary">Resolve</button>
                <button onClick={() => setSelectedIncident(null)} className="minimal-button minimal-button-secondary px-2.5" aria-label="Close incident"><X size={16} /></button>
              </div>
            </div>

            {assigningIncidentId === selectedIncident.incidentId && (
              <AssignResponderForm
                incident={selectedIncident}
                canAutoDispatch={responders.some(isAvailable)}
                onAssigned={(incident) => {
                  setSelectedIncident(incident);
                  setAssigningIncidentId(null);
                  void fetchDashboardData(true);
                }}
                onClose={() => setAssigningIncidentId(null)}
              />
            )}

            {investigationData.loading ? (
              <p className="flex min-h-32 items-center justify-center gap-2 text-sm text-ink-soft"><RefreshCw size={16} className="animate-spin" />Loading record…</p>
            ) : (
              <div className="mt-5 space-y-5">
                <MeshRouteBadge
                  transportType={selectedIncident.transportType}
                  hopCount={selectedIncident.hopCount}
                  originDeviceId={selectedIncident.originDeviceId}
                  originalTimestamp={selectedIncident.originalTimestamp || selectedIncident.createdAt}
                  receivedTimestamp={selectedIncident.createdAt}
                  relayPath={selectedIncident.relayPath}
                />
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                  <InfoCard label="Traveller" value={investigationData.tourist?.name ?? selectedIncident.touristName ?? selectedIncident.touristId ?? 'Not recorded'} detail={investigationData.tourist?.did} />
                  <InfoCard label="Identity" value={investigationData.tourist?.identityStatus ? String(investigationData.tourist.identityStatus).replaceAll('_', ' ') : 'Not recorded'} detail={investigationData.tourist?.nationality} />
                  <InfoCard label="Location history" value={investigationData.locations.length ? `${investigationData.locations.length} point${investigationData.locations.length === 1 ? '' : 's'}` : 'None recorded'} detail={investigationData.locations[0] ? `Last: ${coordinatesForDisplay(investigationData.locations[0].coordinates ?? investigationData.locations[0])}` : undefined} />
                  <InfoCard label="Responder" value={selectedIncident.assignedResponderName ?? selectedIncident.assignedResponderUnitId ?? 'Unassigned'} detail={selectedIncident.etaMinutes != null ? `ETA ${selectedIncident.etaMinutes} min` : undefined} />
                </div>

                {selectedIncident.voiceStatement && (
                  <div className="rounded-xl border border-line p-4">
                    <p className="text-xs text-ink-soft">Voice SOS · {travellerLanguageLabel(selectedIncident.voiceStatementLanguage)}</p>
                    <p className="mt-1 whitespace-pre-wrap text-sm leading-6">&ldquo;{selectedIncident.voiceStatement}&rdquo;</p>
                  </div>
                )}

                {profile && (
                  <div className="rounded-xl border border-line p-4 text-sm">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <p className="text-xs text-ink-soft">Identification profile</p>
                      <span className="text-xs text-ink-soft">{profile.photoAnalysed ? 'From photo' : 'Written by traveller'} · {profile.confidence || 'low'} confidence</span>
                    </div>
                    <p className="mt-1 font-medium">{profile.summary || 'No summary recorded'}</p>
                    {profile.source !== 'manual' ? (
                    <div className="mt-3 grid gap-3 text-xs sm:grid-cols-2 xl:grid-cols-4">
                      <div>
                        <p className="text-ink-soft">Clothing</p>
                        <ul className="mt-1 space-y-0.5">
                          {(profile.clothing ?? []).length
                            ? profile.clothing.map((item: any, index: number) => <li key={`${item.item}-${index}`}>{item.item}: {item.color}{item.details && item.details !== 'Not observed' ? ` — ${item.details}` : ''}</li>)
                            : <li>Not recorded</li>}
                        </ul>
                      </div>
                      <div><p className="text-ink-soft">Footwear</p><p className="mt-1">{profile.footwear || 'Not recorded'}</p></div>
                      <div><p className="text-ink-soft">Accessories</p><p className="mt-1">{(profile.accessories ?? []).join(', ') || 'None'}</p></div>
                      <div><p className="text-ink-soft">Carrying</p><p className="mt-1">{(profile.carriedItems ?? []).join(', ') || 'None'}</p></div>
                    </div>
                    ) : null}
                  </div>
                )}

                <div className="grid gap-5 border-t border-line pt-5 lg:grid-cols-2">
                  <AuthorityEmergencyChat
                    incidentId={selectedIncident.incidentId}
                    touristName={selectedIncident.touristName ?? selectedIncident.touristId}
                    touristLanguage={languageCodeFromPreference(investigationData.tourist?.preferences?.language)}
                  />
                  <div className="space-y-5">
                    <AIIncidentBrief incidentId={selectedIncident.incidentId} />
                    <div className="border-t border-line pt-5">
                      <MissingPersonDraftPanel
                        incident={selectedIncident}
                        onSaved={(incident) => {
                          setSelectedIncident(incident);
                          void fetchDashboardData(true);
                        }}
                      />
                    </div>
                  </div>
                </div>
              </div>
            )}
          </section>
        )}

        <section className="minimal-card mt-5 overflow-hidden p-0" aria-labelledby="travellers-heading">
          <div className="flex flex-wrap items-baseline justify-between gap-3 px-6 pt-6">
            <h2 id="travellers-heading" className="text-lg font-semibold">Travellers sharing location</h2>
            <span className="text-sm text-ink-soft">{consentedTravellers.length}</span>
          </div>

          {consentedTravellers.length === 0 ? (
            <p className="px-6 pb-6 pt-3 text-sm text-ink-soft">No one is sharing their location yet.</p>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-left text-sm md:min-w-[760px]">
                <thead className="border-y border-line bg-surface-2 text-xs text-ink-soft">
                  <tr>
                    <th scope="col" className="px-5 py-3 font-medium sm:px-6">Traveller</th>
                    <th scope="col" className="px-4 py-3 font-medium">Last location</th>
                    <th scope="col" className="hidden px-4 py-3 font-medium sm:table-cell">Updated</th>
                    <th scope="col" className="hidden px-4 py-3 font-medium md:table-cell">Identification profile</th>
                    <th scope="col" className="px-4 py-3 font-medium">Case</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {consentedTravellers.map((traveller) => {
                    const location = traveller.currentLocation;
                    const hasLocation = typeof location?.lat === 'number' && typeof location?.lng === 'number';
                    const isLive = hasRecentLocation(location?.timestamp);
                    const hasActiveCase = activeIncidentTouristIds.has(traveller.touristId);
                    const clothingSummary = traveller.clothingProfile?.summary;
                    return (
                      <tr key={traveller.touristId} className="align-top">
                        <td className="px-5 py-3.5 sm:px-6">
                          <p className="font-medium">{traveller.name || 'Name not recorded'}</p>
                          <p className="mt-0.5 font-mono text-xs text-ink-soft">{traveller.touristId}</p>
                        </td>
                        <td className="px-4 py-3.5 font-mono text-xs">{hasLocation ? coordinatesForDisplay(location) : '—'}</td>
                        <td className="hidden px-4 py-3.5 text-xs text-ink-soft sm:table-cell">
                          {lastReportedForDisplay(location?.timestamp)}
                          {isLive && <span className="ml-2 rounded-full bg-emerald-50 px-2 py-0.5 font-medium text-emerald-800">Live</span>}
                        </td>
                        <td className="hidden max-w-xs px-4 py-3.5 text-xs leading-5 text-ink-soft md:table-cell">
                          {clothingSummary ? (hasActiveCase ? clothingSummary : 'On file — visible during an active case') : '—'}
                        </td>
                        <td className="px-4 py-3.5 text-xs">
                          {hasActiveCase ? <span className="font-medium text-danger">Active</span> : <span className="text-ink-soft">None</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <div className="mt-5 grid gap-5 lg:grid-cols-2">
          <section className="minimal-card">
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="text-lg font-semibold">Geofences</h2>
              <span className="text-sm text-ink-soft">{geofences.length} active</span>
            </div>
            {geofences.length === 0 ? (
              <p className="mt-3 text-sm text-ink-soft">None published. Use “Geofence” in the header to draw one.</p>
            ) : (
              <ul className="mt-3 divide-y divide-line">
                {geofences.map((geofence) => (
                  <li key={geofence.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                    <div>
                      <p className="font-medium">{geofence.name}</p>
                      <p className="mt-0.5 text-xs capitalize text-ink-soft">{geofence.severity ?? 'high'} severity · {geofence.coordinates?.length ?? 0} points</p>
                    </div>
                    <button type="button" onClick={() => void handleDeactivateGeofence(geofence)} disabled={geofenceUpdatingId === geofence.id} className="minimal-button minimal-button-secondary text-xs">
                      {geofenceUpdatingId === geofence.id ? 'Deactivating…' : 'Deactivate'}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="minimal-card">
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="text-lg font-semibold">Reports to review</h2>
              <button onClick={() => void fetchEfirs()} className="minimal-text-link" disabled={efirLoading}>{efirLoading ? 'Refreshing…' : 'Refresh'}</button>
            </div>
            {efirs.length === 0 ? (
              <p className="mt-3 text-sm text-ink-soft">No traveller reports yet.</p>
            ) : (
              <ul className="mt-3 divide-y divide-line">
                {efirs.map((efir) => {
                  const incidentId = efir._incidentId ?? efir.incidentId;
                  const pending = ['PENDING_AUTHORISED_REVIEW', 'PENDING_OFFICER_APPROVAL'].includes(efir.policeVerification);
                  const reviewed = ['AUTHORISED_REVIEWED', 'OFFICER_VERIFIED'].includes(efir.policeVerification);
                  return (
                    <li key={efir.efirId} className="py-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <p className="font-medium">{efir.touristName ?? 'Unknown'} · {efir.incidentCategory ?? efir.incidentType ?? 'Report'}</p>
                          <p className="mt-0.5 text-xs text-ink-soft"><span className="font-mono">{efir.efirId}</span> · {efir.createdAt ? new Date(efir.createdAt).toLocaleString() : ''}</p>
                        </div>
                        <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${pending ? 'bg-amber-50 text-amber-900' : reviewed ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-800'}`}>
                          {pending ? 'Awaiting review' : reviewed ? 'Reviewed' : 'Returned'}
                        </span>
                      </div>
                      {efir.narrative && <p className="mt-2 line-clamp-2 text-sm text-ink-soft">{efir.narrative}</p>}
                      {pending && (
                        <div className="mt-3 flex gap-2">
                          <button onClick={() => void handleEfirAction(incidentId, 'APPROVE')} className="minimal-button minimal-button-primary text-xs">Mark reviewed</button>
                          <button onClick={() => void handleEfirAction(incidentId, 'REJECT')} className="minimal-button minimal-button-secondary text-xs">Return</button>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
      </main>

      {showGeofenceForm && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="geofence-dialog-title">
          <div className="modal-frame">
            <form onSubmit={handleCreateGeofence} className="modal-panel max-w-xl">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 id="geofence-dialog-title" className="ui-display text-2xl">New geofence</h2>
                  <p className="mt-1 text-sm text-ink-soft">Click the map to draw the boundary.</p>
                </div>
                <button type="button" onClick={() => setShowGeofenceForm(false)} className="minimal-button minimal-button-secondary px-2.5" aria-label="Close"><X size={16} /></button>
              </div>

              <div className="mt-5 grid gap-4 sm:grid-cols-2">
                <label className="block text-sm font-medium sm:col-span-2">Name
                  <input required value={geofenceForm.name} onChange={(event) => setGeofenceForm((current) => ({ ...current, name: event.target.value }))} className="nb-input mt-1.5 text-sm" placeholder="e.g. Cliff edge, north trail" />
                </label>
                <label className="block text-sm font-medium">Type
                  <select value={geofenceForm.type} onChange={(event) => setGeofenceForm((current) => ({ ...current, type: event.target.value }))} className="nb-input mt-1.5 text-sm">
                    <option value="high_risk">High-risk area</option><option value="restricted">Restricted area</option><option value="pickpocket_hotspot">Pickpocket hotspot</option><option value="disaster_prone">Disaster-prone area</option><option value="tourist_only">Tourist-only zone</option><option value="safe_zone">Safe zone</option>
                  </select>
                </label>
                <label className="block text-sm font-medium">Severity
                  <select value={geofenceForm.severity} onChange={(event) => setGeofenceForm((current) => ({ ...current, severity: event.target.value }))} className="nb-input mt-1.5 text-sm">
                    <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="critical">Critical</option>
                  </select>
                </label>
                <div className="sm:col-span-2">
                  <GeofencePickerMap
                    points={geofencePoints}
                    onAddPoint={(pt) => setGeofenceForm((prev) => ({
                      ...prev,
                      coordinates: [prev.coordinates.trim(), `${pt[0]}, ${pt[1]}`].filter(Boolean).join('\n'),
                    }))}
                    onRemoveLastPoint={() => setGeofenceForm((prev) => ({
                      ...prev,
                      coordinates: prev.coordinates.trim().split('\n').filter(Boolean).slice(0, -1).join('\n'),
                    }))}
                    onClearPoints={() => setGeofenceForm((prev) => ({ ...prev, coordinates: '' }))}
                  />
                </div>
                <label className="block text-sm font-medium sm:col-span-2">Boundary points <span className="font-normal text-ink-soft">(lat, lng per line)</span>
                  <textarea required rows={3} value={geofenceForm.coordinates} onChange={(event) => setGeofenceForm((current) => ({ ...current, coordinates: event.target.value }))} className="nb-input mt-1.5 font-mono text-xs" placeholder={'26.9124, 75.7873\n26.9130, 75.7901\n26.9102, 75.7899'} />
                </label>
                <label className="block text-sm font-medium sm:col-span-2">Note <span className="font-normal text-ink-soft">(optional)</span>
                  <input value={geofenceForm.description} onChange={(event) => setGeofenceForm((current) => ({ ...current, description: event.target.value }))} className="nb-input mt-1.5 text-sm" placeholder="Reason or source" />
                </label>
              </div>

              {geofenceError && <p className="mt-4 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2.5 text-sm text-danger">{geofenceError}</p>}
              <div className="mt-6 flex justify-end gap-2">
                <button type="button" onClick={() => setShowGeofenceForm(false)} className="minimal-button minimal-button-secondary">Cancel</button>
                <button type="submit" disabled={geofenceSaving} className="minimal-button minimal-button-primary">{geofenceSaving ? 'Publishing…' : 'Publish'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

function Metric({ label, value, tone = 'text-ink' }: { label: string; value?: number | string; tone?: string }) {
  return (
    <div className="minimal-card p-4 sm:p-5">
      <p className="text-sm text-ink-soft">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tracking-tight ${tone}`}>{value ?? '—'}</p>
    </div>
  );
}

function InfoCard({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface-2 p-4">
      <p className="text-xs text-ink-soft">{label}</p>
      <p className="mt-1 break-words text-sm font-medium">{value}</p>
      {detail && <p className="mt-1 break-all text-xs leading-5 text-ink-soft">{detail}</p>}
    </div>
  );
}
