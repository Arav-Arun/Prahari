'use client';

import React, { useState, useEffect, useRef } from 'react';
import { FileText, Shirt, X, Loader2, Mic, MapPin, AlertTriangle, LogOut } from 'lucide-react';
import DigitalIdCard from '@/components/tourist/DigitalIdCard';
import SosButton from '@/components/tourist/SosButton';
import MapView from '@/components/maps/MapView';
import OfflineMapPackStatus from '@/components/offline/OfflineMapPackStatus';
import EmergencyIdentificationProfile from '@/components/tourist/EmergencyIdentificationProfile';
import TravellerVoiceAssistant from '@/components/tourist/TravellerVoiceAssistant';

type LiveSafetyRisk = {
  score: number;
  level: 'low' | 'medium' | 'high' | 'critical';
  signals?: Array<{ code: string; message: string }>;
};

type NearbyHazard = {
  id: string;
  hazard: string;
  severity: string;
  reportedSeverity?: string;
  message: string;
  areaDescription: string;
  source: string;
  distanceKm: number | null;
  officialUrl: string;
};

const RISK_STYLES: Record<LiveSafetyRisk['level'], { label: string; className: string }> = {
  low: { label: 'Low', className: 'border-emerald-600/25 bg-emerald-50 text-emerald-800' },
  medium: { label: 'Moderate', className: 'border-yellow-500/30 bg-yellow-50 text-yellow-800' },
  high: { label: 'High', className: 'border-amber-500/30 bg-amber-50 text-amber-800' },
  critical: { label: 'Critical', className: 'border-red-500/30 bg-red-50 text-red-800' },
};

const EMPTY_REPORT_FORM = {
  category: 'Emergency / personal safety',
  occurrenceAt: '',
  narrative: '',
  suspectDescription: '',
  witnessName: '',
  witnessContact: '',
  stolenItems: '',
  injuries: '',
  evidenceReference: '',
  callbackNumber: '',
  declarationAccepted: false,
};

function greetingForNow() {
  const hour = new Date().getHours();
  return hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
}

// The traveller's own profile, kept on this device so the dashboard and SOS
// still open with no signal. Cleared on sign-out.
const SAVED_PROFILE_KEY = 'prahari_traveller_profile';

function readSavedProfile() {
  try {
    return JSON.parse(localStorage.getItem(SAVED_PROFILE_KEY) ?? 'null');
  } catch {
    return null;
  }
}

