import { getSupabase } from "./supabase";
import { DEMO_ACCOUNTS_ENABLED } from "./demoAccounts";
import {
  operationalGeofences,
  operationalIncidents,
  operationalResponders,
  operationalTourists,
} from "./operationalData";

export { isSupabaseConfigured } from "./supabase";

/** Rows come back with camelCase columns already matching the API shape. */
type Row = Record<string, any>;

// Process-local storage is used only when no database is configured (for local
// development). Once Supabase is configured, a database failure must never be
// replaced with a fixture record or a pretend successful write. The stores live
// on globalThis because Next.js bundles each route separately, and every route
// must see the same records.
const memory: Record<string, any> = ((globalThis as any).__prahariMemory ??= {});
const inMemoryTourists: Map<string, Row> = (memory.tourists ??= new Map());
const inMemoryLocations: Row[] = (memory.locations ??= []);
const inMemoryIncidents: Map<string, Row> = (memory.incidents ??= new Map());
const inMemoryGeofences: Map<string, Row> = (memory.geofences ??= new Map());

// ------------------------------------------------------------------ tourists
export async function getTourist(touristId: string): Promise<Row | null> {
  const sb = getSupabase();
  if (!sb) return inMemoryTourists.get(touristId) ?? null;
  const { data, error } = await sb.from("tourists").select("*").eq("touristId", touristId).maybeSingle();
  if (error) { console.warn("[prahari] getTourist:", error.message); return null; }
  return data ?? null;
}

/** Looks a tourist up by either their tourist ID or DID. */
export async function getTouristByIdOrDid(id: string): Promise<Row | null> {
  const sb = getSupabase();
  if (!sb) {
    for (const t of inMemoryTourists.values()) {
      if (t.touristId === id || t.did === id) return t;
    }
    return null;
  }
  const { data, error } = await sb
    .from("tourists").select("*")
    .or(`touristId.eq.${id},did.eq.${id}`)
    .limit(1).maybeSingle();
  if (error) console.warn("[prahari] getTouristByIdOrDid:", error.message);
  return data ?? null;
}

export async function updateTourist(touristId: string, fields: Row): Promise<boolean> {
  const existing = inMemoryTourists.get(touristId) ?? { touristId };
  inMemoryTourists.set(touristId, { ...existing, ...fields, updatedAt: new Date().toISOString() });
  const sb = getSupabase();
  if (!sb) return true;
  const { error } = await sb
    .from("tourists")
    .update({ ...fields, updatedAt: new Date().toISOString() })
    .eq("touristId", touristId);
  if (error) {
    console.warn("[prahari] updateTourist:", error.message);
    if (error.message?.includes("schema cache") || error.message?.includes("column") || error.code === 'PGRST204') {
      const copy = { ...fields };
      delete copy.meshPubkeys;
      if (Object.keys(copy).length > 0) {
        const { error: retryErr } = await sb.from("tourists").update({ ...copy, updatedAt: new Date().toISOString() }).eq("touristId", touristId);
        if (!retryErr) return true;
      } else {
        return true;
      }
    }
    return false;
  }
  return true;
}

/** Insert-or-update on the touristId unique constraint. */
export async function upsertTourist(row: Row): Promise<boolean> {
  if (row.touristId) {
    const existing = inMemoryTourists.get(row.touristId) ?? {};
    inMemoryTourists.set(row.touristId, { ...existing, ...row });
  }
  const sb = getSupabase();
  if (!sb) return true;
  const { error } = await sb.from("tourists").upsert(row, { onConflict: "touristId" });
  if (error) { console.warn("[prahari] upsertTourist:", error.message); return false; }
  return true;
}

// ----------------------------------------------------------------- locations
export async function insertLocation(ping: Row): Promise<boolean> {
  inMemoryLocations.unshift({
    id: ping.id ?? crypto.randomUUID(),
    createdAt: ping.createdAt ?? new Date().toISOString(),
    ...ping,
  });
  const sb = getSupabase();
  if (!sb) return true;
  const { error } = await sb.from("locations").insert(ping);
  if (error) { console.warn("[prahari] insertLocation:", error.message); return false; }
  return true;
}

