-- Prahari :: Supabase schema
-- Run once in the Supabase dashboard -> SQL Editor. Safe to re-run: it only
-- creates what is missing.
--
-- Columns use quoted camelCase ("touristId") to match the JSON the API returns,
-- so in the SQL editor write e.g. select "touristId" from tourists;
--
-- All queries run server-side with the service-role key. RLS is enabled with no
-- policies, so the public (anon) key can read nothing.

-- ---------------------------------------------------------------- tourists
create table if not exists tourists (
  id                      uuid primary key default gen_random_uuid(),
  "touristId"             text unique not null,
  name                    text not null,
  nationality             text default 'India',
  "nationalityCode"       text,
  "identityStatus"        text default 'verified'
                            check ("identityStatus" in ('verified','pending','flagged','revoked')),
  did                     text,
  "didDocument"           jsonb,
  credential              jsonb,
  "credentialHash"        text,
  "credentialStatus"      text default 'none',
  "kycMethod"             text,
  "kycProvider"           text,
  "kycVerifiedAt"         timestamptz,
  "kycSubjectHash"        text,     -- salted hash of the Aadhaar / passport number
  "anchorTxHash"          text,
  "anchorChainId"         integer,
  "touristAccessCodeHash" text,     -- salted verifier for the recovery code
  "touristAccessCodeSalt" text,
  "meshPubkeys"           jsonb not null default '[]'::jsonb,
  "issueDate"             text,
  "emergencyContacts"     jsonb default '[]'::jsonb,
  accommodation           jsonb default '{}'::jsonb,
  itinerary               jsonb default '{}'::jsonb,
  preferences             jsonb default '{}'::jsonb,
  "currentLocation"       jsonb,
  "clothingProfile"       jsonb,
  "lastSafetyAssessment"  jsonb,
  "trackingConsent"       boolean default true,
  status                  text default 'SAFE',
  "riskScore"             integer default 15,
  "createdAt"             timestamptz default now(),
  "updatedAt"             timestamptz default now()
);
create unique index if not exists tourists_did_uniq on tourists (did) where did is not null;
create unique index if not exists tourists_kyc_subject_uniq on tourists ("kycSubjectHash") where "kycSubjectHash" is not null;
create index if not exists tourists_credhash_idx on tourists ("credentialHash");

-- --------------------------------------------------------------- locations
create table if not exists locations (
  id             uuid primary key default gen_random_uuid(),
  "touristId"    text not null,
  coordinates    jsonb not null,          -- { lat, lng }
  lat            double precision,
  lng            double precision,
  accuracy       double precision default 5,
  source         text default 'gps' check (source in ('gps','cellular','manual')),
  speed          double precision,
  "batteryLevel" double precision,
  "timestamp"    timestamptz default now(),
  "createdAt"    timestamptz default now()
);
create index if not exists locations_tourist_time_idx on locations ("touristId", "timestamp" desc);

-- --------------------------------------------------------------- geofences
create table if not exists geofences (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  type         text not null default 'high_risk',
  geometry     jsonb not null,            -- GeoJSON polygon
  coordinates  jsonb,                     -- [lat, lng][] for the map
  severity     text not null default 'high',
  active       boolean not null default true,
  metadata     jsonb not null default '{}'::jsonb,
  "createdAt"  timestamptz not null default now()
);
create index if not exists geofences_active_idx on geofences (active);

-- -------------------------------------------------------------- responders
create table if not exists responders (
  id             uuid primary key default gen_random_uuid(),
  "responderId"  text unique not null,
  "unitId"       text,
  name           text,
  phone          text,
  department     text default 'Police',
  location       jsonb not null,          -- { lat, lng }
  status         text default 'available',
  capabilities   jsonb default '[]'::jsonb,
  type           text default 'POLICE',
  "createdAt"    timestamptz default now()
);

