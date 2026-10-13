export type SafetyCoordinates = { lat: number; lng: number };

type SafetySignalCode =
  | "telemetry_gap"
  | "route_deviation"
  | "unexpected_speed"
  | "low_location_quality"
  | "high_risk_zone"
  | "nighttime_exposure"
  | "local_incident_density"
  | "official_hazard";

type SafetySignal = {
  code: SafetySignalCode;
  severity: "low" | "medium" | "high" | "critical";
  message: string;
  contribution: number;
};

type SafetyAssessment = {
  score: number;
  level: "low" | "medium" | "high" | "critical";
  requiresHumanReview: boolean;
  model: "explainable-safety-signals-v1";
  featureSummary: {
    inactivityMinutes: number;
    routeDeviationMeters: number | null;
    derivedSpeedKph: number | null;
    zoneRisk: number;
    localIncidentCount: number;
    environmentalRisk: number;
    isNighttime: boolean;
  };
  signals: SafetySignal[];
};

type HistoricalPing = {
  lat?: number | null;
  lng?: number | null;
  coordinates?: { lat?: number; lng?: number } | null;
  timestamp?: string | null;
};

type AssessmentInput = {
  current: SafetyCoordinates;
  previousLocations: HistoricalPing[];
  accuracy?: number | null;
  reportedSpeedMps?: number | null;
  zoneRisk?: number;
  /** Real, non-fixture incidents near this point in the configured review window. */
  localIncidentCount?: number;
  /** 0–30 impact calculated from matching official hazard advisories. */
  environmentalRisk?: number;
  /** Local hour for the traveller's operating region; defaults to Asia/Kolkata. */
  localHour?: number;
  plannedRoute?: SafetyCoordinates[] | null;
  now?: Date;
};

const EARTH_RADIUS_M = 6_371_000;

function radians(value: number): number {
  return (value * Math.PI) / 180;
}