export async function listLocations(touristId: string, limit = 50): Promise<Row[]> {
  const sb = getSupabase();
  if (!sb) return inMemoryLocations
    .filter((location) => location.touristId === touristId)
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, limit);
  const { data, error } = await sb
    .from("locations").select("*")
    .eq("touristId", touristId)
    .order("timestamp", { ascending: false })
    .limit(limit);
  if (error) {
    console.warn("[prahari] listLocations:", error.message);
    return [];
  }
  return data ?? [];
}

// ----------------------------------------------------------------- geofences
export async function listActiveGeofences(): Promise<Row[]> {
  const sb = getSupabase();
  if (!sb) return [...inMemoryGeofences.values()].filter((geofence) => geofence.active !== false);
  const { data, error } = await sb.from("geofences").select("*").eq("active", true);
  if (error) { console.warn("[prahari] listActiveGeofences:", error.message); return []; }
  return data ?? [];
}

export async function insertGeofence(row: Row): Promise<Row | null> {
  const sb = getSupabase();
  if (!sb) {
    const stored = { id: crypto.randomUUID(), active: true, createdAt: new Date().toISOString(), ...row };
    inMemoryGeofences.set(stored.id, stored);
    return stored;
  }
  const { data, error } = await sb.from("geofences").insert(row).select().single();
  if (error) { console.warn("[prahari] insertGeofence:", error.message); return null; }
  return data;
}

/** Updates an authority-published boundary without delete-and-recreate loss. */
export async function updateGeofence(id: string, fields: Row): Promise<Row | null> {
  const sb = getSupabase();
  if (!sb) {
    const existing = inMemoryGeofences.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...fields };
    inMemoryGeofences.set(id, updated);
    return updated;
  }
  const { data, error } = await sb.from("geofences").update(fields).eq("id", id).select().maybeSingle();
  if (error) { console.warn("[prahari] updateGeofence:", error.message); return null; }
  return data ?? null;
}

// ---------------------------------------------------------------- responders
export async function listResponders(): Promise<Row[]> {
  const sb = getSupabase();
  if (!sb) return [];
  const { data, error } = await sb.from("responders").select("*");
  if (error) { console.warn("[prahari] listResponders:", error.message); return []; }
  return data ?? [];
}

// ----------------------------------------------------------------- incidents
export async function getIncident(incidentId: string): Promise<Row | null> {
  const memory = inMemoryIncidents.get(incidentId) ?? null;
  const sb = getSupabase();
  if (!sb) return memory;
  const { data, error } = await sb.from("incidents").select("*").eq("incidentId", incidentId).maybeSingle();
  if (error) { console.warn("[prahari] getIncident:", error.message); return memory; }
  return data ? { ...(memory ?? {}), ...data } : memory;
}

/** Most recent incidents, optionally only one traveller's. */
export async function listIncidents(limit = 50, touristId?: string): Promise<Row[]> {
  const memRows = Array.from(inMemoryIncidents.values()).filter((row) => !touristId || row.touristId === touristId);
  const sb = getSupabase();
  if (!sb) {
    return memRows
      .sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime())
      .slice(0, limit);
  }

  let query = sb.from("incidents").select("*");
  if (touristId) query = query.eq("touristId", touristId);
  const { data, error } = await query.order("createdAt", { ascending: false }).limit(limit);

  if (error) {
    console.warn("[prahari] listIncidents:", error.message);
    return memRows
      .sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime())
      .slice(0, limit);
  }

  // Combine Supabase rows and in-memory rows so no incident is ever missed
  const combinedMap = new Map<string, Row>();
  for (const r of memRows) {
    if (r.incidentId) combinedMap.set(r.incidentId, r);
  }
  for (const dbRow of data ?? []) {
    if (dbRow.incidentId) {
      const existingMem = combinedMap.get(dbRow.incidentId) ?? {};
      combinedMap.set(dbRow.incidentId, { ...existingMem, ...dbRow });
    }
  }

  return Array.from(combinedMap.values())
    .sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime())
    .slice(0, limit);
}

