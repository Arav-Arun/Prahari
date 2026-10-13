/**
 * Offline SOS Mesh — Compact Mesh Frame Codec
 *
 * Packs a signed Nostr event plus its mutable transport envelope into a tight
 * binary frame for radio and DataChannel links, roughly a third the size of the
 * equivalent JSON.
 *
 * The decoder rebuilds the signed tag array in exactly the order
 * `toNostrSOSEvent` produced it, so the far side recomputes a byte-identical
 * event id and can verify the origin's signature. Every field that feeds that
 * pre-image is carried explicitly — dropping one would silently break
 * verification and strip the packet of the incident it belongs to.
 *
 * TTL and hop count sit outside the signed region: they change at every relay,
 * and no relay holds a key to re-sign with.
 */

import {
  NostrSOSEvent,
  SOSPacket,
  canonicalCoord,
} from './sosPacket';

const MAGIC_HEADER = 0x4e4f; // 'NO'
const MESH_FRAME_VERSION = 2;

/** Smallest frame: fixed header + empty relay path + five empty strings + empty content + sig. */
const MIN_FRAME_LENGTH = 85 + 1 + 5 + 2 + 64;

/**
 * Relay provenance is unsigned metadata, so it is bounded rather than trusted:
 * a hostile peer cannot inflate a frame by inventing a long path.
 */
const MAX_RELAY_PATH_ENTRIES = 16;

const SEVERITY_HIGH_FLAG = 0x01;

