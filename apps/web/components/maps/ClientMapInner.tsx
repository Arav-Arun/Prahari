'use client';

import React, { useMemo } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Polygon, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { offlineTileConfiguration, readOfflineMapPack, type OfflineMapPack } from '@/lib/offlineMap';

type LatLng = [number, number];

interface ClientMapInnerProps {
  touristPos?: { lat: number; lng: number } | null;
  liveTourists?: Array<{ touristId: string; lat: number; lng: number; timestamp?: string }>;
  geofences?: Array<{ id: string; name: string; coordinates: LatLng[]; severity: string }>;
  incidents?: Array<{ id: string; incidentId: string; type: string; lat: number; lng: number; severity: string }>;
  responders?: Array<{ id: string; unitId: string; name: string; lat: number; lng: number; type: string }>;
}

const PLACE_STYLES: Record<string, { label: string; color: string; name: string }> = {
  hospital: { label: 'H', color: '#c8261d', name: 'Hospital' },
  police: { label: 'P', color: '#1d4ed8', name: 'Police' },
  fire_station: { label: 'F', color: '#c2410c', name: 'Fire station' },
  safety_zone: { label: 'S', color: '#15803d', name: 'Safe zone' },
  tourist: { label: 'T', color: '#6d28d9', name: 'Tourist place' },
};

const SEVERITY_COLORS: Record<string, string> = { critical: '#c8261d', high: '#ea580c', medium: '#d97706', low: '#15803d' };

