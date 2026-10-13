/**
 * Official India multi-hazard alerts from NDMA SACHET.
 *
 * SACHET publishes the current nationwide alert list as JSON. The records
 * provide a centroid and covered area rather than a guaranteed boundary, so a
 * match is deliberately labelled as an approximate proximity match in the UI.
 * Never turn a temporary upstream outage into an "all clear" response.
 */

const NDMA_ALERTS_URL = 'https://sachet.ndma.gov.in/cap_public_website/FetchAllAlertDetails';
const CACHE_TTL_MS = Number(process.env.HAZARD_ALERT_CACHE_TTL_MS || 5 * 60 * 1000);
const EARTH_RADIUS_KM = 6371;

/**
 * SACHET publishes severity in two different vocabularies depending on the
 * issuing state agency: the CAP-style words below, and the IMD colour code
 * (Red = take action, Orange = be prepared, Yellow = be aware, Green = no
 * warning). Both are normalised onto this one scale so a colour-coded flood
 * warning is ranked and scored exactly like a worded one.
 */
type HazardSeverity = 'WARNING' | 'ALERT' | 'WATCH' | 'ADVISORY';

const SEVERITY_RANK: Record<HazardSeverity, number> = { WARNING: 4, ALERT: 3, WATCH: 2, ADVISORY: 1 };
const COLOUR_SEVERITY: Record<string, HazardSeverity> = { RED: 'WARNING', ORANGE: 'ALERT', YELLOW: 'WATCH', GREEN: 'ADVISORY' };

function normalizeSeverity(reported: unknown, colour: unknown): HazardSeverity {
  const word = String(reported ?? '').trim().toUpperCase();
  if (word in SEVERITY_RANK) return word as HazardSeverity;
  if (word in COLOUR_SEVERITY) return COLOUR_SEVERITY[word];
  const colourWord = String(colour ?? '').trim().toUpperCase();
  if (colourWord in COLOUR_SEVERITY) return COLOUR_SEVERITY[colourWord];
  // An unrecognised severity must not silently read as "no hazard".
  return 'ADVISORY';
}

/**
 * Ordering and scoring weight for a severity. Raw colour codes are accepted as
 * well as normalised words, so a caller holding an unnormalised alert can never
 * silently score a real hazard as zero.
 */
export function hazardSeverityRank(severity: string): number {
  const word = String(severity).trim().toUpperCase();
  return SEVERITY_RANK[word as HazardSeverity] ?? SEVERITY_RANK[COLOUR_SEVERITY[word]] ?? 0;
}

/** Environmental-risk contribution of the most severe alert in a set. */
export function hazardEnvironmentalRisk(alerts: Array<{ severity?: string }> = []): number {
  const highest = alerts.reduce((rank, alert) => Math.max(rank, hazardSeverityRank(String(alert.severity ?? ''))), 0);
  return ({ 4: 30, 3: 22, 2: 14, 1: 8 } as Record<number, number>)[highest] ?? 0;
}

export type IndiaHazardAlert = {
  id: string;
  hazard: string;
  /** Normalised onto the four-level scale above; safe to rank and score. */
  severity: HazardSeverity;
  /** The publisher's own wording, retained so nothing is silently rewritten. */
  reportedSeverity: string;
  severityColor: string | null;
  likelihood: string | null;
  message: string;
  areaDescription: string;
  source: string;
  language: string | null;
  startsAt: string | null;
  endsAt: string | null;
  centroid: { lat: number; lng: number } | null;
  coveredAreaKm2: number | null;
  approximateCoverageRadiusKm: number | null;
  distanceKm?: number | null;
  matchPrecision: 'centroid-and-reported-area' | 'area-not-geocoded';
  officialUrl: string;
};

export type HazardFeedResult = {
  status: 'available' | 'stale' | 'unavailable';
  alerts: IndiaHazardAlert[];
  fetchedAt: string | null;
  sourceUrl: string;
  error?: string;
};

type RawSachetAlert = Record<string, unknown>;
type CachedFeed = { alerts: IndiaHazardAlert[]; fetchedAt: string };

let cachedFeed: CachedFeed | null = null;
let inFlight: Promise<HazardFeedResult> | null = null;