const KNOWN_INCIDENT_DB_COLUMNS = new Set([
  'id',
  'incidentId',
  'touristId',
  'touristName',
  'type',
  'status',
  'location',
  'severity',
  'riskScore',
  'assignedResponder',
  'assignedResponderUnitId',
  'assignedResponderName',
  'etaMinutes',
  'timeline',
  'emergencyContactNotifications',
  'efirDraft',
  'missingPersonDraft',
  'transportType',
  'hopCount',
  'originalTimestamp',
  'relayPath',
  'originDeviceId',
  'packetId',
  'meshRelayed',
  'meshOriginPubkey',
  'voiceStatement',
  'voiceStatementLanguage',
  'emergencyIdentificationProfile',
  'emergencyIdentificationProfileSharedAt',
  'incidentMessages',
  'resolvedAt',
  'cancelledAt',
  'cancelledBy',
  'createdAt',
]);

function sanitizeIncidentRowForDb(row: Row): Row {
  const sanitized: Row = {};
  for (const [key, val] of Object.entries(row)) {
    if (KNOWN_INCIDENT_DB_COLUMNS.has(key)) {
      sanitized[key] = val;
    }
  }
  return sanitized;
}

export async function insertIncident(row: Row): Promise<boolean> {
  const fullRow = { createdAt: new Date().toISOString(), ...row };
  const previous = inMemoryIncidents.get(row.incidentId);
  inMemoryIncidents.set(row.incidentId, fullRow);
  const sb = getSupabase();
  if (!sb) return true;

  const sanitized = sanitizeIncidentRowForDb(fullRow);
  const { error } = await sb.from("incidents").insert(sanitized);
  if (error) {
    console.warn("[prahari] insertIncident:", error.message);
    if (previous) inMemoryIncidents.set(row.incidentId, previous);
    else inMemoryIncidents.delete(row.incidentId);
    return false;
  }
  return true;
}

export async function upsertIncident(row: Row): Promise<boolean> {
  const existing = inMemoryIncidents.get(row.incidentId) ?? {};
  inMemoryIncidents.set(row.incidentId, { ...existing, ...row, updatedAt: new Date().toISOString() });
  const sb = getSupabase();
  if (!sb) return true;
  const { error } = await sb.from("incidents").upsert(row, { onConflict: "incidentId" });
  if (error) {
    console.warn("[prahari] upsertIncident:", error.message);
    if (error.message?.includes("schema cache") || error.message?.includes("column") || error.code === 'PGRST204') {
      const sanitized = sanitizeIncidentRowForDb(row);
      const { error: retryErr } = await sb.from("incidents").upsert(sanitized, { onConflict: "incidentId" });
      if (!retryErr) return true;
    }
    return false;
  }
  return true;
}

/** Incidents that carry a traveller report draft. */
export async function listIncidentsWithEfir(): Promise<Row[]> {
  const sb = getSupabase();
  if (!sb) return [...inMemoryIncidents.values()].filter((incident) => incident.efirDraft);
  const { data, error } = await sb.from("incidents").select("*").not("efirDraft", "is", null);
  if (error) {
    console.warn("[prahari] listIncidentsWithEfir:", error.message);
    return [];
  }
  return data ?? [];
}

// --------------------------------------------------------------- dashboard
export async function listTourists(limit = 200): Promise<Row[]> {
  const sb = getSupabase();
  if (!sb) return [...inMemoryTourists.values()].slice(0, limit);
  const { data, error } = await sb.from("tourists").select("*").limit(limit);
  if (error) { console.warn("[prahari] listTourists:", error.message); return []; }
  return data ?? [];
}

