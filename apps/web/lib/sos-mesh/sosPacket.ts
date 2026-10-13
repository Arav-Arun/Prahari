/**
 * Offline SOS Mesh — Versioned Emergency SOS Packet & Nostr NIP-01 Protocol Bridge
 * 
 * Inspired by BitChat's minimal wire protocol principles and Nostr's NIP-01 event standard.
 * Contains non-PII opaque routing metadata, coordinates, and zero-trust cryptographic signatures.
 */

import { sha256, toUtf8Bytes } from 'ethers';
import { getDevicePubkey, signEventId, verifyEventSignature } from './nostrKeys';
import { newIncidentId } from '../ids';

/** NIP-01 kind numbers used by the Prahari mesh. */
const NOSTR_KIND_SOS_ALERT = 20000;
const NOSTR_KIND_MESH_CHAT = 20001;

export interface NostrSOSEvent {
  id: string; // 32-byte sha256 hex hash of serialized [0, pubkey, created_at, kind, tags, content]
  pubkey: string; // 32-byte hex public key of sender/tourist
  created_at: number; // UTC epoch timestamp in seconds
  kind: number; // 20000 = Emergency SOS Alert, 20001 = Emergency Mesh Chat
  // Signed pre-image. Hop and TTL are deliberately absent: they change on every
  // relay, and a relay holds no key with which to re-sign the event.
  tags: string[][]; // e.g. [["g", "te7u81"], ["t", "CRITICAL"], ["inc", "INC-1234"], ["tourist", "TOUR-7890"]]
  content: string; // Payload content or encrypted message
  sig: string; // 64-byte Schnorr/ECDSA signature hex over event id
}

export interface SOSPacket {
  version: number;
  packetId: string;
  incidentId: string;
  touristId: string; // Opaque tourist ID (e.g. TOUR-7890 or pubkey hash)
  type: 'SOS' | 'PANIC' | 'MEDICAL';
  severity: 'CRITICAL' | 'HIGH';
  latitude: number | null;
  longitude: number | null;
  accuracy: number;
  timestamp: number; // UTC epoch millis
  expiresAt: number; // UTC epoch millis (packet expiration)
  ttl: number; // Time To Live (max remaining hops)
  hopCount: number; // Hops taken so far
  originDeviceId: string; // Ephemeral/opaque device ID
  lastKnownTransport: 'INTERNET' | 'SMS' | 'BLE_RELAY' | 'LOCAL_QUEUE';
  relayPath: string[]; // List of relay node IDs e.g. ["DEV-ORIGIN", "RELAY-B82F"]
  signature?: string; // Optional checksum / Nostr signature
  packetCategory?: 'SOS_ALERT' | 'CHAT_MESSAGE';
  chatText?: string;
  senderRole?: 'tourist' | 'authority';
  senderName?: string;
  chatLanguage?: string;
  originalText?: string;
  originalLanguage?: string;
  nostrEvent?: NostrSOSEvent; // Integrated Nostr NIP-01 Event structure
}

const CURRENT_PACKET_VERSION = 1;
const DEFAULT_PACKET_TTL = 8;
const DEFAULT_PACKET_LIFESPAN_MS = 24 * 60 * 60 * 1000; // 24 hours

function encodeGeohash(lat: number, lon: number, precision: number = 6): string {
  const B32 = '0123456789bcdefghjkmnpqrstuvwxyz';
  let latMin = -90, latMax = 90;
  let lonMin = -180, lonMax = 180;
  let geohash = '';
  let bit = 0;
  let ch = 0;
  let isEven = true;

  while (geohash.length < precision) {
    if (isEven) {
      const mid = (lonMin + lonMax) / 2;
      if (lon >= mid) {
        ch |= 1 << (4 - bit);
        lonMin = mid;
      } else {
        lonMax = mid;
      }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) {
        ch |= 1 << (4 - bit);
        latMin = mid;
      } else {
        latMax = mid;
      }
    }
    isEven = !isEven;
    if (bit < 4) {
      bit++;
    } else {
      geohash += B32[ch];
      bit = 0;
      ch = 0;
    }
  }
  return geohash;
}

