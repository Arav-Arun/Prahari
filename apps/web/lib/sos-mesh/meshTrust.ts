/**
 * Offline SOS Mesh — Server-side relay trust.
 *
 * A mesh only helps if a stranger's phone can carry your SOS out. That means
 * the gateway cannot authorise on the *relaying* session's identity — it has to
 * authorise on the packet itself.
 *
 * The rule here: any authenticated user may hand in a packet for any tourist,
 * provided the packet carries a valid BIP-340 signature from a key that tourist
 * has registered. Every routing field the authority queue acts on is then taken
 * from the signed event, never from the mutable JSON envelope, so a relay can
 * drop or delay a packet but never redirect or rewrite one.
 */

import { fromNostrSOSEvent, verifyNostrSOSEvent, type SOSPacket } from './sosPacket';

/** Column on the tourist record holding this traveller's device pubkeys. */
export const MESH_PUBKEY_FIELD = 'meshPubkeys';

/** One traveller may carry a handful of devices; beyond that, oldest is evicted. */
const MAX_MESH_KEYS_PER_TOURIST = 5;

/** Events older than this are refused even if the signature is good. */
const MESH_EVENT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Tolerance for a relaying device with a slightly fast clock. */
const MESH_EVENT_MAX_SKEW_MS = 5 * 60 * 1000;

type MeshTrustVerdict =
  | { trusted: true; packet: SOSPacket }
  | { trusted: false; reason: string };

/** Normalises a candidate pubkey to lowercase 32-byte hex, or null. */
export function normalizeMeshPubkey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const clean = value.trim().replace(/^0x/, '').toLowerCase();
  return /^[0-9a-f]{64}$/.test(clean) ? clean : null;
}

/** Reads the pubkeys a tourist has registered, tolerating legacy/absent shapes. */
export function registeredMeshPubkeys(tourist: Record<string, any> | null | undefined): string[] {
  const raw = tourist?.[MESH_PUBKEY_FIELD];
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeMeshPubkey).filter((key): key is string => key !== null);
}

/** Adds a pubkey to a tourist's set, keeping the newest MAX_MESH_KEYS_PER_TOURIST. */
export function withRegisteredMeshPubkey(existing: string[], pubkey: string): string[] {
  return [pubkey, ...existing.filter((key) => key !== pubkey)].slice(0, MAX_MESH_KEYS_PER_TOURIST);
}

/**
 * The touristId inside the signed event — the only one a relay cannot alter.
 * Used to decide which tourist record to check the signature against.
 */
export function signedTouristId(packet: SOSPacket): string | null {
  return packet?.nostrEvent?.tags.find((tag) => tag[0] === 'tourist')?.[1] ?? null;
}

/**
 * Decides whether a relayed packet may be accepted on the strength of its own
 * signature. On success it returns a packet rebuilt entirely from signed data.
 */
export function verifyRelayedPacket(
  packet: SOSPacket,
  tourist: Record<string, any> | null | undefined,
  now: number = Date.now()
): MeshTrustVerdict {
  const event = packet?.nostrEvent;
  if (!event) return { trusted: false, reason: 'Relayed packet carries no signed Nostr event.' };
  if (!verifyNostrSOSEvent(event)) {
    return { trusted: false, reason: 'Relayed packet failed Nostr event id or signature verification.' };
  }

  const createdAtMs = event.created_at * 1000;
  if (createdAtMs > now + MESH_EVENT_MAX_SKEW_MS) {
    return { trusted: false, reason: 'Relayed packet is dated in the future.' };
  }
  if (now - createdAtMs > MESH_EVENT_MAX_AGE_MS) {
    return { trusted: false, reason: 'Relayed packet is older than the mesh retention window.' };
  }

  const registered = registeredMeshPubkeys(tourist);
  if (registered.length === 0) {
    return { trusted: false, reason: 'This tourist has no registered mesh device key.' };
  }
  if (!registered.includes(event.pubkey.toLowerCase())) {
    return { trusted: false, reason: 'Relayed packet was signed by a key this tourist has not registered.' };
  }

  // Rebuilt from the signed event so hop metadata is the only thing the relay
  // chain was able to influence.
  const trustedPacket = fromNostrSOSEvent(event, {
    ttl: packet.ttl,
    hopCount: packet.hopCount,
    relayPath: packet.relayPath,
    lastKnownTransport: packet.lastKnownTransport,
  });

  if (trustedPacket.packetCategory !== 'SOS_ALERT') {
    return { trusted: false, reason: 'Only SOS alert packets can be relayed to the authority queue.' };
  }

  // The signature was checked against this record's keys, so the signed packet
  // must be for this record. Guards against a caller looking a packet up under
  // one tourist and having it accepted for another.
  if (tourist?.touristId && trustedPacket.touristId !== tourist.touristId) {
    return { trusted: false, reason: 'Relayed packet does not belong to the tourist it was verified against.' };
  }

  return { trusted: true, packet: trustedPacket };
}
