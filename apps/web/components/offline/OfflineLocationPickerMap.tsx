'use client';

import { MapContainer, Marker, TileLayer, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

type Coordinates = { lat: number; lng: number };

const pickerIcon = typeof window === 'undefined'
  ? null
  : new L.DivIcon({
      className: 'offline-location-picker-icon',
      html: '<div style="width:18px;height:18px;border-radius:9999px;background:#1d1c1a;border:3px solid white;box-shadow:0 1px 4px rgba(0,0,0,.35)"></div>',
      iconSize: [18, 18],
      iconAnchor: [9, 9],
    });

function ClickHandler({ onPick }: { onPick: (coordinates: Coordinates) => void }) {
  useMapEvents({ click: (event) => onPick({ lat: event.latlng.lat, lng: event.latlng.lng }) });
  return null;
}

export default function OfflineLocationPickerMap({ value, onPick }: { value: Coordinates | null; onPick: (coordinates: Coordinates) => void }) {
  const center: [number, number] = value ? [value.lat, value.lng] : [20.5937, 78.9629];
  return (
    <div className="mt-3 h-52 overflow-hidden rounded-lg border border-line">
      <MapContainer center={center} zoom={value ? 11 : 4} scrollWheelZoom={true} style={{ height: '100%', width: '100%' }}>
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <ClickHandler onPick={onPick} />
        {value && <Marker position={[value.lat, value.lng]} icon={pickerIcon as any} />}
      </MapContainer>
    </div>
  );
}
