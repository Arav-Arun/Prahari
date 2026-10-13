'use client';

import dynamic from 'next/dynamic';
import { LocateFixed } from 'lucide-react';
import type { OfflineMapSelection } from '@/lib/offlineMap';

const OfflineLocationPickerMap = dynamic(() => import('./OfflineLocationPickerMap'), { ssr: false });

type Props = {
  value: OfflineMapSelection | null;
  onChange: (selection: OfflineMapSelection | null) => void;
};

const DEFAULT_RADIUS_KM = 10;

export default function OfflineAreaSetup({ value, onChange }: Props) {
  const setCoordinates = (lat: number, lng: number, label?: string) => {
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return;
    onChange({ lat, lng, radiusKm: value?.radiusKm ?? DEFAULT_RADIUS_KM, label: label ?? value?.label ?? 'Selected area' });
  };
  const useCurrentLocation = () => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (position) => setCoordinates(position.coords.latitude, position.coords.longitude, 'Current location'),
      () => undefined,
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 },
    );
  };

  return (
    <section className="rounded-nb border border-line bg-surface p-4" aria-labelledby="offline-map-heading">
      <h2 id="offline-map-heading" className="font-bold text-ink">Offline safety pack <span className="font-normal text-ink-soft">(optional)</span></h2>
      <p className="mt-1 text-xs leading-5 text-ink-soft">Pick an area. After your ID is issued you can download nearby services, helplines and safety guidance for use without a connection.</p>

      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" onClick={useCurrentLocation} className="minimal-button minimal-button-secondary px-3 py-2 text-xs">
          <LocateFixed size={15} /> Use my current location
        </button>
        {value && <button type="button" onClick={() => onChange(null)} className="px-3 py-2 text-xs font-semibold text-ink-soft underline">Remove selected area</button>}
      </div>

      <OfflineLocationPickerMap value={value ? { lat: value.lat, lng: value.lng } : null} onPick={({ lat, lng }) => setCoordinates(lat, lng, 'Custom selected area')} />
      <p className="mt-1.5 text-xs text-ink-soft">Tap the map to choose a point. This does not turn on location tracking.</p>

      <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_8rem_8rem]">
        <input
          value={value?.label ?? ''}
          onChange={(event) => value && onChange({ ...value, label: event.target.value.slice(0, 100) })}
          disabled={!value}
          placeholder="Area name, e.g. Kedarnath route"
          className="nb-input text-sm disabled:cursor-not-allowed disabled:opacity-50"
        />
        <label className="text-xs font-semibold text-ink-soft">Latitude
          <input type="number" step="any" value={value?.lat ?? ''} onChange={(event) => setCoordinates(event.target.value === '' ? NaN : Number(event.target.value), value?.lng ?? NaN)} placeholder="30.73" className="nb-input mt-1 text-sm font-normal" />
        </label>
        <label className="text-xs font-semibold text-ink-soft">Longitude
          <input type="number" step="any" value={value?.lng ?? ''} onChange={(event) => setCoordinates(value?.lat ?? NaN, event.target.value === '' ? NaN : Number(event.target.value))} placeholder="79.07" className="nb-input mt-1 text-sm font-normal" />
        </label>
      </div>
      <label className="mt-3 block text-xs font-semibold text-ink-soft">Coverage radius: <span className="text-ink">{value?.radiusKm ?? DEFAULT_RADIUS_KM} km</span>
        <input type="range" min="2" max="25" step="1" value={value?.radiusKm ?? DEFAULT_RADIUS_KM} disabled={!value}
          onChange={(event) => value && onChange({ ...value, radiusKm: Number(event.target.value) })}
          className="mt-1.5 block w-full accent-accent disabled:opacity-50" />
      </label>
    </section>
  );
}