export default function CitizenPage() {
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [locationConsent, setLocationConsent] = useState(true);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [safetyAlert, setSafetyAlert] = useState<string | null>(null);
  const [nearbyHazards, setNearbyHazards] = useState<NearbyHazard[]>([]);
  const [hazardFeedStatus, setHazardFeedStatus] = useState<'available' | 'stale' | 'unavailable' | null>(null);
  const [hazardFeedMessage, setHazardFeedMessage] = useState<string | null>(null);
  const [activeModal, setActiveModal] = useState<'none' | 'report' | 'attire' | 'voice'>('none');
  const [activeIncident, setActiveIncident] = useState<any | null>(null);
  const [liveSafetyRisk, setLiveSafetyRisk] = useState<LiveSafetyRisk | null>(null);
  // Read after mount: the server cannot know the browser's notification state.
  const [notifyState, setNotifyState] = useState<NotificationPermission | 'unsupported'>('unsupported');
  const [geofences, setGeofences] = useState<any[]>([]);

  // Police-ready report drafts. Prahari does not submit these to any police
  // system or claim that an FIR has been registered.
  const [reports, setReports] = useState<any[]>([]);
  const [report, setReport] = useState<any | null>(null);
  const [reportForm, setReportForm] = useState(EMPTY_REPORT_FORM);
  const [reportSaving, setReportSaving] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);

  // The credentialed tourist this session belongs to, loaded from the API so
  // the traveller and authority views always agree on who is being tracked.
  const [tourist, setTourist] = useState<any | null>(null);
  const touristId: string | null = tourist?.touristId ?? null;
  const [offline, setOffline] = useState(false);

  const lastTelemetryRef = useRef<{ lat: number; lng: number; sentAt: number } | null>(null);
  const notifiedHazardIdsRef = useRef(new Set<string>());

  const setReportField = (field: keyof typeof EMPTY_REPORT_FORM, value: string | boolean) =>
    setReportForm((current) => ({ ...current, [field]: value }));

  // Load the authenticated identity, published geofences, and saved reports.
  useEffect(() => {
    if (typeof Notification !== 'undefined') setNotifyState(Notification.permission);
    let cancelled = false;
    const load = async () => {
      try {
        const [geofenceResponse, touristResponse, reportResponse] = await Promise.all([
          fetch('/api/geofences'),
          fetch('/api/tourists'),
          fetch('/api/efir'),
        ]);
        const [geofenceData, touristData, reportData] = await Promise.all([
          geofenceResponse.json().catch(() => null),
          touristResponse.json().catch(() => null),
          reportResponse.json().catch(() => null),
        ]);
        if (cancelled) return;

        if (!touristResponse.ok || !touristData?.tourist) {
          window.location.assign('/login?redirect=/citizen');
          return;
        }
        if (geofenceResponse.ok && geofenceData?.geofences) setGeofences(geofenceData.geofences);
        if (reportResponse.ok && reportData?.efirs) setReports(reportData.efirs);
        setTourist(touristData.tourist);
        setOffline(false);
        try { localStorage.setItem(SAVED_PROFILE_KEY, JSON.stringify(touristData.tourist)); } catch {}
        if (typeof touristData.tourist.trackingConsent === 'boolean') setLocationConsent(touristData.tourist.trackingConsent);
      } catch {
        if (cancelled) return;
        // No connection: open with the saved profile so an SOS can still be queued.
        const saved = readSavedProfile();
        if (!saved) {
          window.location.assign('/login?redirect=/citizen');
          return;
        }
        setTourist(saved);
        setOffline(true);
      }
    };
    void load();
    window.addEventListener('online', load);
    return () => {
      cancelled = true;
      window.removeEventListener('online', load);
    };
  }, []);

  // Keep report review status current.
  useEffect(() => {
    if (!touristId) return;
    const refreshReports = () => {
      fetch('/api/efir')
        .then((res) => res.json())
        .then((data) => { if (data?.success && Array.isArray(data.efirs)) setReports(data.efirs); })
        .catch(() => null);
    };
    const intervalId = window.setInterval(refreshReports, 15_000);
    return () => window.clearInterval(intervalId);
  }, [touristId]);

  // Start tracking only after the tourist identity is known, so the first GPS
  // fix is never discarded.
  useEffect(() => {
    if (!locationConsent) {
      setCoords(null);
      setLiveSafetyRisk(null);
      return;
    }
    if (!touristId) return;
    if (!navigator.geolocation) {
      setLocationError('This browser does not support location sharing.');
      return;
    }

    const remember = (lat: number, lng: number) => {
      setCoords({ lat, lng });
      try { localStorage.setItem('prahari_last_known_coords', JSON.stringify({ lat, lng })); } catch {}
    };

    setLocationError(null);
    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        remember(lat, lng);

        // Send at most every 15 seconds unless the traveller moved ~25 m.
        const last = lastTelemetryRef.current;
        const movedEnough = !last || Math.hypot(lat - last.lat, lng - last.lng) > 0.00023;
        const due = !last || Date.now() - last.sentAt >= 15_000;
        if (!movedEnough && !due) return;

        lastTelemetryRef.current = { lat, lng, sentAt: Date.now() };
        fetch('/api/locations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ touristId, lat, lng, accuracy: pos.coords.accuracy, speed: pos.coords.speed, source: 'gps' }),
        })
          .then(async (response) => ({ ok: response.ok, data: await response.json().catch(() => null) }))
          .then(({ ok, data }) => {
            if (!ok) {
              setLocationError(data?.error || 'Your location could not be saved.');
              return;
            }
            setLocationError(null);
            if (data.hazards) {
              const hazards: NearbyHazard[] = Array.isArray(data.hazards.alerts) ? data.hazards.alerts : [];
              setNearbyHazards(hazards);
              setHazardFeedStatus(data.hazards.status || 'unavailable');
              setHazardFeedMessage(data.hazards.error || null);

              const newHazard = hazards.find((hazard) => !notifiedHazardIdsRef.current.has(hazard.id));
              hazards.forEach((hazard) => notifiedHazardIdsRef.current.add(hazard.id));
              if (newHazard && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
                new Notification(`Prahari: ${newHazard.hazard}`, {
                  body: `${newHazard.severity} advisory for ${newHazard.areaDescription}.`,
                  tag: `prahari-hazard-${newHazard.id}`,
                });
              }
            }
            if (!data?.safety) return;
            setLiveSafetyRisk({ score: data.safety.score, level: data.safety.level, signals: data.safety.signals });
            if (data.breach) {
              setSafetyAlert(`You entered ${data.breach.zone}. Incident ${data.breach.incidentId} was sent to the authority desk for review.`);
            } else if (data.safetyReview) {
              setSafetyAlert(`Your safety signals need a human review. Incident ${data.safetyReview.incidentId} was sent to the authority desk.`);
            }
          })
          .catch(() => setLocationError('Your location could not be sent. Check your connection.'));
      },
      (error) => {
        if (error.code === error.PERMISSION_DENIED) {
          setLocationError('Location access is blocked in your browser settings.');
          return;
        }
        navigator.geolocation.getCurrentPosition(
          (p) => { remember(p.coords.latitude, p.coords.longitude); setLocationError(null); },
          () => setLocationError('GPS signal is weak or unavailable.'),
          { enableHighAccuracy: false, timeout: 5000 }
        );
      },
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 10_000 }
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, [locationConsent, touristId]);

  const mapGeofences = geofences.map((g) => ({
    id: g.id || g.name,
    name: g.name,
    severity: g.severity ?? 'high',
    coordinates: g.coordinates || g.geometry?.coordinates?.[0]?.map(([lng, lat]: [number, number]) => [lat, lng]) || [],
  }));

  const toggleLocationConsent = async () => {
    if (!touristId) return;
    const nextConsent = !locationConsent;
    setLocationError(null);
    try {
      const response = await fetch('/api/tourists', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ touristId, trackingConsent: nextConsent }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.success) throw new Error(data?.error || 'Your preference could not be saved.');
      setLocationConsent(nextConsent);
      setSafetyAlert(nextConsent ? null : 'Location sharing is paused. Nothing new is sent until you turn it back on.');
    } catch (error: any) {
      setLocationError(error.message);
    }
  };

  const enableHazardNotifications = async () => {
    if (typeof Notification === 'undefined') return;
    setNotifyState(await Notification.requestPermission());
  };

  const saveReport = async () => {
    if (!touristId || !coords) {
      setReportError('Your current location is needed to prepare a report. Turn on location sharing and try again.');
      return;
    }
    try {
      setReportSaving(true);
      setReportError(null);
      const res = await fetch('/api/efir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          incidentId: activeIncident?.incidentId,
          touristId,
          touristName: tourist?.name,
          passportAadhaar: tourist?.credential?.credentialSubject?.identityDocument?.masked,
          incidentType: activeIncident?.type || 'Incident information',
          reportType: reportForm.category === 'Missing person concern' ? 'MISSING_PERSON_INFORMATION_DRAFT' : 'INCIDENT_INFORMATION_DRAFT',
          incidentCategory: reportForm.category,
          occurrenceAt: reportForm.occurrenceAt || null,
          narrative: reportForm.narrative,
          suspectDescription: reportForm.suspectDescription,
          witnesses: reportForm.witnessName ? [{ name: reportForm.witnessName, contact: reportForm.witnessContact }] : [],
          stolenItems: reportForm.stolenItems.split('\n').map((item) => item.trim()).filter(Boolean),
          injuries: reportForm.injuries,
          evidence: reportForm.evidenceReference ? [{ type: 'reference', reference: reportForm.evidenceReference }] : [],
          callbackNumber: reportForm.callbackNumber,
          declarationAccepted: reportForm.declarationAccepted,
          location: { ...coords },
          clothingProfile: tourist?.clothingProfile?.summary || undefined,
        }),
      });
      const data = await res.json();
      if (!data.success || !data.efir) throw new Error(data.error || 'The report could not be saved.');
      setReport(data.efir);
      setReports((current) => [data.efir, ...current.filter((item) => item.efirId !== data.efir.efirId)]);
      setReportForm(EMPTY_REPORT_FORM);
    } catch (err: any) {
      setReportError(err.message || 'The report could not be saved. Check your connection and try again.');
    } finally {
      setReportSaving(false);
    }
  };

  const openReportForm = () => {
    setReport(null);
    setReportError(null);
    setActiveModal('report');
  };

  const risk = liveSafetyRisk ? RISK_STYLES[liveSafetyRisk.level] : null;

  return (
    <div className="minimal-page pb-12">
      <header className="minimal-nav">
        <span className="minimal-brand">Prahari</span>
        <button
          onClick={async () => {
            try { localStorage.removeItem(SAVED_PROFILE_KEY); } catch {}
            await fetch('/api/auth/logout', { method: 'POST' });
            window.location.href = '/login';
          }}
          className="minimal-button minimal-button-secondary"
        >
          <LogOut className="size-4" /> Sign out
        </button>
      </header>

      <main className="mx-auto max-w-5xl space-y-5 px-5 pt-8 sm:px-8">
        {offline && (
          <p role="status" className="rounded-xl border border-line bg-surface-2 px-4 py-3 text-sm">
            You&apos;re offline. An SOS will be saved on this phone and sent as soon as you reconnect. For immediate help, call 112.
          </p>
        )}
        <div className="grid gap-5 lg:grid-cols-3">
          <section className="minimal-card lg:col-span-2">
            <p className="text-xs font-medium text-ink-soft">{tourist ? `Digital ID · ${tourist.touristId}` : 'Loading your ID…'}</p>
            <h1 className="ui-display mt-2 text-3xl">{tourist ? `${greetingForNow()}, ${tourist.name}` : 'Welcome'}</h1>
            <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4 text-sm text-ink-soft">
              <span className="flex items-center gap-2">
                <MapPin className="size-4" />
                {coords ? `${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)}` : locationConsent ? 'Waiting for your location' : 'Location sharing is off'}
              </span>
              <button
                onClick={toggleLocationConsent}
                disabled={!touristId}
                className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition ${
                  locationConsent ? 'border-emerald-600/25 bg-emerald-50 text-emerald-800' : 'border-line bg-surface-2 text-ink-soft'
                }`}
              >
                Location sharing: {locationConsent ? 'On' : 'Off'}
              </button>
            </div>
            {locationError && <p role="alert" className="mt-3 text-sm text-danger">{locationError}</p>}
            {safetyAlert && <p role="status" className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm">{safetyAlert}</p>}
          </section>

          <section className="minimal-card flex flex-col">
            <p className="text-xs font-medium text-ink-soft">Safety status</p>
            <p className="mt-3 text-4xl font-semibold tracking-tight">
              {liveSafetyRisk?.score ?? '—'}<span className="ml-1 text-sm font-normal text-ink-soft">/ 100</span>
            </p>
            {risk && <span className={`mt-2 w-fit rounded-full border px-2.5 py-0.5 text-xs font-semibold ${risk.className}`}>{risk.label} risk</span>}
            <p className="mt-auto pt-4 text-sm leading-6 text-ink-soft">
              {liveSafetyRisk
                ? liveSafetyRisk.signals?.[0]?.message ?? 'Nothing flagged at your location right now.'
                : coords ? 'Assessing your latest location…' : 'Share your location to get a safety assessment.'}
            </p>
          </section>
        </div>

        <SosButton
          touristPos={coords ?? undefined}
          touristId={touristId ?? undefined}
          activeSos={activeIncident}
          onActiveSosChange={setActiveIncident}
        />

        <section className="minimal-card" aria-live="polite">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="font-semibold">Official hazard alerts</h2>
              <p className="mt-1 text-sm text-ink-soft">NDMA SACHET advisories near your shared location.</p>
            </div>
            {notifyState === 'default' && (
              <button onClick={enableHazardNotifications} className="minimal-button minimal-button-secondary text-xs">
                Notify me
              </button>
            )}
          </div>

          <div className="mt-4 text-sm">
            {hazardFeedStatus === 'unavailable' ? (
              <p className="text-ink-soft">{hazardFeedMessage || 'The alert feed is unavailable right now.'}</p>
            ) : nearbyHazards.length ? (
              <div className="space-y-3">
                {nearbyHazards.slice(0, 3).map((hazard) => (
                  <article key={hazard.id} className="rounded-xl border border-amber-200 bg-amber-50/70 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <strong className="flex items-center gap-2 text-amber-950"><AlertTriangle className="size-4" />{hazard.hazard}</strong>
                      <span className="rounded-md bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900">{hazard.severity}</span>
                    </div>
                    <p className="mt-2 leading-6 text-amber-950">{hazard.message}</p>
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-amber-900/80">
                      <span>{hazard.areaDescription}{typeof hazard.distanceKm === 'number' ? ` · ${hazard.distanceKm.toFixed(1)} km away` : ''}</span>
                      <a href={hazard.officialUrl} target="_blank" rel="noreferrer" className="font-semibold underline">Official guidance</a>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <p className="text-ink-soft">{coords ? 'No active advisories near you.' : 'Alerts appear once your location is shared.'}</p>
            )}
            {hazardFeedStatus === 'stale' && hazardFeedMessage && <p className="mt-2 text-xs text-warning">{hazardFeedMessage}</p>}
          </div>
        </section>

        <div className="grid gap-4 sm:grid-cols-3">
          {([
            { key: 'report', icon: FileText, title: 'Prepare a report', body: 'Write down what happened for authorised review.', onClick: openReportForm },
            { key: 'attire', icon: Shirt, title: 'Identification profile', body: 'Describe what you are wearing, in case responders need to find you.', onClick: () => setActiveModal('attire') },
            { key: 'voice', icon: Mic, title: 'Voice help', body: 'Speak in your language, translate, or send a voice SOS.', onClick: () => setActiveModal('voice') },
          ] as const).map(({ key, icon: Icon, title, body, onClick }) => (
            <button key={key} onClick={onClick} className="minimal-card minimal-card-link p-5 text-left">
              <Icon className="size-5 text-ink-soft" />
              <span className="mt-3 block font-semibold">{title}</span>
              <span className="mt-1 block text-sm leading-5 text-ink-soft">{body}</span>
            </button>
          ))}
        </div>

        <DigitalIdCard tourist={tourist} />

        <section className="minimal-card space-y-4">
          <div>
            <h2 className="font-semibold">Map</h2>
            <p className="mt-1 text-sm text-ink-soft">Your location, published risk zones, and any active SOS.</p>
          </div>
          <MapView
            touristPos={coords}
            geofences={mapGeofences}
            incidents={activeIncident?.location ? [{
              id: activeIncident.incidentId,
              incidentId: activeIncident.incidentId,
              type: activeIncident.type,
              lat: activeIncident.location.lat,
              lng: activeIncident.location.lng,
              severity: activeIncident.severity,
            }] : []}
          />
        </section>

        <section className="minimal-card" aria-labelledby="reports-title">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="reports-title" className="font-semibold">Your reports</h2>
            <span className="text-sm text-ink-soft">{reports.length} saved</span>
          </div>
          {reports.length === 0 ? (
            <p className="mt-3 text-sm text-ink-soft">Nothing yet. Reports you prepare are reviewed by authorised staff; they are not police filings.</p>
          ) : (
            <ul className="mt-3 divide-y divide-line">
              {reports.map((item) => {
                const reviewed = item.status === 'DRAFT_REVIEWED' || item.policeVerification === 'AUTHORISED_REVIEWED';
                return (
                  <li key={item.efirId ?? item._incidentId} className="flex flex-wrap items-center justify-between gap-3 py-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{item.incidentCategory ?? item.incidentType}</p>
                      <p className="mt-0.5 text-xs text-ink-soft">
                        <span className="font-mono">{item.efirId}</span> · {new Date(item.createdAt ?? Date.now()).toLocaleString()}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${reviewed ? 'bg-emerald-50 text-emerald-800' : 'bg-amber-50 text-amber-900'}`}>
                        {reviewed ? 'Reviewed' : 'Awaiting review'}
                      </span>
                      <button
                        type="button"
                        onClick={() => { setReport(item); setActiveModal('report'); }}
                        className="minimal-button minimal-button-secondary text-xs"
                      >
                        View
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <OfflineMapPackStatus />

        <p className="text-center text-sm text-ink-soft">
          Emergency <a href="tel:112" className="font-semibold text-ink">112</a> · Tourist helpline <a href="tel:1363" className="font-semibold text-ink">1363</a>
        </p>
      </main>

      {activeModal === 'report' && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="report-title">
          <div className="modal-frame">
            <div className="modal-panel max-w-lg space-y-5">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 id="report-title" className="ui-display text-2xl">Incident report</h2>
                  <p className="mt-1 text-sm text-ink-soft">A draft for authorised review. It is not an FIR or a police acknowledgement.</p>
                </div>
                <button onClick={() => setActiveModal('none')} className="minimal-button minimal-button-secondary px-2.5" aria-label="Close">
                  <X className="size-4" />
                </button>
              </div>

              {reportError && <p role="alert" className="rounded-lg border border-danger/30 bg-danger/5 p-3 text-sm text-danger">{reportError}</p>}

              {report ? (
                <div className="space-y-4">
                  <dl className="grid gap-2 rounded-xl border border-line bg-surface-2 p-4 text-sm">
                    {[
                      ['Reference', report.efirId],
                      ['Name', report.touristName],
                      ['ID reference', report.passportAadhaar],
                      ['Category', report.incidentCategory ?? report.incidentType],
                      ['Location', report.location ? `${report.location.lat?.toFixed(4)}, ${report.location.lng?.toFixed(4)}` : null],
                      ['Review', report.policeVerification],
                      ['Saved', report.createdAt ? new Date(report.createdAt).toLocaleString() : null],
                    ].filter(([, value]) => value).map(([label, value]) => (
                      <div key={label} className="flex justify-between gap-4">
                        <dt className="text-ink-soft">{label}</dt>
                        <dd className="text-right font-medium">{value}</dd>
                      </div>
                    ))}
                  </dl>
                  <p className="whitespace-pre-wrap text-sm leading-6">{report.narrative}</p>
                  <p className="text-xs leading-5 text-ink-soft">
                    To lodge a complaint, use your State/UT police process. This draft is a record you can share with them.
                  </p>
                  <button onClick={() => setActiveModal('none')} className="minimal-button minimal-button-secondary w-full">Close</button>
                </div>
              ) : (
                <form className="space-y-4 text-sm" onSubmit={(event) => { event.preventDefault(); void saveReport(); }}>
                  <div className="grid grid-cols-2 gap-3">
                    <label className="space-y-1.5"><span className="font-medium">Category</span>
                      <select value={reportForm.category} onChange={(e) => setReportField('category', e.target.value)} className="nb-input">
                        <option>Emergency / personal safety</option><option>Theft or lost property</option><option>Harassment or assault</option><option>Missing person concern</option><option>Other</option>
                      </select>
                    </label>
                    <label className="space-y-1.5"><span className="font-medium">When</span>
                      <input type="datetime-local" value={reportForm.occurrenceAt} onChange={(e) => setReportField('occurrenceAt', e.target.value)} className="nb-input" />
                    </label>
                  </div>
                  <label className="block space-y-1.5"><span className="font-medium">What happened? <span className="text-danger">*</span></span>
                    <textarea required minLength={20} rows={4} value={reportForm.narrative} onChange={(e) => setReportField('narrative', e.target.value)} placeholder="Who, what, when, and what help you need." className="nb-input" />
                  </label>
                  <label className="block space-y-1.5"><span className="font-medium">Description of anyone involved</span>
                    <input value={reportForm.suspectDescription} onChange={(e) => setReportField('suspectDescription', e.target.value)} placeholder="Appearance, vehicle, direction of travel" className="nb-input" />
                  </label>
                  <div className="grid grid-cols-2 gap-3">
                    <label className="space-y-1.5"><span className="font-medium">Witness name</span><input value={reportForm.witnessName} onChange={(e) => setReportField('witnessName', e.target.value)} className="nb-input" /></label>
                    <label className="space-y-1.5"><span className="font-medium">Witness contact</span><input value={reportForm.witnessContact} onChange={(e) => setReportField('witnessContact', e.target.value)} className="nb-input" /></label>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <label className="space-y-1.5"><span className="font-medium">Injuries</span><input value={reportForm.injuries} onChange={(e) => setReportField('injuries', e.target.value)} className="nb-input" /></label>
                    <label className="space-y-1.5"><span className="font-medium">Callback number</span><input type="tel" value={reportForm.callbackNumber} onChange={(e) => setReportField('callbackNumber', e.target.value)} className="nb-input" /></label>
                  </div>
                  <label className="block space-y-1.5"><span className="font-medium">Lost or stolen items (one per line)</span><textarea rows={2} value={reportForm.stolenItems} onChange={(e) => setReportField('stolenItems', e.target.value)} className="nb-input" /></label>
                  <label className="block space-y-1.5"><span className="font-medium">Evidence reference</span><input value={reportForm.evidenceReference} onChange={(e) => setReportField('evidenceReference', e.target.value)} placeholder="Photo, CCTV location, document number" className="nb-input" /></label>
                  <label className="flex items-start gap-2 text-ink-soft">
                    <input required type="checkbox" checked={reportForm.declarationAccepted} onChange={(e) => setReportField('declarationAccepted', e.target.checked)} className="mt-1" />
                    <span>These facts are true to the best of my knowledge.</span>
                  </label>
                  <button type="submit" disabled={reportSaving} className="minimal-button minimal-button-primary w-full">
                    {reportSaving && <Loader2 className="size-4 animate-spin" />} Save report
                  </button>
                </form>
              )}
            </div>
          </div>
        </div>
      )}

      {activeModal === 'attire' && (
        <EmergencyIdentificationProfile
          touristId={touristId}
          profile={tourist?.clothingProfile}
          onClose={() => setActiveModal('none')}
          onSaved={(profile) => setTourist((current: any) => current ? { ...current, clothingProfile: profile } : current)}
        />
      )}

      {activeModal === 'voice' && (
        <TravellerVoiceAssistant
          touristId={touristId}
          coords={coords}
          preferredLanguage={tourist?.preferences?.language}
          onClose={() => setActiveModal('none')}
          onVoiceSos={setActiveIncident}
          onUseInReport={(text) => {
            setReport(null);
            setReportForm((current) => ({ ...current, narrative: text }));
            setActiveModal('report');
          }}
        />
      )}
    </div>
  );
}
