/**
 * The project originally included a small set of E2E and seed records so the
 * interface could be developed without a live dispatch feed.  They must never
 * appear as operational data.  We keep the rows intact for audit/debugging,
 * but exclude only their known fixture identities at the API boundary.
 */
const FIXTURE_TOURIST_IDS = new Set([
  'TOUR-E2E-TEST',
  'PRAHARI-SAFETY-E2E-TEST',
  'DTI-IND-000123',
  'DTI-IND-000456',
]);

const FIXTURE_INCIDENT_IDS = new Set([
  'INC-SEED-01',
  'INC-1092',
  'INC-1088',
]);

const FIXTURE_GEOFENCE_NAMES = new Set([
  'pink city central safe zone',
  'nahargarh cliff restricted area',
  'mira-bhayander high risk coastal zone',
  'sanjay gandhi national park restricted boundary',
  'temporary disaster risk zone b',
]);

const FIXTURE_RESPONDER_IDS = new Set([
  'RESP-POLICE-01',
  'RESP-MED-02',
  'UNIT #17',
  'UNIT #09',
]);

function text(value: unknown) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function isFixtureTourist(record: Record<string, any>) {
  const touristId = String(record.touristId ?? '').trim().toUpperCase();
  const name = String(record.name ?? '').trim().toLowerCase();
  return FIXTURE_TOURIST_IDS.has(touristId)
    || (touristId === 'TOUR-7890' && name === 'ralston')
    || /\b(demo|e2e|seed|automated test)\b/i.test(name);
}

export function isFixtureIncident(record: Record<string, any>) {
  const incidentId = String(record.incidentId ?? '').trim().toUpperCase();
  return FIXTURE_INCIDENT_IDS.has(incidentId)
    || incidentId.startsWith('E2E-')
    || incidentId.startsWith('INC-SEED-')
    || incidentId.startsWith('BLOCKCHAIN-E2E-');
}

function isFixtureGeofence(record: Record<string, any>) {
  return FIXTURE_GEOFENCE_NAMES.has(text(record.name));
}

function isFixtureResponder(record: Record<string, any>) {
  return [record.responderId, record.unitId]
    .map((value) => String(value ?? '').trim().toUpperCase())
    .some((value) => FIXTURE_RESPONDER_IDS.has(value));
}

export const operationalTourists = <T extends Record<string, any>>(rows: T[]) =>
  rows.filter((row) => !isFixtureTourist(row));

export const operationalIncidents = <T extends Record<string, any>>(rows: T[]) =>
  rows.filter((row) => !isFixtureIncident(row));

export const operationalGeofences = <T extends Record<string, any>>(rows: T[]) =>
  rows.filter((row) => !isFixtureGeofence(row));

export const operationalResponders = <T extends Record<string, any>>(rows: T[]) =>
  rows.filter((row) => !isFixtureResponder(row));