function finiteNumber(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseCentroid(value: unknown): { lat: number; lng: number } | null {
  if (typeof value !== 'string') return null;
  const [rawLng, rawLat] = value.split(',').map((part) => Number(part.trim()));
  if (!Number.isFinite(rawLat) || !Number.isFinite(rawLng) || Math.abs(rawLat) > 90 || Math.abs(rawLng) > 180) return null;
  return { lat: rawLat, lng: rawLng };
}

function parseSachetDate(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value.replace(/\sIST\s/, ' GMT+0530 '));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function normalizeAlert(raw: RawSachetAlert): IndiaHazardAlert | null {
  const id = String(raw.identifier ?? '').trim();
  const hazard = String(raw.disaster_type ?? '').trim();
  if (!id || !hazard) return null;

  const coveredAreaKm2 = finiteNumber(raw.area_covered);
  const radius = coveredAreaKm2 && coveredAreaKm2 > 0
    ? Math.sqrt(coveredAreaKm2 / Math.PI)
    : null;

  return {
    id,
    hazard,
    severity: normalizeSeverity(raw.severity, raw.severity_color),
    reportedSeverity: String(raw.severity ?? '').trim() || 'Not stated',
    severityColor: typeof raw.severity_color === 'string' ? raw.severity_color.toLowerCase() : null,
    likelihood: typeof raw.severity_level === 'string' ? raw.severity_level : null,
    message: String(raw.warning_message ?? raw.area_description ?? 'Official hazard advisory').trim().slice(0, 3_000),
    areaDescription: String(raw.area_description ?? 'Affected area not specified').trim().slice(0, 1_000),
    source: String(raw.alert_source ?? 'NDMA SACHET').trim().slice(0, 300),
    language: typeof raw.actual_lang === 'string' ? raw.actual_lang : null,
    startsAt: parseSachetDate(raw.effective_start_time),
    endsAt: parseSachetDate(raw.effective_end_time),
    centroid: parseCentroid(raw.centroid),
    coveredAreaKm2,
    approximateCoverageRadiusKm: radius ? Math.round(radius * 10) / 10 : null,
    matchPrecision: radius ? 'centroid-and-reported-area' : 'area-not-geocoded',
    officialUrl: 'https://sachet.ndma.gov.in/',
  };
}

function isExpired(alert: IndiaHazardAlert) {
  // NDMA can briefly retain an alert after its end time. Give the publisher a
  // 15-minute grace window while avoiding the display of plainly expired data.
  return alert.endsAt ? new Date(alert.endsAt).getTime() < Date.now() - 15 * 60 * 1000 : false;
}

function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const toRadians = (degrees: number) => degrees * Math.PI / 180;
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const half = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(half), Math.sqrt(1 - half));
}

async function refreshFeed(): Promise<HazardFeedResult> {
  try {
    const response = await fetch(NDMA_ALERTS_URL, {
      cache: 'no-store',
      headers: { Accept: 'application/json', 'User-Agent': 'Prahari/1.0 (+https://prahari.app)' },
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) throw new Error(`NDMA SACHET returned ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data)) throw new Error('NDMA SACHET returned an unexpected response.');

    const alerts = data
      .map((item) => normalizeAlert(item as RawSachetAlert))
      .filter((item): item is IndiaHazardAlert => Boolean(item))
      .filter((item) => !isExpired(item));
    const fetchedAt = new Date().toISOString();
    cachedFeed = { alerts, fetchedAt };
    return { status: 'available', alerts, fetchedAt, sourceUrl: NDMA_ALERTS_URL };
  } catch (error: any) {
    if (cachedFeed) {
      return {
        status: 'stale',
        alerts: cachedFeed.alerts,
        fetchedAt: cachedFeed.fetchedAt,
        sourceUrl: NDMA_ALERTS_URL,
        error: 'The official feed is temporarily unavailable; showing the last successful response.',
      };
    }
    return {
      status: 'unavailable',
      alerts: [],
      fetchedAt: null,
      sourceUrl: NDMA_ALERTS_URL,
      error: 'The official NDMA SACHET feed is temporarily unavailable. This does not mean there are no hazards.',
    };
  } finally {
    inFlight = null;
  }
}

async function getIndiaHazardFeed(): Promise<HazardFeedResult> {
  if (cachedFeed && Date.now() - new Date(cachedFeed.fetchedAt).getTime() < CACHE_TTL_MS) {
    return { status: 'available', alerts: cachedFeed.alerts, fetchedAt: cachedFeed.fetchedAt, sourceUrl: NDMA_ALERTS_URL };
  }
  if (!inFlight) inFlight = refreshFeed();
  return inFlight;
}

export async function getNearbyIndiaHazards(
  location: { lat: number; lng: number },
  requestedRadiusKm = 10,
): Promise<HazardFeedResult> {
  const feed = await getIndiaHazardFeed();
  const matchingRadiusKm = Math.min(Math.max(requestedRadiusKm, 1), 50);
  const alerts = feed.alerts
    .map((alert) => {
      if (!alert.centroid) return { ...alert, distanceKm: null };
      return { ...alert, distanceKm: Math.round(haversineKm(location, alert.centroid) * 10) / 10 };
    })
    .filter((alert) => {
      // SACHET's "area_covered" is not a boundary. We use it only to estimate
      // reach and clearly label the result as approximate.
      if (alert.distanceKm === null) return false;
      const coverage = alert.approximateCoverageRadiusKm ?? 0;
      return alert.distanceKm <= coverage + matchingRadiusKm;
    })
    .sort((a, b) => hazardSeverityRank(b.severity) - hazardSeverityRank(a.severity)
      || (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity));

  return { ...feed, alerts };
}

export function indiaHazardProviderStatus() {
  return {
    provider: 'NDMA SACHET',
    sourceUrl: NDMA_ALERTS_URL,
    cacheTtlSeconds: Math.round(CACHE_TTL_MS / 1000),
    lastSuccessfulFetchAt: cachedFeed?.fetchedAt ?? null,
  };
}