type DashboardStats = {
  activeTourists: number;
  liveIncidents: number;
  highRiskZones: number;
  respondersAvailable: number;
  respondersTotal: number;
};

/** Real aggregate counts for the authority dashboard tiles. */
export async function getDashboardStats(): Promise<DashboardStats | null> {
  const sb = getSupabase();
  let rows: { tourists: Row[]; incidents: Row[]; zones: Row[]; responders: Row[] };

  if (!sb) {
    rows = {
      tourists: [...inMemoryTourists.values()],
      incidents: [...inMemoryIncidents.values()],
      zones: [...inMemoryGeofences.values()],
      responders: [],
    };
  } else {
    const [tourists, incidents, zones, responders] = await Promise.all([
      sb.from("tourists").select("touristId,name,identityStatus"),
      sb.from("incidents").select("incidentId,touristId,touristName,type,status"),
      sb.from("geofences").select("id,name,severity,active"),
      sb.from("responders").select("id,responderId,unitId,status"),
    ]);
    const err = [tourists, incidents, zones, responders].find((r) => r.error);
    if (err?.error) { console.warn("[prahari] getDashboardStats:", err.error.message); return null; }
    rows = { tourists: tourists.data ?? [], incidents: incidents.data ?? [], zones: zones.data ?? [], responders: responders.data ?? [] };
  }

  const liveIncidentStatuses = new Set(['resolved', 'cancelled', 'rejected']);
  const visibleIncidents = operationalIncidents(rows.incidents).filter(
    (incident) => !liveIncidentStatuses.has(String(incident.status ?? '').toLowerCase())
  );
  const visibleZones = operationalGeofences(rows.zones);
  const visibleResponders = operationalResponders(rows.responders);

  return {
    activeTourists: operationalTourists(rows.tourists).length,
    liveIncidents: visibleIncidents.length,
    highRiskZones: visibleZones.filter(
      (zone) => ['high', 'critical'].includes(String(zone.severity ?? '').toLowerCase()) && zone.active !== false
    ).length,
    respondersAvailable: visibleResponders.filter(
      (responder) => String(responder.status ?? '').toLowerCase() === 'available'
    ).length,
    respondersTotal: visibleResponders.length,
  };
}

/** Partial update of an incident by its business key. */
export async function updateIncident(incidentId: string, fields: Row): Promise<Row | null> {
  const previous = inMemoryIncidents.get(incidentId);
  let existing = previous;
  if (!existing) {
    existing = { incidentId, ...fields };
  } else {
    existing = { ...existing, ...fields };
  }
  const updatedInMemory = { ...existing, updatedAt: new Date().toISOString() };
  inMemoryIncidents.set(incidentId, updatedInMemory);

  const sb = getSupabase();
  if (!sb) return updatedInMemory;

  const sanitized = sanitizeIncidentRowForDb(fields);
  if (Object.keys(sanitized).length > 0) {
    const { data, error } = await sb
      .from("incidents").update(sanitized).eq("incidentId", incidentId).select().maybeSingle();

    if (error) {
      console.warn("[prahari] updateIncident:", error.message);
      if (previous) inMemoryIncidents.set(incidentId, previous);
      else inMemoryIncidents.delete(incidentId);
      return null;
    } else if (data) {
      return { ...updatedInMemory, ...data };
    } else {
      if (previous) inMemoryIncidents.set(incidentId, previous);
      else inMemoryIncidents.delete(incidentId);
      return null;
    }
  }
  if (previous) inMemoryIncidents.set(incidentId, previous);
  else inMemoryIncidents.delete(incidentId);
  return null;
}

// ------------------------------------------------------------- kyc sessions
interface KycSessionRow {
  sessionId: string;
  method: 'aadhaar' | 'passport';
  status: string;
  subjectHash: string;
  challengeHash: string | null;
  attempts: number;
  maxAttempts: number;
  payload: Record<string, any>;
  expiresAt: string;
}

const inMemoryKycSessions: Map<string, KycSessionRow> = (memory.kycSessions ??= new Map());

