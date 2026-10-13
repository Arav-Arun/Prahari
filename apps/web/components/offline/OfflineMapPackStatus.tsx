'use client';

import { useEffect, useState } from 'react';
import { readOfflineMapPack, type OfflineMapPack } from '@/lib/offlineMap';

export default function OfflineMapPackStatus() {
  const [pack, setPack] = useState<OfflineMapPack | null>(null);

  useEffect(() => {
    const refresh = () => setPack(readOfflineMapPack());
    refresh();
    window.addEventListener('prahari:offline-map-pack-updated', refresh);
    return () => window.removeEventListener('prahari:offline-map-pack-updated', refresh);
  }, []);

  if (!pack) return null;
  const grouped = pack.places.reduce<Record<string, OfflineMapPack['places']>>((groups, place) => {
    (groups[place.category] ||= []).push(place);
    return groups;
  }, {});

  return (
    <section className="minimal-card space-y-4" aria-labelledby="offline-pack-heading">
      <div>
        <h2 id="offline-pack-heading" className="font-semibold">Offline safety pack</h2>
        <p className="mt-1 text-sm text-ink-soft">
          {pack.selection.label} · {pack.selection.radiusKm} km · saved {new Date(pack.generatedAt).toLocaleDateString()}. Available without a connection; places also appear on the map.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {pack.emergencyNumbers.map((item) => (
          <a key={item.number} href={`tel:${item.number}`} className="rounded-lg border border-line px-2.5 py-1 text-xs font-medium">
            {item.label}: {item.number}
          </a>
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Object.entries(grouped).map(([category, places]) => (
          <div key={category} className="rounded-lg border border-line p-3 text-xs">
            <p className="font-semibold capitalize">{category.replace('_', ' ')} ({places.length})</p>
            <ul className="mt-1.5 space-y-1 text-ink-soft">
              {places.slice(0, 4).map((place) => (
                <li key={place.id}>
                  {place.name}
                  {place.phone && <a href={`tel:${place.phone}`} className="ml-1 text-ink underline">Call</a>}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <details className="text-sm">
        <summary className="cursor-pointer font-medium">Safety guidance</summary>
        <ul className="mt-2 space-y-2 text-xs leading-5 text-ink-soft">
          {pack.safetyInformation.map((item) => <li key={item.title}><strong className="text-ink">{item.title}:</strong> {item.body}</li>)}
        </ul>
      </details>
      <p className="text-[11px] text-ink-soft">{pack.attribution.join(' · ')}</p>
    </section>
  );
}
