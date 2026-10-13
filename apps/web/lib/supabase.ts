import { createClient, SupabaseClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const globalForSupabase = globalThis as unknown as { supabase?: SupabaseClient | null };

/** Tables required for the application to use durable storage safely. */
const REQUIRED_SUPABASE_TABLES = [
  "tourists",
  "locations",
  "geofences",
  "responders",
  "incidents",
  "users",
  "kyc_sessions",
  "credential_issuance",
] as const;

/** Newer columns an older database may be missing (see supabase/schema.sql). */
const REQUIRED_SUPABASE_COLUMNS: Record<string, readonly string[]> = {
  tourists: ['clothingProfile', 'touristAccessCodeHash', 'touristAccessCodeSalt', 'meshPubkeys'],
  incidents: [
    'emergencyContactNotifications',
    'cancelledAt',
    'cancelledBy',
    'missingPersonDraft',
    'transportType',
    'hopCount',
    'originalTimestamp',
    'relayPath',
    'originDeviceId',
    'packetId',
    'voiceStatement',
    'voiceStatementLanguage',
    'emergencyIdentificationProfile',
    'emergencyIdentificationProfileSharedAt',
    'incidentMessages',
    'meshRelayed',
    'meshOriginPubkey',
  ],
};

type DatabaseReadiness = {
  provider: "supabase";
  projectHost: string | null;
  configured: boolean;
  reachable: boolean;
  ready: boolean;
  unavailableTables: string[];
  unavailableColumns: string[];
};

/**
 * Server-side Supabase client (service_role — bypasses RLS).
 * Returns null when env vars are absent so local development can use
 * process-local records. The health endpoint reports this as not ready.
 */
export function getSupabase(): SupabaseClient | null {
  if (globalForSupabase.supabase !== undefined) return globalForSupabase.supabase;

  if (!url || !serviceKey) {
    console.warn(
      "[prahari] NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — using process-local development records."
    );
    globalForSupabase.supabase = null;
    return null;
  }

  globalForSupabase.supabase = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return globalForSupabase.supabase;
}

export const isSupabaseConfigured = Boolean(url && serviceKey);

/**
 * Performs non-mutating, service-role checks for every required table. This is
 * deliberately used by the health endpoint so a deployment never looks healthy
 * while requests are quietly falling back to process-local development records.
 */
export async function getDatabaseReadiness(): Promise<DatabaseReadiness> {
  const projectHost = (() => {
    try { return url ? new URL(url).host : null; } catch { return null; }
  })();
  if (!isSupabaseConfigured) {
    return {
      provider: "supabase",
      projectHost,
      configured: false,
      reachable: false,
      ready: false,
      unavailableTables: [...REQUIRED_SUPABASE_TABLES],
      unavailableColumns: Object.entries(REQUIRED_SUPABASE_COLUMNS).flatMap(([table, columns]) => columns.map((column) => `${table}.${column}`)),
    };
  }

  const client = getSupabase();
  if (!client) {
    return {
      provider: "supabase",
      projectHost,
      configured: true,
      reachable: false,
      ready: false,
      unavailableTables: [...REQUIRED_SUPABASE_TABLES],
      unavailableColumns: Object.entries(REQUIRED_SUPABASE_COLUMNS).flatMap(([table, columns]) => columns.map((column) => `${table}.${column}`)),
    };
  }

  const checks = await Promise.all(
    REQUIRED_SUPABASE_TABLES.map(async (table) => {
      try {
        // Use a normal select rather than a HEAD/count request: PostgREST can
        // answer metadata-only requests from a stale schema cache while the
        // application's actual row queries still fail.
        const { error } = await client.from(table).select("id").limit(1);
        return { table, available: !error };
      } catch {
        return { table, available: false };
      }
    })
  );
  const unavailableTables = checks.filter((check) => !check.available).map((check) => check.table);
  const columnChecks = await Promise.all(
    Object.entries(REQUIRED_SUPABASE_COLUMNS).flatMap(([table, columns]) =>
      columns.map(async (column) => {
        try {
          const { error } = await client.from(table).select(column).limit(1);
          return { table, column, available: !error };
        } catch {
          return { table, column, available: false };
        }
      }),
    ),
  );
  const unavailableColumns = columnChecks
    .filter((check) => !check.available)
    .map((check) => `${check.table}.${check.column}`);

  return {
    provider: "supabase",
    projectHost,
    configured: true,
    reachable: unavailableTables.length < REQUIRED_SUPABASE_TABLES.length,
    ready: unavailableTables.length === 0 && unavailableColumns.length === 0,
    unavailableTables,
    unavailableColumns,
  };
}
