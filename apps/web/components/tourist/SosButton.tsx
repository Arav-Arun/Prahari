'use client';

import { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { Siren, CheckCircle2, Loader2, Radio, XCircle } from 'lucide-react';
import OfflineEmergencyChat from '@/components/tourist/OfflineEmergencyChat';

// WebRTC pairing code is only needed by travellers who open the panel, so it
// stays out of the main SOS bundle.
const PeerMeshConnect = dynamic(() => import('@/components/tourist/PeerMeshConnect'), { ssr: false });

interface SosButtonProps {
  touristPos?: { lat: number; lng: number };
  touristId?: string;
  /** The traveller's open SOS, owned by the dashboard so a voice SOS shows here too. */
  activeSos: any | null;
  onActiveSosChange: (incident: any | null) => void;
}

// Geofence and safety-signal incidents are raised automatically; anything else
// for this traveller is an SOS they sent.
const AUTOMATIC_INCIDENT_TYPES = new Set(['GEOFENCE_BREACH', 'SAFETY_SIGNAL']);
const isClosed = (status: unknown) => ['RESOLVED', 'CANCELLED'].includes(String(status ?? '').toUpperCase());
/** True once the incident is recorded on the server, not just queued or relayed. */
const isDelivered = (incident: any) => Boolean(incident?.delivered ?? incident?.transportType === 'INTERNET');

export default function SosButton({ touristPos, touristId, activeSos, onActiveSosChange }: SosButtonProps) {
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bleStatus, setBleStatus] = useState({ supported: false, paired: false, gatewayName: null as string | null });
  const [pairingBle, setPairingBle] = useState(false);
  const [bleError, setBleError] = useState<string | null>(null);

  const canDispatch = Boolean(touristId);

  // Publish this device's mesh public key against the traveller's record. This
  // is what later lets a stranger's phone relay their SOS: the gateway trusts
  // the origin signature, and this is how it learns which keys count. The
  // secret half never leaves this browser.
  useEffect(() => {
    if (!touristId) return;
    let abandoned = false;

    void (async () => {
      try {
        const { getDevicePubkey } = await import('@/lib/sos-mesh/nostrKeys');
        const pubkey = getDevicePubkey();
        if (!pubkey || abandoned) return;
        await fetch('/api/identity/mesh-key', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ touristId, pubkey }),
        });
      } catch {
        // An enhancement, not a dependency. Direct delivery and the local retry
        // queue work whether or not this registration succeeds.
      }
    })();

    return () => { abandoned = true; };
  }, [touristId]);

  // Follow the open SOS on the server: restores it after a reload and shows the
  // desk's assignment and resolution as they happen.
  const activeSosRef = useRef(activeSos);
  useEffect(() => { activeSosRef.current = activeSos; }, [activeSos]);
  useEffect(() => {
    if (!touristId) return;
    let stopped = false;
    const sync = async () => {
      try {
        const data = await fetch('/api/incidents', { cache: 'no-store' }).then((res) => res.json());
        if (stopped || !data.success || !Array.isArray(data.incidents)) return;
        const current = activeSosRef.current;
        if (current) {
          const record = data.incidents.find((incident: any) => incident.incidentId === current.incidentId);
          if (!record) return; // Still queued on this device or with a relay.
          if (isClosed(record.status)) {
            onActiveSosChange(null);
            setNotice(String(record.status).toUpperCase() === 'RESOLVED'
              ? 'The authority desk marked your SOS as resolved.'
              : 'Your SOS was cancelled.');
            return;
          }
          onActiveSosChange({ ...current, ...record, delivered: true });
          return;
        }
        const open = data.incidents
          .filter((incident: any) => !AUTOMATIC_INCIDENT_TYPES.has(incident.type) && !isClosed(incident.status))
          .sort((a: any, b: any) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
        if (open) onActiveSosChange({ ...open, delivered: true });
      } catch {
        // Offline: keep showing the last known state.
      }
    };
    void sync();
    const intervalId = window.setInterval(sync, 10_000);
    return () => { stopped = true; window.clearInterval(intervalId); };
  }, [touristId, onActiveSosChange]);

  // An SOS saved on this device while offline survives a reload: show it, and
  // send it now (and whenever the connection returns).
  useEffect(() => {
    if (!touristId) return;
    void (async () => {
      const [{ getPendingQueuedPackets }, { globalTransportManager }] = await Promise.all([
        import('@/lib/sos-mesh/indexedDbQueue'),
        import('@/lib/sos-mesh/transports/transportManager'),
      ]);
      const queued = (await getPendingQueuedPackets())
        .find((record) => record.packet.touristId === touristId && record.packet.packetCategory !== 'CHAT_MESSAGE');
      if (queued && !activeSosRef.current) {
        const { packet } = queued;
        onActiveSosChange({
          incidentId: packet.incidentId,
          touristId: packet.touristId,
          type: packet.type,
          severity: packet.severity,
          status: 'PENDING_LOCAL_DELIVERY',
          location: { lat: packet.latitude, lng: packet.longitude },
          transportType: 'LOCAL_QUEUE',
          packetId: packet.packetId,
          delivered: false,
        });
      }
      await globalTransportManager.flushQueuedPackets();
    })().catch(() => undefined);
  }, [touristId, onActiveSosChange]);

  // Zero-touch offline mesh listener: listens for nearby offline SOS broadcasts
  // and auto-relays them to Police HQ if this device is online.
  useEffect(() => {
    let cleanup: (() => void) | null = null;
    void (async () => {
      const { startMeshBroadcastListener } = await import('@/lib/sos-mesh/transports/broadcastMeshTransport');
      cleanup = startMeshBroadcastListener();
    })();
    return () => cleanup?.();
  }, []);

  const setUpOptionalBleGateway = async () => {
    try {
      setPairingBle(true);
      setBleError(null);
      const { globalBleTransport } = await import('@/lib/sos-mesh/transports/bleTransport');
      const knownGateway = await globalBleTransport.reconnectKnownGateway();
      setBleStatus(knownGateway.paired ? knownGateway : await globalBleTransport.pairGateway());
    } catch (cause: any) {
      setBleError(cause.message || 'Could not set up the optional BLE relay gateway.');
    } finally {
      setPairingBle(false);
    }
  };

  const handleSosClick = async () => {
    try {
      setLoading(true);
      setError(null);
      setNotice(null);

      if (!touristId) {
        throw new Error('Complete identity verification before sending an SOS.');
      }
      const effectiveTouristId = touristId;

      // Resolve a real current position. Never substitute a demo or regional
      // coordinate for an emergency report.
      let finalLat = touristPos?.lat;
      let finalLng = touristPos?.lng;

      if (typeof finalLat !== 'number' || typeof finalLng !== 'number') {
        if (typeof navigator !== 'undefined' && navigator.geolocation) {
          try {
            const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
              navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 4000, enableHighAccuracy: false });
            });
            finalLat = pos.coords.latitude;
            finalLng = pos.coords.longitude;
          } catch {}
        }
      }

      if (typeof finalLat !== 'number' || typeof finalLng !== 'number') {
        throw new Error('A current location is required to send an SOS. Enable location sharing, then try again. If you are in immediate danger, call 112.');
      }

      // Import the local-queue-capable delivery transport dynamically.
      const { createSOSPacket } = await import('@/lib/sos-mesh/sosPacket');
      const { globalTransportManager } = await import('@/lib/sos-mesh/transports/transportManager');

      const packet = createSOSPacket({
        touristId: effectiveTouristId,
        latitude: finalLat,
        longitude: finalLng,
        type: 'PANIC',
        severity: 'CRITICAL',
      });

      // Wi-Fi/internet is always the direct first path. BLE is consulted only
      // after a traveller has deliberately paired an optional relay gateway.
      const result = await globalTransportManager.dispatch(packet, { allowBleRelay: bleStatus.paired });

      if (!result.success) {
        throw new Error(result.error || 'The emergency alert could not be sent. Please try again.');
      }

      const activeRecord = result.incidentRecord || {
        incidentId: packet.incidentId,
        touristId: packet.touristId,
        type: 'PANIC',
        severity: 'CRITICAL',
        status: result.channel === 'LOCAL_QUEUE' ? 'PENDING_LOCAL_DELIVERY' : 'PENDING_RELAY_DELIVERY',
        location: { lat: finalLat, lng: finalLng },
        transportType: result.channel,
        hopCount: packet.hopCount,
        packetId: packet.packetId,
        assignedResponderUnitId: null,
        etaMinutes: null,
      };

      onActiveSosChange({ ...activeRecord, delivered: result.channel === 'INTERNET' });
    } catch (err: any) {
      console.error('Error triggering SOS:', err);
      setError(err.message || 'The emergency alert could not be sent. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const cancelSos = async () => {
    if (!activeSos || loading) return;
    const wasDelivered = isDelivered(activeSos);
    const confirmed = window.confirm(wasDelivered
      ? 'Cancel this emergency alert? Authorities will be told this was cancelled.'
      : 'Discard this locally queued SOS? It has not yet reached the authority queue.');
    if (!confirmed) return;
    try {
      setLoading(true);
      if (!wasDelivered) {
        const { removeQueuedPacket } = await import('@/lib/sos-mesh/indexedDbQueue');
        if (activeSos.packetId) await removeQueuedPacket(activeSos.packetId);
        onActiveSosChange(null);
        setNotice('Alert discarded. Send a new SOS if you still need help.');
        return;
      }
      const res = await fetch('/api/incidents', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ incidentId: activeSos.incidentId, status: 'CANCELLED' }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Could not cancel the alert.');
      onActiveSosChange(null);
      setNotice('Alert cancelled. Send a new SOS if you still need help.');
    } catch (error: any) {
      window.alert(error.message || 'Could not cancel the emergency alert.');
    } finally { setLoading(false); }
  };

  const pendingLabel: Record<string, string> = {
    PEER_MESH: 'SOS handed to a nearby device — waiting for it to reach the desk',
    BLE_RELAY: 'SOS accepted by a relay gateway — waiting for it to reach the desk',
    LOCAL_QUEUE: 'No connection — SOS saved on this device and will retry automatically',
  };
  const responder = activeSos?.assignedResponderName || activeSos?.assignedResponderUnitId;
  const delivered = isDelivered(activeSos);
  const headline = !delivered
    ? pendingLabel[activeSos?.transportType] ?? pendingLabel.LOCAL_QUEUE
    : responder ? 'Help is on the way' : 'The authority desk has your SOS';

  return (
    <section className="minimal-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold"><Siren className="size-5 text-danger" /> Emergency SOS</h2>
          <p className="mt-1 max-w-xl text-sm leading-6 text-ink-soft">
            Sends your location to the authority desk. Without internet, the alert is saved on this device and retried when you reconnect.
          </p>
        </div>
        <a href="tel:112" className="minimal-button minimal-button-secondary">Call 112</a>
      </div>

      {error && <p role="alert" className="mt-4 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2.5 text-sm text-danger">{error}</p>}

      {activeSos ? (
        <div className="mt-5 rounded-xl border border-line bg-surface-2 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="flex items-center gap-2 text-sm font-semibold">
              <CheckCircle2 className="size-5 text-success" />
              {headline}
            </span>
            <span className="font-mono text-xs text-ink-soft">{activeSos.incidentId}</span>
          </div>
          <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
            {[
              ['Responder', responder || 'Not assigned yet'],
              ['Arrival', activeSos.etaMinutes != null ? `~${activeSos.etaMinutes} min` : 'Not available'],
              ['Location', typeof activeSos.location?.lat === 'number' ? `${activeSos.location.lat.toFixed(4)}, ${activeSos.location.lng.toFixed(4)}` : 'Not available'],
            ].map(([label, value]) => (
              <div key={label} className="rounded-lg border border-line bg-surface p-3">
                <dt className="text-xs text-ink-soft">{label}</dt>
                <dd className="mt-1 font-medium">{value}</dd>
              </div>
            ))}
          </dl>
          {activeSos.emergencyContactNotifications?.message && (
            <p className="mt-3 text-xs text-ink-soft">{activeSos.emergencyContactNotifications.message}</p>
          )}

          {delivered && (
            <div className="mt-4">
              <OfflineEmergencyChat
                incidentId={activeSos.incidentId}
                touristId={activeSos.touristId}
                latitude={activeSos.location?.lat}
                longitude={activeSos.location?.lng}
              />
            </div>
          )}
          {activeSos.transportType !== 'BLE_RELAY' && (
            <button onClick={cancelSos} disabled={loading} className="minimal-button minimal-button-secondary mt-4 w-full text-danger">
              <XCircle className="size-4" /> {loading ? 'Cancelling…' : 'Cancel — this was a false alarm'}
            </button>
          )}
          {activeSos.transportType === 'PEER_MESH' && (
            <p className="mt-2 text-center text-xs text-ink-soft">A nearby device already holds this alert and may still upload it.</p>
          )}
        </div>
      ) : (
        <div className="mt-5">
          {notice && <p className="mb-3 text-sm text-success">{notice}</p>}
          <button
            onClick={handleSosClick}
            disabled={loading || !canDispatch}
            className="minimal-button minimal-button-danger w-full py-4 text-base"
          >
            {loading ? <Loader2 className="size-5 animate-spin" /> : <Siren className="size-5" />}
            {loading ? 'Sending…' : 'Send SOS'}
          </button>
          {!canDispatch && <p className="mt-2 text-center text-xs text-ink-soft">Verify your identity before sending an SOS.</p>}
        </div>
      )}

      <details className="mt-5 rounded-lg border border-line px-4 py-3 text-sm">
        <summary className="cursor-pointer select-none font-medium">Offline options</summary>
        <div className="mt-3 space-y-4 border-t border-line pt-3 text-ink-soft">
          <div>
            <p className="font-medium text-ink">Pair a nearby phone</p>
            <p className="mt-1 leading-6">
              Link directly to another Prahari device over local Wi‑Fi or a hotspot. If you lose signal, your signed SOS is handed to it and uploaded as soon as it finds a network.
            </p>
            <div className="mt-3"><PeerMeshConnect /></div>
          </div>
          <div className="border-t border-line pt-4">
            <p className="font-medium text-ink">Bluetooth relay gateway</p>
            <p className="mt-1 leading-6">Only for a separately provisioned Prahari gateway. Not needed for normal use.</p>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button type="button" onClick={() => void setUpOptionalBleGateway()} disabled={pairingBle} className="minimal-button minimal-button-secondary text-xs">
                {pairingBle ? <Loader2 className="size-3.5 animate-spin" /> : <Radio className="size-3.5" />}
                {pairingBle ? 'Connecting…' : bleStatus.paired ? 'Reconnect gateway' : 'Pair gateway'}
              </button>
              <span className="text-xs">{bleStatus.paired ? `Paired${bleStatus.gatewayName ? `: ${bleStatus.gatewayName}` : ''}` : 'Not paired'}</span>
            </div>
            {bleError && <p role="alert" className="mt-2 text-xs text-danger">{bleError}</p>}
          </div>
        </div>
      </details>
    </section>
  );
}