export function calculateNostrEventId(
  pubkey: string,
  createdAt: number,
  kind: number,
  tags: string[][],
  content: string
): string {
  const serialized = JSON.stringify([0, pubkey, createdAt, kind, tags, content]);
  const hashHex = sha256(toUtf8Bytes(serialized));
  return hashHex.replace(/^0x/, '');
}

/**
 * Coordinates are pinned to 7 decimal places (~1 cm) before they enter the
 * signed pre-image, so the compact binary codec can carry them as scaled
 * int32s and rebuild a byte-identical event id on the far side of a hop.
 */
export function canonicalCoord(value: number): number {
  return Math.round(value * 1e7) / 1e7;
}

/**
 * Builds and signs the immutable Nostr event for a packet. Called once, by the
 * originating device. Relays forward the result verbatim.
 */
function toNostrSOSEvent(packet: SOSPacket, pubkeyHex?: string, signatureHex?: string): NostrSOSEvent {
  const pubkey = pubkeyHex ?? getDevicePubkey() ?? '';
  const createdAt = Math.floor(packet.timestamp / 1000);
  const kind = packet.packetCategory === 'CHAT_MESSAGE' ? NOSTR_KIND_MESH_CHAT : NOSTR_KIND_SOS_ALERT;
  const lat = canonicalCoord(packet.latitude ?? 0);
  const lon = canonicalCoord(packet.longitude ?? 0);
  const geohash = encodeGeohash(lat, lon, 6);

  // This tag order is part of the signed pre-image. Any change here must be
  // mirrored in nostrEncoder's frame layout, or a relayed event will rebuild to
  // a different id and be dropped as unverifiable.
  const tags: string[][] = [
    ['g', geohash],
    ['t', packet.severity],
    ['inc', packet.incidentId],
    ['tourist', packet.touristId],
    ['lat', lat.toString()],
    ['lon', lon.toString()],
    ['origin', packet.originDeviceId],
  ];

  if (packet.senderRole) tags.push(['role', packet.senderRole]);
  if (packet.senderName) tags.push(['sender', packet.senderName]);

  const content = packet.packetCategory === 'CHAT_MESSAGE'
    ? (packet.chatText ?? '')
    : JSON.stringify({
        type: packet.type,
        severity: packet.severity,
        accuracy: packet.accuracy,
        expiresAt: packet.expiresAt,
      });

  const id = calculateNostrEventId(pubkey, createdAt, kind, tags, content);
  // An unsigned event is left with an empty signature rather than a plausible
  // looking one. verifyNostrSOSEvent rejects it, which is the honest outcome
  // when no device identity exists (server-side rendering).
  const sig = signatureHex ?? signEventId(id) ?? '';

  return {
    id,
    pubkey,
    created_at: createdAt,
    kind,
    tags,
    content,
    sig,
  };
}

/** Mutable per-hop transport metadata carried alongside the signed event. */
interface MeshEnvelope {
  ttl: number;
  hopCount: number;
  relayPath?: string[];
  lastKnownTransport?: SOSPacket['lastKnownTransport'];
}

/**
 * Rebuilds a packet from a received event. Envelope fields come from the wire
 * frame; everything identifying comes from the signed tags, so a relayed SOS
 * keeps the incident and tourist it was raised for.
 */
