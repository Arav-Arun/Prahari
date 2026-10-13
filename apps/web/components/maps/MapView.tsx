'use client';

import dynamic from 'next/dynamic';

// Leaflet touches `window`, so the map is only ever rendered in the browser.
const MapView = dynamic(() => import('./ClientMapInner'), {
  ssr: false,
  loading: () => (
    <div className="flex h-[420px] w-full items-center justify-center rounded-xl border border-line bg-surface-2 text-sm text-ink-soft">
      Loading map…
    </div>
  ),
});

export default MapView;