export function distanceMeters(a: SafetyCoordinates, b: SafetyCoordinates): number {
  const latDelta = radians(b.lat - a.lat);
  const lngDelta = radians(b.lng - a.lng);
  const lat1 = radians(a.lat);
  const lat2 = radians(b.lat);
  const h = Math.sin(latDelta / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(lngDelta / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

/** Distance to a route segment using a locally accurate equirectangular plane. */
function pointToSegmentMeters(point: SafetyCoordinates, start: SafetyCoordinates, end: SafetyCoordinates): number {
  const latitudeScale = 111_320;
  const longitudeScale = latitudeScale * Math.cos(radians((point.lat + start.lat + end.lat) / 3));
  const x = (point.lng - start.lng) * longitudeScale;
  const y = (point.lat - start.lat) * latitudeScale;
  const x1 = (start.lng - point.lng) * longitudeScale;
  const y1 = (start.lat - point.lat) * latitudeScale;
  const x2 = (end.lng - point.lng) * longitudeScale;
  const y2 = (end.lat - point.lat) * latitudeScale;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSquared = dx * dx + dy * dy;
  const projection = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, -(x1 * dx + y1 * dy) / lengthSquared));
  return Math.hypot(x1 + projection * dx, y1 + projection * dy);
}

function distanceToRouteMeters(point: SafetyCoordinates, route?: SafetyCoordinates[] | null): number | null {
  if (!route || route.length < 2) return null;
  let nearest = Number.POSITIVE_INFINITY;
  for (let index = 0; index < route.length - 1; index += 1) {
    nearest = Math.min(nearest, pointToSegmentMeters(point, route[index], route[index + 1]));
  }
  return Math.round(nearest);
}

function previousCoordinates(ping: HistoricalPing): SafetyCoordinates | null {
  const lat = ping.lat ?? ping.coordinates?.lat;
  const lng = ping.lng ?? ping.coordinates?.lng;
  return typeof lat === "number" && typeof lng === "number" ? { lat, lng } : null;
}

function riskLevel(score: number): SafetyAssessment["level"] {
  if (score >= 75) return "critical";
  if (score >= 50) return "high";
  if (score >= 25) return "medium";
  return "low";
}

/**
 * Produces auditable safety signals from consented telemetry. It is deliberately
 * not a trained classifier: every score contribution is returned for officer
 * review, and a telemetry gap is never labelled as proof of distress.
 */
export function assessSafetyRisk(input: AssessmentInput): SafetyAssessment {
  const now = input.now ?? new Date();
  const signals: SafetySignal[] = [];
  const zoneRisk = Math.max(0, Math.min(40, input.zoneRisk ?? 0));
  const localIncidentCount = Math.max(0, Math.min(50, Math.floor(input.localIncidentCount ?? 0)));
  const environmentalRisk = Math.max(0, Math.min(30, Math.round(input.environmentalRisk ?? 0)));
  const localHour = Number.isInteger(input.localHour) ? Number(input.localHour) : Number(new Intl.DateTimeFormat('en-IN', { hour: 'numeric', hourCycle: 'h23', timeZone: 'Asia/Kolkata' }).format(now));
  const isNighttime = localHour >= 22 || localHour < 5;
  let score = Math.round(zoneRisk * 0.75);

  if (zoneRisk > 0) {
    signals.push({
      code: "high_risk_zone",
      severity: zoneRisk >= 40 ? "critical" : zoneRisk >= 30 ? "high" : "medium",
      message: "Current location is inside a configured risk zone.",
      contribution: Math.round(zoneRisk * 0.75),
    });
  }

  if (localIncidentCount > 0) {
    const contribution = Math.min(75, localIncidentCount * 4 + (localIncidentCount >= 5 ? 15 : 5));
    const severity: SafetySignal["severity"] = contribution >= 60 ? 'critical' : contribution >= 40 ? 'high' : contribution >= 20 ? 'medium' : 'low';
    signals.push({
      code: 'local_incident_density',
      severity,
      message: `${localIncidentCount} recent operational incident${localIncidentCount === 1 ? '' : 's'} were recorded near this location.`,
      contribution,
    });
    score += contribution;
  }

  if (environmentalRisk > 0) {
    signals.push({
      code: 'official_hazard',
      severity: environmentalRisk >= 25 ? 'critical' : environmentalRisk >= 15 ? 'high' : 'medium',
      message: 'An official nearby hazard advisory increases the safety review score.',
      contribution: environmentalRisk,
    });
    score += environmentalRisk;
  }

  if (isNighttime) {
    signals.push({
      code: 'nighttime_exposure',
      severity: 'low',
      message: 'Late-night travel increases the contextual safety review score.',
      contribution: 5,
    });
    score += 5;
  }

  const last = input.previousLocations.find((location) => previousCoordinates(location) && location.timestamp);
  const lastAt = last?.timestamp ? new Date(last.timestamp) : null;
  const inactivityMinutes = lastAt && Number.isFinite(lastAt.getTime())
    ? Math.max(0, Math.round((now.getTime() - lastAt.getTime()) / 60_000))
    : 0;

  if (inactivityMinutes >= 180) {
    signals.push({ code: "telemetry_gap", severity: "high", message: "Location telemetry resumed after a gap of at least three hours.", contribution: 35 });
    score += 35;
  } else if (inactivityMinutes >= 60) {
    signals.push({ code: "telemetry_gap", severity: "medium", message: "Location telemetry resumed after a gap of at least one hour.", contribution: 25 });
    score += 25;
  } else if (inactivityMinutes >= 15) {
    signals.push({ code: "telemetry_gap", severity: "low", message: "A short location telemetry gap was observed.", contribution: 10 });
    score += 10;
  }

  const routeDeviationMeters = distanceToRouteMeters(input.current, input.plannedRoute);
  if (routeDeviationMeters !== null) {
    if (routeDeviationMeters >= 5_000) {
      signals.push({ code: "route_deviation", severity: "high", message: "Current location is more than 5 km from the planned route.", contribution: 30 });
      score += 30;
    } else if (routeDeviationMeters >= 2_000) {
      signals.push({ code: "route_deviation", severity: "medium", message: "Current location is more than 2 km from the planned route.", contribution: 20 });
      score += 20;
    } else if (routeDeviationMeters >= 500) {
      signals.push({ code: "route_deviation", severity: "low", message: "Current location is more than 500 m from the planned route.", contribution: 10 });
      score += 10;
    }
  }

  const priorCoordinates = last ? previousCoordinates(last) : null;
  const derivedSpeedKph = priorCoordinates && lastAt && now.getTime() > lastAt.getTime()
    ? Math.round((distanceMeters(priorCoordinates, input.current) / ((now.getTime() - lastAt.getTime()) / 1_000)) * 3.6)
    : null;
  const reportedSpeedKph = typeof input.reportedSpeedMps === "number" && input.reportedSpeedMps >= 0
    ? input.reportedSpeedMps * 3.6
    : null;
  const observedSpeed = Math.max(derivedSpeedKph ?? 0, reportedSpeedKph ?? 0);
  if (observedSpeed >= 160) {
    signals.push({ code: "unexpected_speed", severity: "medium", message: "A location transition implies an unusual speed; GPS accuracy should be checked.", contribution: 15 });
    score += 15;
  }

  if ((input.accuracy ?? 0) >= 100) {
    signals.push({ code: "low_location_quality", severity: "low", message: "GPS accuracy is low, so route and zone conclusions may be less reliable.", contribution: 5 });
    score += 5;
  }

  score = Math.min(100, score);
  return {
    score,
    level: riskLevel(score),
    requiresHumanReview: score >= 70,
    model: "explainable-safety-signals-v1",
    featureSummary: { inactivityMinutes, routeDeviationMeters, derivedSpeedKph, zoneRisk, localIncidentCount, environmentalRisk, isNighttime },
    signals,
  };
}