function dotIcon(color: string, label = '', size = 22) {
  return new L.DivIcon({
    className: '',
    html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;color:#fff;font:700 11px system-ui,sans-serif">${label}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

function FitToData({ points }: { points: LatLng[] }) {
  const map = useMap();
  const key = JSON.stringify(points);

  React.useEffect(() => {
    if (points.length === 0) return;
    if (points.length === 1) map.setView(points[0], 14);
    else map.fitBounds(L.latLngBounds(points), { padding: [40, 40], maxZoom: 15 });
  }, [key, map, points]);

  return null;
}

/** Accepts either [lat, lng] or GeoJSON-style [lng, lat] rings and returns [lat, lng]. */
function normalizePolygonCoords(gf: any): LatLng[] {
  let raw = gf.coordinates || gf.geometry?.coordinates || [];
  if (!Array.isArray(raw) || raw.length === 0) return [];
  if (Array.isArray(raw[0]) && Array.isArray(raw[0][0])) raw = raw[0];
  return raw
    .filter((c: any) => Array.isArray(c) && typeof c[0] === 'number' && typeof c[1] === 'number')
    .map(([c0, c1]: LatLng) => (Math.abs(c0) <= 90 && Math.abs(c1) <= 180 ? [c0, c1] : [c1, c0]));
}

export default function ClientMapInner({
  touristPos = null,
  liveTourists = [],
  geofences = [],
  incidents = [],
  responders = [],
}: ClientMapInnerProps) {
  const [offlinePack, setOfflinePack] = React.useState<OfflineMapPack | null>(null);
  const mapTiles = offlineTileConfiguration();

  const icons = useMemo(() => ({
    tourist: dotIcon('#15803d', '', 18),
    incident: dotIcon('#c8261d', '!', 24),
    responder: dotIcon('#1d4ed8', 'R', 24),
    places: Object.fromEntries(Object.entries(PLACE_STYLES).map(([key, style]) => [key, dotIcon(style.color, style.label)])),
  }), []);

  React.useEffect(() => {
    const refresh = () => setOfflinePack(readOfflineMapPack());
    refresh();
    window.addEventListener('prahari:offline-map-pack-updated', refresh);
    return () => window.removeEventListener('prahari:offline-map-pack-updated', refresh);
  }, []);

  const places = useMemo(() => offlinePack?.places ?? [], [offlinePack]);
  const polygons = useMemo(
    () => geofences.map((gf) => ({ ...gf, coords: normalizePolygonCoords(gf) })).filter((gf) => gf.coords.length >= 3),
    [geofences],
  );

  const points: LatLng[] = useMemo(() => [
    ...(touristPos ? [[touristPos.lat, touristPos.lng] as LatLng] : []),
    ...liveTourists.map((t) => [t.lat, t.lng] as LatLng),
    ...incidents.map((i) => [i.lat, i.lng] as LatLng),
    ...responders.map((r) => [r.lat, r.lng] as LatLng),
    ...places.map((p) => [p.lat, p.lng] as LatLng),
    ...polygons.flatMap((g) => g.coords),
  ].filter(([lat, lng]) => Number.isFinite(lat) && Number.isFinite(lng)), [touristPos, liveTourists, incidents, responders, places, polygons]);

  if (points.length === 0) {
    return (
      <div className="flex h-[420px] w-full items-center justify-center rounded-xl border border-line bg-surface-2 px-6 text-center text-sm text-ink-soft">
        Nothing to show yet. The map fills in as locations, incidents and geofences are recorded.
      </div>
    );
  }

  const legend = [
    (touristPos || liveTourists.length > 0) && { color: '#15803d', label: touristPos ? 'You' : 'Traveller' },
    incidents.length > 0 && { color: '#c8261d', label: 'Incident' },
    responders.length > 0 && { color: '#1d4ed8', label: 'Responder' },
    polygons.length > 0 && { color: '#ea580c', label: 'Geofence' },
    ...Object.entries(PLACE_STYLES)
      .filter(([category]) => places.some((p) => p.category === category))
      .map(([, style]) => ({ color: style.color, label: style.name })),
  ].filter(Boolean) as Array<{ color: string; label: string }>;

  return (
    <div className="relative isolate h-[420px] w-full overflow-hidden rounded-xl border border-line">
      <MapContainer center={points[0]} zoom={14} scrollWheelZoom style={{ width: '100%', height: '100%' }}>
        <FitToData points={points} />
        <TileLayer
          attribution={mapTiles.template ? mapTiles.attribution : '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'}
          url={mapTiles.template || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'}
        />

        {polygons.map((gf) => {
          const color = SEVERITY_COLORS[String(gf.severity).toLowerCase()] ?? SEVERITY_COLORS.high;
          return (
            <Polygon key={gf.id || gf.name} positions={gf.coords} pathOptions={{ color, fillColor: color, fillOpacity: 0.2, weight: 2 }}>
              <Popup><strong>{gf.name}</strong><br />{String(gf.severity || 'high')} risk zone</Popup>
            </Polygon>
          );
        })}

        {touristPos && (
          <Marker position={[touristPos.lat, touristPos.lng]} icon={icons.tourist}>
            <Popup>Your location<br /><span className="font-mono">{touristPos.lat.toFixed(4)}, {touristPos.lng.toFixed(4)}</span></Popup>
          </Marker>
        )}

        {liveTourists.map((tourist) => (
          <Marker key={tourist.touristId} position={[tourist.lat, tourist.lng]} icon={icons.tourist}>
            <Popup>
              <strong className="font-mono">{tourist.touristId}</strong>
              {tourist.timestamp && <><br />Updated {new Date(tourist.timestamp).toLocaleTimeString()}</>}
            </Popup>
          </Marker>
        ))}

        {incidents.map((inc) => (
          <Marker key={inc.id} position={[inc.lat, inc.lng]} icon={icons.incident}>
            <Popup><strong className="font-mono">{inc.incidentId}</strong><br />{inc.type}</Popup>
          </Marker>
        ))}

        {responders.map((resp) => (
          <Marker key={resp.id} position={[resp.lat, resp.lng]} icon={icons.responder}>
            <Popup><strong>{resp.unitId}</strong><br />{resp.name}</Popup>
          </Marker>
        ))}

        {places.map((place) => (
          <Marker key={`place-${place.id}`} position={[place.lat, place.lng]} icon={icons.places[place.category] ?? icons.places.tourist}>
            <Popup>
              <strong>{place.name}</strong>
              <br />{PLACE_STYLES[place.category]?.name ?? place.category}
              {place.address && <><br />{place.address}</>}
              {place.phone && <><br /><a href={`tel:${place.phone}`}>Call {place.phone}</a></>}
            </Popup>
          </Marker>
        ))}
      </MapContainer>

      {legend.length > 0 && (
        <div className="absolute bottom-3 left-3 z-[1000] flex flex-wrap gap-3 rounded-lg border border-line bg-surface/95 px-3 py-2 text-xs text-ink">
          {legend.map((item) => (
            <span key={item.label} className="flex items-center gap-1.5">
              <span className="size-2.5 rounded-full" style={{ background: item.color }} />
              {item.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