export function fromNostrSOSEvent(event: NostrSOSEvent, envelope?: Partial<MeshEnvelope>): SOSPacket {
  const getTag = (key: string) => event.tags.find((t) => t[0] === key)?.[1];
  const isChat = event.kind === NOSTR_KIND_MESH_CHAT;
  const origin = getTag('origin') ?? `NODE-${event.pubkey.substring(0, 6).toUpperCase()}`;
  const lat = parseFloat(getTag('lat') ?? '0');
  const lon = parseFloat(getTag('lon') ?? '0');

  let type: SOSPacket['type'] = 'PANIC';
  let accuracy = 10;
  let expiresAt = event.created_at * 1000 + DEFAULT_PACKET_LIFESPAN_MS;
  if (!isChat && event.content) {
    try {
      const parsed = JSON.parse(event.content);
      if (parsed?.type === 'SOS' || parsed?.type === 'PANIC' || parsed?.type === 'MEDICAL') type = parsed.type;
      if (typeof parsed?.accuracy === 'number') accuracy = parsed.accuracy;
      if (typeof parsed?.expiresAt === 'number') expiresAt = parsed.expiresAt;
    } catch {
      // A malformed content body still yields a routable packet; the signed
      // tags carry everything the authority queue actually needs.
    }
  }

  return {
    version: CURRENT_PACKET_VERSION,
    // Derived from the immutable event id, so the same alert arriving by two
    // routes collapses to one packet id.
    packetId: `PKT-${event.id.substring(0, 12).toUpperCase()}`,
    incidentId: getTag('inc') ?? `INC-${event.id.substring(0, 6).toUpperCase()}`,
    touristId: getTag('tourist') ?? `TOUR-${event.pubkey.substring(0, 8).toUpperCase()}`,
    type,
    severity: getTag('t') === 'HIGH' ? 'HIGH' : 'CRITICAL',
    latitude: lat,
    longitude: lon,
    accuracy,
    timestamp: event.created_at * 1000,
    expiresAt,
    ttl: envelope?.ttl ?? DEFAULT_PACKET_TTL,
    hopCount: envelope?.hopCount ?? 0,
    originDeviceId: origin,
    lastKnownTransport: envelope?.lastKnownTransport ?? 'BLE_RELAY',
    relayPath: envelope?.relayPath ?? [origin],
    signature: event.sig,
    packetCategory: isChat ? 'CHAT_MESSAGE' : 'SOS_ALERT',
    chatText: isChat ? event.content : undefined,
    senderRole: (getTag('role') as SOSPacket['senderRole']) ?? 'tourist',
    senderName: getTag('sender'),
    nostrEvent: event,
  };
}

/**
 * Full zero-trust check: the event id must be the hash of its own contents,
 * and the BIP-340 signature must verify against the embedded pubkey. A relay
 * that alters a single tag, coordinate, or byte of content fails here.
 */
export function verifyNostrSOSEvent(event: NostrSOSEvent): boolean {
  if (!event || !event.id || !event.pubkey || !event.sig) return false;
  const expectedId = calculateNostrEventId(event.pubkey, event.created_at, event.kind, event.tags, event.content);
  if (expectedId !== event.id) return false;
  return verifyEventSignature(event.sig, event.id, event.pubkey);
}

/** Stable mesh-wide identity for a packet, used for relay deduplication. */
export function meshEventId(packet: SOSPacket): string {
  return packet.nostrEvent?.id ?? packet.packetId;
}

export function createSOSPacket(params: {
  touristId: string;
  latitude: number;
  longitude: number;
  accuracy?: number;
  incidentId?: string;
  type?: 'SOS' | 'PANIC' | 'MEDICAL';
  severity?: 'CRITICAL' | 'HIGH';
  originDeviceId?: string;
  ttl?: number;
}): SOSPacket {
  const now = Date.now();
  const incidentId = params.incidentId ?? newIncidentId();
  const packetId = `PKT-${Math.random().toString(36).substring(2, 10).toUpperCase()}`;
  const originDeviceId = params.originDeviceId ?? getOrCreateDeviceId();

  const packet: SOSPacket = {
    version: CURRENT_PACKET_VERSION,
    packetId,
    incidentId,
    touristId: params.touristId,
    type: params.type ?? 'PANIC',
    severity: params.severity ?? 'CRITICAL',
    latitude: params.latitude,
    longitude: params.longitude,
    accuracy: params.accuracy ?? 10,
    timestamp: now,
    expiresAt: now + DEFAULT_PACKET_LIFESPAN_MS,
    ttl: params.ttl ?? DEFAULT_PACKET_TTL,
    hopCount: 0,
    originDeviceId,
    lastKnownTransport: 'LOCAL_QUEUE',
    relayPath: [originDeviceId],
    packetCategory: 'SOS_ALERT',
  };

  packet.nostrEvent = toNostrSOSEvent(packet);
  return packet;
}