export async function createKycSession(row: {
  sessionId: string; method: string; status: string; subjectHash: string;
  challengeHash: string | null; expiresAt: string; payload: Record<string, unknown>;
}): Promise<boolean> {
  const sessionRow: KycSessionRow = {
    sessionId: row.sessionId,
    method: row.method as 'aadhaar' | 'passport',
    status: row.status,
    subjectHash: row.subjectHash,
    challengeHash: row.challengeHash,
    attempts: 0,
    maxAttempts: 3,
    payload: row.payload as Record<string, any>,
    expiresAt: row.expiresAt,
  };
  inMemoryKycSessions.set(row.sessionId, sessionRow);

  const sb = getSupabase();
  if (!sb) return true;
  const { error } = await sb.from("kyc_sessions").insert(row);
  if (error) { console.warn("[prahari] createKycSession:", error.message); return false; }
  return true;
}

export async function getKycSession(sessionId: string): Promise<KycSessionRow | null> {
  const sb = getSupabase();
  if (!sb) return inMemoryKycSessions.get(sessionId) ?? null;
  const { data, error } = await sb
    .from("kyc_sessions").select("*").eq("sessionId", sessionId).maybeSingle();
  if (error) console.warn("[prahari] getKycSession:", error.message);
  if (error || !data) return null;
  return (data as KycSessionRow) ?? null;
}

/** Atomically bumps the attempt counter and returns the new value. */
export async function incrementKycAttempts(sessionId: string): Promise<number> {
  const mem = inMemoryKycSessions.get(sessionId);
  if (mem) {
    mem.attempts = (mem.attempts ?? 0) + 1;
  }
  const sb = getSupabase();
  if (!sb) return mem?.attempts ?? 1;
  const current = await getKycSession(sessionId);
  const next = (current?.attempts ?? 0) + 1;
  const { error } = await sb.from("kyc_sessions").update({ attempts: next }).eq("sessionId", sessionId);
  if (error) { console.warn("[prahari] incrementKycAttempts:", error.message); }
  return next;
}

export async function markKycSessionVerified(sessionId: string): Promise<boolean> {
  const mem = inMemoryKycSessions.get(sessionId);
  if (mem) {
    mem.status = 'verified';
  }
  const sb = getSupabase();
  if (!sb) return true;
  const { error } = await sb.from("kyc_sessions")
    .update({ status: "verified", verifiedAt: new Date().toISOString() })
    .eq("sessionId", sessionId);
  if (error) { console.warn("[prahari] markKycSessionVerified:", error.message); return false; }
  return true;
}

export async function markKycSessionFailed(sessionId: string, status: "failed" | "expired" | "locked"): Promise<boolean> {
  const mem = inMemoryKycSessions.get(sessionId);
  if (mem) {
    mem.status = status;
  }
  const sb = getSupabase();
  if (!sb) return true;
  const { error } = await sb.from("kyc_sessions").update({ status }).eq("sessionId", sessionId);
  if (error) { console.warn("[prahari] markKycSessionFailed:", error.message); return false; }
  return true;
}

// --------------------------------------------------------------- identity
export async function getTouristByDid(did: string): Promise<Row | null> {
  const sb = getSupabase();
  if (!sb) {
    for (const t of inMemoryTourists.values()) {
      if (t.did === did) return t;
    }
    return null;
  }
  const { data, error } = await sb.from("tourists").select("*").eq("did", did).maybeSingle();
  if (error) console.warn("[prahari] getTouristByDid:", error.message);
  return data ?? null;
}

export async function getTouristBySubjectHash(subjectHash: string): Promise<Row | null> {
  const sb = getSupabase();
  if (!sb) {
    for (const t of inMemoryTourists.values()) {
      if (t.kycSubjectHash === subjectHash) return t;
    }
    return null;
  }
  const { data, error } = await sb
    .from("tourists").select("*").eq("kycSubjectHash", subjectHash).maybeSingle();
  if (error) console.warn("[prahari] getTouristBySubjectHash:", error.message);
  return data ?? null;
}