-- --------------------------------------------------------------- incidents
create table if not exists incidents (
  id                        uuid primary key default gen_random_uuid(),
  "incidentId"              text unique not null,
  "touristId"               text not null,
  "touristName"             text,
  type                      text default 'SOS',
  status                    text default 'new',
  location                  jsonb not null,   -- { lat, lng, address }
  severity                  text default 'critical',
  "riskScore"               integer default 91,
  "assignedResponder"       text,
  "assignedResponderUnitId" text,
  "assignedResponderName"   text,
  "etaMinutes"              integer,
  timeline                  jsonb default '[]'::jsonb,
  "emergencyContactNotifications" jsonb,
  "efirDraft"               jsonb,
  "missingPersonDraft"      jsonb,
  "transportType"           text,
  "hopCount"                integer,
  "originalTimestamp"       timestamptz,
  "relayPath"               jsonb,
  "originDeviceId"          text,
  "packetId"                text,
  "meshRelayed"             boolean not null default false,
  "meshOriginPubkey"        text,
  "voiceStatement"          text,
  "voiceStatementLanguage"  text,
  "emergencyIdentificationProfile" jsonb,
  "emergencyIdentificationProfileSharedAt" timestamptz,
  "incidentMessages"        jsonb not null default '[]'::jsonb,
  "resolvedAt"              timestamptz,
  "cancelledAt"             timestamptz,
  "cancelledBy"             text,
  "createdAt"               timestamptz default now()
);
create index if not exists incidents_created_idx on incidents ("createdAt" desc);
create index if not exists incidents_efir_idx on incidents (("efirDraft" is not null));
create index if not exists incidents_missing_person_draft_idx on incidents (("missingPersonDraft" is not null));

-- ------------------------------------------------------------------ users
create table if not exists users (
  id              uuid primary key default gen_random_uuid(),
  "userId"        text unique not null,
  email           text unique not null,
  "passwordHash"  text not null,
  salt            text not null,
  name            text not null,
  role            text not null check (role in ('admin', 'authority', 'responder', 'tourist')),
  "entityId"      text,
  department      text,
  badge           text,
  phone           text,
  active          boolean default true,
  "createdAt"     timestamptz default now(),
  "updatedAt"     timestamptz default now()
);
create index if not exists users_role_idx on users (role);
create index if not exists users_entity_idx on users ("entityId");

-- ----------------------------------------------------------- kyc_sessions
-- Short-lived verification sessions. Holds only a salted document hash.
create table if not exists kyc_sessions (
  id              uuid primary key default gen_random_uuid(),
  "sessionId"     text unique not null,
  method          text not null check (method in ('aadhaar', 'passport')),
  status          text not null default 'pending'
                    check (status in ('pending','verified','failed','expired','locked')),
  "subjectHash"   text not null,
  "challengeHash" text,
  attempts        integer not null default 0,
  "maxAttempts"   integer not null default 3,
  payload         jsonb default '{}'::jsonb,
  "expiresAt"     timestamptz not null,
  "verifiedAt"    timestamptz,
  "createdAt"     timestamptz default now()
);
create index if not exists kyc_sessions_expiry_idx on kyc_sessions ("expiresAt");
create index if not exists kyc_sessions_status_idx on kyc_sessions (status);

-- ---------------------------------------------------- credential_issuance
-- Append-only issuance log, kept through revocation and reissue.
create table if not exists credential_issuance (
  id                uuid primary key default gen_random_uuid(),
  "touristId"       text not null,
  did               text not null,
  "credentialHash"  text not null,
  "kycMethod"       text not null,
  "kycProvider"     text not null,
  action            text not null default 'issued'
                      check (action in ('issued','revoked','suspended','reinstated')),
  "anchorTxHash"    text,
  "anchoredAt"      timestamptz,
  "createdAt"       timestamptz default now()
);
create index if not exists cred_issuance_tourist_idx on credential_issuance ("touristId");
create index if not exists cred_issuance_hash_idx on credential_issuance ("credentialHash");

-- ------------------------------------------------------------------- RLS
alter table tourists            enable row level security;
alter table locations           enable row level security;
alter table geofences           enable row level security;
alter table responders          enable row level security;
alter table incidents           enable row level security;
alter table users               enable row level security;
alter table kyc_sessions        enable row level security;
alter table credential_issuance enable row level security;

-- -------------------------------------------------------------- Realtime
-- Lets the authority desk receive live updates on the private `prahari:live`
-- channel using a short-lived token minted by the server. After running this,
-- turn off "Allow public access" in the project's Realtime settings.
drop policy if exists "prahari operational realtime receive" on realtime.messages;
create policy "prahari operational realtime receive"
on realtime.messages
for select
to authenticated
using (
  realtime.messages.extension = 'broadcast'
  and realtime.topic() = 'prahari:live'
  and (current_setting('request.jwt.claims', true)::jsonb ->> 'prahari_role') in ('authority', 'admin')
);