export function createChatPacket(params: {
  incidentId: string;
  touristId: string;
  senderRole: 'tourist' | 'authority';
  senderName: string;
  text: string;
  /** ISO-style language code of the text actually delivered to the recipient. */
  language?: string;
  /** Officer-authored original retained alongside an AI translation. */
  originalText?: string;
  originalLanguage?: string;
  latitude?: number;
  longitude?: number;
  originDeviceId?: string;
}): SOSPacket {
  const now = Date.now();
  const packetId = `CHAT-${Math.random().toString(36).substring(2, 10).toUpperCase()}`;
  const originDeviceId = params.originDeviceId ?? getOrCreateDeviceId();

  const packet: SOSPacket = {
    version: CURRENT_PACKET_VERSION,
    packetId,
    incidentId: params.incidentId,
    touristId: params.touristId,
    type: 'PANIC',
    severity: 'HIGH',
    latitude: params.latitude ?? 19.0728,
    longitude: params.longitude ?? 72.8997,
    accuracy: 10,
    timestamp: now,
    expiresAt: now + DEFAULT_PACKET_LIFESPAN_MS,
    ttl: DEFAULT_PACKET_TTL,
    hopCount: 0,
    originDeviceId,
    lastKnownTransport: 'LOCAL_QUEUE',
    relayPath: [originDeviceId],
    packetCategory: 'CHAT_MESSAGE',
    chatText: params.text,
    senderRole: params.senderRole,
    senderName: params.senderName,
    chatLanguage: params.language,
    originalText: params.originalText,
    originalLanguage: params.originalLanguage,
  };

  packet.nostrEvent = toNostrSOSEvent(packet);
  return packet;
}

export function isValidSOSPacket(packet: any): packet is SOSPacket {
  if (!packet || typeof packet !== 'object') return false;
  if (typeof packet.version !== 'number' || packet.version <= 0) return false;
  if (typeof packet.packetId !== 'string' || !packet.packetId) return false;
  if (typeof packet.incidentId !== 'string' || !packet.incidentId) return false;
  if (typeof packet.touristId !== 'string' || !packet.touristId) return false;
  if (typeof packet.timestamp !== 'number' || packet.timestamp <= 0) return false;
  if (typeof packet.ttl !== 'number' || packet.ttl < 0) return false;
  if (typeof packet.hopCount !== 'number' || packet.hopCount < 0) return false;
  return true;
}

export function isPacketExpired(packet: SOSPacket, now: number = Date.now()): boolean {
  if (packet.ttl <= 0) return true;
  if (packet.expiresAt && now > packet.expiresAt) return true;
  return false;
}

export function incrementPacketHop(packet: SOSPacket, relayDeviceId: string, transport: 'BLE_RELAY' | 'SMS' | 'INTERNET'): SOSPacket {
  const updatedPath = packet.relayPath ? [...packet.relayPath] : [packet.originDeviceId];
  if (!updatedPath.includes(relayDeviceId)) {
    updatedPath.push(relayDeviceId);
  }
  // The signed event is carried through untouched. A relay holds no key to
  // re-sign with, and a mutating event id would defeat mesh deduplication, so
  // hop and TTL live only in this transport envelope.
  return {
    ...packet,
    ttl: Math.max(0, packet.ttl - 1),
    hopCount: packet.hopCount + 1,
    lastKnownTransport: transport,
    relayPath: updatedPath,
  };
}

export function serializeSOSPacket(packet: SOSPacket): string {
  return JSON.stringify(packet);
}

export function deserializeSOSPacket(raw: string): SOSPacket | null {
  try {
    const parsed = JSON.parse(raw);
    if (isValidSOSPacket(parsed)) return parsed;
    return null;
  } catch {
    return null;
  }
}

export function getOrCreateDeviceId(): string {
  if (typeof window === 'undefined') return 'NODE-SERVER';
  try {
    let deviceId = localStorage.getItem('prahari_device_id');
    if (!deviceId) {
      deviceId = `NODE-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
      localStorage.setItem('prahari_device_id', deviceId);
    }
    return deviceId;
  } catch {
    return `NODE-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
  }
}