interface MeshFrame {
  event: NostrSOSEvent;
  ttl: number;
  hopCount: number;
  /** Devices that have carried this packet. Unsigned provenance, not proof. */
  relayPath: string[];
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function hexToFixedBytes(hex: string, byteLength: number): Uint8Array {
  const out = new Uint8Array(byteLength);
  const clean = (hex ?? '').replace(/^0x/, '').toLowerCase();
  // An unsigned or malformed field is carried as zeroes rather than shifted
  // into place; verification then fails cleanly instead of on a mangled value.
  if (clean.length !== byteLength * 2 || !/^[0-9a-f]*$/.test(clean)) return out;
  for (let i = 0; i < byteLength; i++) {
    out[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}

function encodeShortString(value: string | undefined, field: string): Uint8Array {
  const bytes = textEncoder.encode(value ?? '');
  if (bytes.length > 255) throw new Error(`Mesh frame field "${field}" exceeds 255 bytes.`);
  return bytes;
}

function tagValue(event: NostrSOSEvent, key: string): string | undefined {
  return event.tags.find((tag) => tag[0] === key)?.[1];
}

/**
 * Packs a packet's signed event and current envelope into a single frame.
 */
export function packMeshFrame(packet: SOSPacket): Uint8Array {
  const event = packet.nostrEvent;
  if (!event) throw new Error('Cannot pack a mesh frame for a packet with no signed Nostr event.');

  const geohash = encodeShortString(tagValue(event, 'g'), 'g');
  const incidentId = encodeShortString(tagValue(event, 'inc'), 'inc');
  const touristId = encodeShortString(tagValue(event, 'tourist'), 'tourist');
  const originDeviceId = encodeShortString(tagValue(event, 'origin'), 'origin');
  const senderRole = encodeShortString(tagValue(event, 'role'), 'role');
  const senderName = encodeShortString(tagValue(event, 'sender'), 'sender');

  const content = textEncoder.encode(event.content ?? '');
  if (content.length > 0xffff) throw new Error('Mesh frame content exceeds 65535 bytes.');

  const relayPath = (packet.relayPath ?? [])
    .slice(-MAX_RELAY_PATH_ENTRIES)
    .map((node, index) => encodeShortString(node, `relayPath[${index}]`));

  const lat = canonicalCoord(parseFloat(tagValue(event, 'lat') ?? '0'));
  const lon = canonicalCoord(parseFloat(tagValue(event, 'lon') ?? '0'));

  const totalLength =
    85 +
    geohash.length +
    1 + relayPath.reduce((sum, node) => sum + 1 + node.length, 0) +
    1 + incidentId.length +
    1 + touristId.length +
    1 + originDeviceId.length +
    1 + senderRole.length +
    1 + senderName.length +
    2 + content.length +
    64;

  const bytes = new Uint8Array(totalLength);
  const view = new DataView(bytes.buffer);
  let offset = 0;

  view.setUint16(offset, MAGIC_HEADER, false); offset += 2;
  view.setUint8(offset, MESH_FRAME_VERSION); offset += 1;

  // Mutable envelope.
  view.setUint8(offset, Math.max(0, Math.min(255, packet.ttl))); offset += 1;
  view.setUint8(offset, Math.max(0, Math.min(255, packet.hopCount))); offset += 1;

  // Signed event.
  view.setUint16(offset, event.kind, false); offset += 2;
  view.setUint32(offset, Math.floor(event.created_at), false); offset += 4;
  bytes.set(hexToFixedBytes(event.pubkey, 32), offset); offset += 32;
  bytes.set(hexToFixedBytes(event.id, 32), offset); offset += 32;
  view.setInt32(offset, Math.round(lat * 1e7), false); offset += 4;
  view.setInt32(offset, Math.round(lon * 1e7), false); offset += 4;
  view.setUint8(offset, tagValue(event, 't') === 'HIGH' ? SEVERITY_HIGH_FLAG : 0); offset += 1;

  view.setUint8(offset, geohash.length); offset += 1;
  bytes.set(geohash, offset); offset += geohash.length;

  for (const field of [incidentId, touristId, originDeviceId, senderRole, senderName]) {
    view.setUint8(offset, field.length); offset += 1;
    bytes.set(field, offset); offset += field.length;
  }

  view.setUint16(offset, content.length, false); offset += 2;
  bytes.set(content, offset); offset += content.length;

  // Unsigned envelope tail: who carried this, in order.
  view.setUint8(offset, relayPath.length); offset += 1;
  for (const node of relayPath) {
    view.setUint8(offset, node.length); offset += 1;
    bytes.set(node, offset); offset += node.length;
  }

  bytes.set(hexToFixedBytes(event.sig, 64), offset);

  return bytes;
}

/**
 * Decodes a frame back into a signed event and its envelope. Returns null for
 * anything that is not a well-formed Prahari mesh frame.
 */
export function unpackMeshFrame(buffer: Uint8Array): MeshFrame | null {
  try {
    if (buffer.length < MIN_FRAME_LENGTH) return null;

    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    let offset = 0;

    if (view.getUint16(offset, false) !== MAGIC_HEADER) return null;
    offset += 2;
    if (view.getUint8(offset) !== MESH_FRAME_VERSION) return null;
    offset += 1;

    const ttl = view.getUint8(offset); offset += 1;
    const hopCount = view.getUint8(offset); offset += 1;

    const kind = view.getUint16(offset, false); offset += 2;
    const createdAt = view.getUint32(offset, false); offset += 4;
    const pubkey = bytesToHex(buffer.subarray(offset, offset + 32)); offset += 32;
    const id = bytesToHex(buffer.subarray(offset, offset + 32)); offset += 32;
    const lat = view.getInt32(offset, false) / 1e7; offset += 4;
    const lon = view.getInt32(offset, false) / 1e7; offset += 4;
    const flags = view.getUint8(offset); offset += 1;

    const readShortString = (): string | null => {
      if (offset + 1 > buffer.length) return null;
      const length = view.getUint8(offset); offset += 1;
      if (offset + length > buffer.length) return null;
      const value = textDecoder.decode(buffer.subarray(offset, offset + length));
      offset += length;
      return value;
    };

    const geohash = readShortString();
    const incidentId = readShortString();
    const touristId = readShortString();
    const originDeviceId = readShortString();
    const senderRole = readShortString();
    const senderName = readShortString();
    if (geohash === null || incidentId === null || touristId === null
      || originDeviceId === null || senderRole === null || senderName === null) return null;

    if (offset + 2 > buffer.length) return null;
    const contentLength = view.getUint16(offset, false); offset += 2;
    if (offset + contentLength > buffer.length) return null;
    const content = textDecoder.decode(buffer.subarray(offset, offset + contentLength));
    offset += contentLength;

    if (offset + 1 > buffer.length) return null;
    const relayPathLength = view.getUint8(offset); offset += 1;
    if (relayPathLength > MAX_RELAY_PATH_ENTRIES) return null;
    const relayPath: string[] = [];
    for (let i = 0; i < relayPathLength; i++) {
      const node = readShortString();
      if (node === null) return null;
      relayPath.push(node);
    }

    if (offset + 64 > buffer.length) return null;
    const sig = bytesToHex(buffer.subarray(offset, offset + 64));

    // Rebuilt in the exact order toNostrSOSEvent emits, so the recomputed id
    // matches the origin's and the signature verifies.
    const tags: string[][] = [
      ['g', geohash],
      ['t', flags & SEVERITY_HIGH_FLAG ? 'HIGH' : 'CRITICAL'],
      ['inc', incidentId],
      ['tourist', touristId],
      ['lat', lat.toString()],
      ['lon', lon.toString()],
      ['origin', originDeviceId],
    ];
    if (senderRole) tags.push(['role', senderRole]);
    if (senderName) tags.push(['sender', senderName]);

    return {
      ttl,
      hopCount,
      relayPath,
      event: { id, pubkey, created_at: createdAt, kind, tags, content, sig },
    };
  } catch (err) {
    console.warn('[nostrEncoder] Failed to unpack mesh frame:', err);
    return null;
  }
}
