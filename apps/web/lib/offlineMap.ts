export type OfflineMapSelection = {
  lat: number;
  lng: number;
  radiusKm: number;
  label: string;
};

export type OfflineMapPlace = {
  id: string;
  name: string;
  category: 'tourist' | 'hospital' | 'police' | 'fire_station' | 'safety_zone';
  lat: number;
  lng: number;
  address?: string;
  phone?: string;
};

export type OfflineMapPack = {
  version: 1;
  generatedAt: string;
  selection: OfflineMapSelection;
  places: OfflineMapPlace[];
  safetyInformation: Array<{ title: string; body: string }>;
  emergencyNumbers: Array<{ label: string; number: string }>;
  attribution: string[];
};

const STORAGE_KEY = 'prahari_offline_map_pack_v1';
const MAX_OFFLINE_TILES = 180;

export function readOfflineMapPack(): OfflineMapPack | null {
  if (typeof window === 'undefined') return null;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || 'null');
    if (!parsed || parsed.version !== 1 || !parsed.selection || !Array.isArray(parsed.places)) return null;
    return parsed as OfflineMapPack;
  } catch {
    return null;
  }
}

function saveOfflineMapPack(pack: OfflineMapPack) {
  if (typeof window === 'undefined') return false;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(pack));
    window.dispatchEvent(new Event('prahari:offline-map-pack-updated'));
    return true;
  } catch {
    return false;
  }
}

export function downloadOfflineMapPack(pack: OfflineMapPack) {
  saveOfflineMapPack(pack);
  const blob = new Blob([JSON.stringify(pack, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  const label = pack.selection.label.trim().replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'area';
  anchor.href = url;
  anchor.download = `prahari-offline-safety-map-${label}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function latToTileY(lat: number, zoom: number) {
  const radians = Math.max(Math.min(lat, 85.05112878), -85.05112878) * Math.PI / 180;
  const n = 2 ** zoom;
  return Math.floor((1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2 * n);
}

function lngToTileX(lng: number, zoom: number) {
  return Math.floor(((lng + 180) / 360) * 2 ** zoom);
}

function getTileUrls(selection: OfflineMapSelection, template: string) {
  const latitudeDelta = selection.radiusKm / 110.574;
  const longitudeDelta = selection.radiusKm / Math.max(15, 111.32 * Math.cos(selection.lat * Math.PI / 180));
  const north = Math.min(85, selection.lat + latitudeDelta);
  const south = Math.max(-85, selection.lat - latitudeDelta);
  const west = Math.max(-180, selection.lng - longitudeDelta);
  const east = Math.min(180, selection.lng + longitudeDelta);
  const selected: string[] = [];

  // Add a complete zoom level only. A partially cached high-detail level is
  // less useful than a complete lower-detail safety map.
  for (const zoom of [11, 12]) {
    const minX = lngToTileX(west, zoom);
    const maxX = lngToTileX(east, zoom);
    const minY = latToTileY(north, zoom);
    const maxY = latToTileY(south, zoom);
    const candidates: string[] = [];
    for (let x = minX; x <= maxX; x += 1) {
      for (let y = minY; y <= maxY; y += 1) {
        candidates.push(template.replace('{z}', String(zoom)).replace('{x}', String(x)).replace('{y}', String(y)));
      }
    }
    if (selected.length + candidates.length > MAX_OFFLINE_TILES) break;
    selected.push(...candidates);
  }
  return selected;
}

export function offlineTileConfiguration() {
  const template = process.env.NEXT_PUBLIC_OFFLINE_TILE_TEMPLATE?.trim() || null;
  return {
    template,
    attribution: process.env.NEXT_PUBLIC_OFFLINE_TILE_ATTRIBUTION?.trim() || 'Offline base map',
  };
}

export async function cacheConfiguredOfflineTiles(selection: OfflineMapSelection): Promise<{
  cached: number;
  attempted: number;
  error?: string;
}> {
  const { template } = offlineTileConfiguration();
  if (!template) {
    return {
      cached: 0,
      attempted: 0,
      error: 'No offline-capable base-map provider is configured. Your places, emergency services, and safety guidance were still saved offline.',
    };
  }
  if (!('serviceWorker' in navigator)) {
    return { cached: 0, attempted: 0, error: 'This browser does not support offline map caching.' };
  }

  const urls = getTileUrls(selection, template);
  if (!urls.length) return { cached: 0, attempted: 0, error: 'No base-map tiles could be planned for this area.' };

  try {
    const registration = await navigator.serviceWorker.ready;
    const target = navigator.serviceWorker.controller || registration.active;
    if (!target) return { cached: 0, attempted: urls.length, error: 'Offline map service is not ready yet. Please retry in a moment.' };

    const channel = new MessageChannel();
    const result = await new Promise<{ cached?: number; error?: string }>((resolve) => {
      const timeout = window.setTimeout(() => resolve({ error: 'Base-map download timed out. The safety pack remains available.' }), 60_000);
      channel.port1.onmessage = (event) => {
        window.clearTimeout(timeout);
        resolve(event.data || {});
      };
      target.postMessage({ type: 'PRAHARI_CACHE_OFFLINE_TILES', urls }, [channel.port2]);
    });
    return { cached: Number(result.cached || 0), attempted: urls.length, error: result.error };
  } catch {
    return { cached: 0, attempted: urls.length, error: 'Base-map tiles could not be cached. The safety pack remains available.' };
  }
}
