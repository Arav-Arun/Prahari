/**
 * Pure, hardware-independent portions of the Prahari BLE relay gateway.
 * The wire format is documented in README.md.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const FRAME_PREFIX = [0x50, 0x52, 1];
export const MAX_FRAME_BYTES = 20;
export const MAX_FRAME_PAYLOAD_BYTES = 15;
export const MAX_FRAMES = 255;
export const MAX_PACKET_BYTES = MAX_FRAMES * MAX_FRAME_PAYLOAD_BYTES;
export const DEFAULT_PACKET_TTL = 8;

/** Reassembles exactly one sequential BLE GATT writer at a time. */
export class FrameAssembler {
  #expectedCount = 0;
  #parts = [];

  reset() {
    this.#expectedCount = 0;
    this.#parts = [];
  }

  /**
   * Adds one validated GATT write. Returns null until all frames are present,
   * then returns the complete JSON UTF-8 payload. The BLE peripheral accepts
   * one active writer at a time, avoiding interleaved frame streams.
   */
  push(frame) {
    const bytes = Buffer.from(frame);
    if (bytes.length < 5 || bytes.length > MAX_FRAME_BYTES) throw new Error('Invalid BLE frame length.');
    if (bytes[0] !== FRAME_PREFIX[0] || bytes[1] !== FRAME_PREFIX[1] || bytes[2] !== FRAME_PREFIX[2]) {
      throw new Error('Unsupported Prahari BLE protocol version.');
    }
    const count = bytes[3];
    const index = bytes[4];
    if (count < 1 || count > MAX_FRAMES || index >= count) throw new Error('Invalid BLE frame sequence.');
    if (bytes.length - 5 > MAX_FRAME_PAYLOAD_BYTES) throw new Error('BLE frame exceeds the baseline MTU-safe payload.');

    if (index === 0) {
      this.#expectedCount = count;
      // Fill explicitly rather than using a sparse Array: Array#some skips
      // holes and would otherwise treat a partially received packet as whole.
      this.#parts = Array.from({ length: count }, () => null);
    }
    if (!this.#expectedCount) throw new Error('BLE sequence must begin with frame 0.');
    if (count !== this.#expectedCount) throw new Error('BLE frame-count mismatch.');

    const payload = bytes.subarray(5);
    const existing = this.#parts[index];
    if (existing && !existing.equals(payload)) throw new Error('Conflicting duplicate BLE frame.');
    this.#parts[index] = payload;
    if (this.#parts.some((part) => !part)) return null;

    const complete = Buffer.concat(this.#parts);
    this.reset();
    if (complete.length === 0 || complete.length > MAX_PACKET_BYTES) throw new Error('BLE packet size is invalid.');
    return complete;
  }
}

export function validateSosPacket(packet, now = Date.now()) {
  if (!packet || typeof packet !== 'object' || packet.version !== 1) throw new Error('Unsupported SOS packet.');
  for (const field of ['packetId', 'incidentId', 'touristId', 'originDeviceId']) {
    if (typeof packet[field] !== 'string' || !packet[field] || packet[field].length > 120) throw new Error(`Invalid ${field}.`);
  }
  if (!['SOS', 'PANIC', 'MEDICAL'].includes(packet.type)) throw new Error('Invalid SOS type.');
  if (!['CRITICAL', 'HIGH'].includes(packet.severity)) throw new Error('Invalid SOS severity.');
  if (typeof packet.latitude !== 'number' || !Number.isFinite(packet.latitude) || packet.latitude < -90 || packet.latitude > 90) throw new Error('Invalid SOS latitude.');
  if (typeof packet.longitude !== 'number' || !Number.isFinite(packet.longitude) || packet.longitude < -180 || packet.longitude > 180) throw new Error('Invalid SOS longitude.');
  if (typeof packet.timestamp !== 'number' || !Number.isFinite(packet.timestamp) || packet.timestamp <= 0) throw new Error('Invalid SOS timestamp.');
  if (typeof packet.expiresAt !== 'number' || !Number.isFinite(packet.expiresAt) || packet.expiresAt < packet.timestamp || now > packet.expiresAt) throw new Error('SOS packet expired.');
  if (!Number.isInteger(packet.ttl) || packet.ttl <= 0 || packet.ttl > DEFAULT_PACKET_TTL) throw new Error('Invalid SOS TTL.');
  if (!Number.isInteger(packet.hopCount) || packet.hopCount < 0 || packet.hopCount > DEFAULT_PACKET_TTL) throw new Error('Invalid SOS hop count.');
  if (!Array.isArray(packet.relayPath) || packet.relayPath.length > DEFAULT_PACKET_TTL + 1) throw new Error('Invalid SOS relay path.');
  if (packet.packetCategory && packet.packetCategory !== 'SOS_ALERT') throw new Error('Gateway accepts SOS alerts only.');
  return true;
}

export function packetForUplink(packet, gatewayId) {
  validateSosPacket(packet);
  if (typeof gatewayId !== 'string' || !gatewayId.trim() || gatewayId.length > 120) throw new Error('A stable gateway ID is required.');
  if (packet.ttl <= 1) throw new Error('SOS packet hop limit reached.');
  const relayPath = packet.relayPath.includes(gatewayId) ? packet.relayPath : [...packet.relayPath, gatewayId];
  return {
    ...packet,
    ttl: packet.ttl - 1,
    hopCount: packet.hopCount + 1,
    lastKnownTransport: 'BLE_RELAY',
    relayPath,
  };
}

/**
 * Tiny atomic on-disk queue. It persists accepted packets before GATT success
 * is acknowledged, and keeps recent terminal IDs to make gateway restarts
 * idempotent without retaining emergency payloads indefinitely.
 */
export class DurablePacketStore {
  #file;
  #state = { pending: {}, terminal: {} };

  constructor(file) {
    this.#file = file;
  }

  async open() {
    await mkdir(dirname(this.#file), { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.#file, 'utf8'));
      this.#state = {
        pending: parsed?.pending && typeof parsed.pending === 'object' ? parsed.pending : {},
        terminal: parsed?.terminal && typeof parsed.terminal === 'object' ? parsed.terminal : {},
      };
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await this.#prune();
  }

  async enqueue(packet) {
    if (this.#state.pending[packet.packetId] || this.#state.terminal[packet.packetId]) return false;
    this.#state.pending[packet.packetId] = packet;
    await this.#persist();
    return true;
  }

  pending() {
    return Object.values(this.#state.pending);
  }

  async markTerminal(packetId, status) {
    delete this.#state.pending[packetId];
    this.#state.terminal[packetId] = { status, at: Date.now() };
    await this.#prune();
    await this.#persist();
  }

  async #prune() {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (const [packetId, terminal] of Object.entries(this.#state.terminal)) {
      if (!terminal?.at || terminal.at < cutoff) delete this.#state.terminal[packetId];
    }
  }

  async #persist() {
    const temporary = `${this.#file}.tmp`;
    await writeFile(temporary, JSON.stringify(this.#state), { mode: 0o600 });
    await rename(temporary, this.#file);
  }
}