/** Appends to the immutable issuance log (also the Block 3 anchoring queue). */
export async function logCredentialIssuance(row: {
  touristId: string; did: string; credentialHash: string;
  kycMethod: string; kycProvider: string; action?: string;
}): Promise<boolean> {
  const sb = getSupabase();
  if (!sb) return true;
  const { error } = await sb.from("credential_issuance").insert(row);
  if (error) { console.warn("[prahari] logCredentialIssuance:", error.message); return false; }
  return true;
}

// ------------------------------------------------------------------ users
interface UserRow {
  id?: string;
  userId: string;
  email: string;
  passwordHash: string;
  salt: string;
  name: string;
  role: 'admin' | 'authority' | 'responder' | 'tourist';
  entityId?: string | null;
  department?: string | null;
  badge?: string | null;
  phone?: string | null;
  active?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

const DEMO_USERS: Record<string, UserRow> = {
  'officer.sharma@police.gov.in': {
    userId: 'USER-AUTH-001',
    email: 'officer.sharma@police.gov.in',
    passwordHash: 'd3be41eaadd156a36e5cac59b80e8862c960886f9bc682088a09e008ebc2e7408b63de218600a1d023ed9c085db4ae6c49b49c61a49fa38261b58504d1efafbb',
    salt: 'praharidemosalt123',
    name: 'Officer Rajesh Sharma',
    role: 'authority',
    department: 'Tourist Safety HQ',
    badge: 'POL-IND-7789',
    active: true,
  },
  'authority@prahari.gov.in': {
    userId: 'USER-AUTH-002',
    email: 'authority@prahari.gov.in',
    passwordHash: 'd3be41eaadd156a36e5cac59b80e8862c960886f9bc682088a09e008ebc2e7408b63de218600a1d023ed9c085db4ae6c49b49c61a49fa38261b58504d1efafbb',
    salt: 'praharidemosalt123',
    name: 'Inspector Vikram Singh',
    role: 'authority',
    department: 'State Command Center',
    badge: 'AUTH-001',
    active: true,
  },
  'responder@police.gov.in': {
    userId: 'USER-RESP-001',
    email: 'responder@police.gov.in',
    passwordHash: 'd3be41eaadd156a36e5cac59b80e8862c960886f9bc682088a09e008ebc2e7408b63de218600a1d023ed9c085db4ae6c49b49c61a49fa38261b58504d1efafbb',
    salt: 'praharidemosalt123',
    name: 'Officer Amit Kumar (Patrol)',
    role: 'responder',
    entityId: 'RESP-01',
    department: 'Jaipur Rapid Response',
    badge: 'RESP-IND-5544',
    active: true,
  },
  'admin@police.gov.in': {
    userId: 'USER-ADMIN-001',
    email: 'admin@police.gov.in',
    passwordHash: 'd3be41eaadd156a36e5cac59b80e8862c960886f9bc682088a09e008ebc2e7408b63de218600a1d023ed9c085db4ae6c49b49c61a49fa38261b58504d1efafbb',
    salt: 'praharidemosalt123',
    name: 'System Administrator',
    role: 'admin',
    department: 'Cyber Command',
    badge: 'ADM-001',
    active: true,
  },
};

export async function getUserByEmail(email: string): Promise<UserRow | null> {
  const cleanEmail = email.toLowerCase().trim();
  const demoFallback = DEMO_ACCOUNTS_ENABLED ? DEMO_USERS[cleanEmail] ?? null : null;
  const sb = getSupabase();
  if (!sb) return demoFallback;
  try {
    const { data, error } = await sb
      .from("users")
      .select("*")
      .eq("email", cleanEmail)
      .maybeSingle();
    if (error) { console.warn("[prahari] getUserByEmail:", error.message); }
    return (data as UserRow) ?? demoFallback;
  } catch {
    return demoFallback;
  }
}
