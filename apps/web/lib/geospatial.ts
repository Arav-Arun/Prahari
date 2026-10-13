import * as turf from '@turf/turf';

export interface GeofenceZone {
  id: string;
  name: string;
  type: 'HIGH_RISK' | 'RESTRICTED' | 'SAFE' | 'PICKPOCKET_HOTSPOT' | 'DISASTER_PRONE' | 'TOURIST_ONLY';
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  coordinates: Array<[number, number]>; // [lat, lng] array
}

interface GeofenceCheckResult {
  isBreached: boolean;
  breachedZone: GeofenceZone | null;
  riskPenalty: number;
  alertMessage: string | null;
}

export function checkPointInGeofence(
  lat: number,
  lng: number,
  geofences: GeofenceZone[]
): GeofenceCheckResult {
  // Turf uses [lng, lat] format
  const point = turf.point([lng, lat]);
  let highestRisk: GeofenceCheckResult | null = null;

  for (const gf of geofences) {
    try {
      // Convert [lat, lng] array to [lng, lat] for Turf
      const turfCoords = gf.coordinates.map(([pLat, pLng]) => [pLng, pLat]);

      // Close polygon loop if first and last point don't match
      if (
        turfCoords[0][0] !== turfCoords[turfCoords.length - 1][0] ||
        turfCoords[0][1] !== turfCoords[turfCoords.length - 1][1]
      ) {
        turfCoords.push(turfCoords[0]);
      }

      const polygon = turf.polygon([turfCoords]);
      const isInside = turf.booleanPointInPolygon(point, polygon);

      if (isInside && gf.type !== 'SAFE') {
        const severityPenalty = gf.severity === 'CRITICAL' ? 40 : gf.severity === 'HIGH' ? 30 : gf.severity === 'MEDIUM' ? 20 : 10;
        const typePenalty = gf.type === 'RESTRICTED' ? 10 : gf.type === 'DISASTER_PRONE' ? 8 : gf.type === 'PICKPOCKET_HOTSPOT' ? 5 : gf.type === 'TOURIST_ONLY' ? 3 : 0;
        const riskPenalty = Math.min(40, severityPenalty + typePenalty);
        const label = gf.type === 'PICKPOCKET_HOTSPOT'
          ? 'pickpocket hotspot'
          : gf.type === 'DISASTER_PRONE'
            ? 'disaster-prone zone'
            : gf.type === 'TOURIST_ONLY'
              ? 'tourist-only zone'
              : gf.type === 'RESTRICTED'
                ? 'restricted zone'
                : 'high-risk zone';
        const result: GeofenceCheckResult = {
          isBreached: true,
          breachedZone: gf,
          riskPenalty,
          alertMessage: `🚨 WARNING: You have entered ${label} '${gf.name}'. Exercise caution and follow published guidance.`,
        };
        if (!highestRisk || result.riskPenalty > highestRisk.riskPenalty) highestRisk = result;
      }
    } catch (err) {
      console.error('Error evaluating Turf geofence polygon:', err);
    }
  }

  return highestRisk ?? {
    isBreached: false,
    breachedZone: null,
    riskPenalty: 0,
    alertMessage: null,
  };
}
