/**
 * Offline SOS Mesh — Zero-Trust Store-and-Forward Relay Engine
 *
 * Runs on any device acting as an opportunistic relay. Every packet is checked
 * against the origin's BIP-340 signature before it is stored or forwarded, so a
 * relay carries traffic it cannot forge, alter, or attribute to itself.
 *
 * The engine owns store-and-forward but knows nothing about links. Transports
 * register themselves as forwarders, which keeps the dependency one-way and
 * lets a peer mesh, a BLE gateway, or a future native radio plug in
 * interchangeably.
 */

import {
  SOSPacket,
  isPacketExpired,
  incrementPacketHop,
  getOrCreateDeviceId,
  meshEventId,
  verifyNostrSOSEvent,
} from '../sosPacket';
import { hasSeenPacket, markPacketAsSeen, saveQueuedPacket } from '../indexedDbQueue';
import { BloomFilter } from '../bloomFilter';

interface RelayEvent {
  type: 'PACKET_RECEIVED' | 'PACKET_FORWARDED' | 'DUPLICATE_DROPPED' | 'EXPIRED_DROPPED' | 'INVALID_SIGNATURE_DROPPED';
  packetId: string;
  hopCount: number;
  timestamp: number;
  relayDeviceId: string;
  detail?: string;
}

type RelayOutcome = { action: 'RELAYED' | 'DROPPED' | 'UPLOADED'; reason?: string };

/** Returns how many peers accepted the packet. */
type MeshForwarder = (packet: SOSPacket) => Promise<number> | number;

class BLERelayEngine {
  private isEnabled = true;
  private eventListeners: Set<(event: RelayEvent) => void> = new Set();
  private forwarders: Set<MeshForwarder> = new Set();
  private localBloomFilter = new BloomFilter();

  public isRelayActive(): boolean {
    return this.isEnabled;
  }

  public setRelayActive(active: boolean) {
    this.isEnabled = active;
  }

  public subscribe(listener: (event: RelayEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /** Registers a link that can carry packets onward. Returns an unregister fn. */
  public registerForwarder(forwarder: MeshForwarder): () => void {
    this.forwarders.add(forwarder);
    return () => this.forwarders.delete(forwarder);
  }

  public getBloomFilter(): BloomFilter {
    return this.localBloomFilter;
  }

  private drop(type: RelayEvent['type'], packet: SOSPacket, deviceId: string, detail: string, reason: string): RelayOutcome {
    this.emit({ type, packetId: packet.packetId, hopCount: packet.hopCount, timestamp: Date.now(), relayDeviceId: deviceId, detail });
    return { action: 'DROPPED', reason };
  }

  /**
   * Processes a packet received from any mesh link.
   */
  public async handleIncomingPacket(packet: SOSPacket): Promise<RelayOutcome> {
    if (!this.isEnabled) {
      return { action: 'DROPPED', reason: 'Emergency Relay Mode disabled on this device.' };
    }

    const currentDeviceId = getOrCreateDeviceId();

    // 1. Expiration & TTL.
    if (isPacketExpired(packet)) {
      return this.drop('EXPIRED_DROPPED', packet, currentDeviceId,
        'Packet TTL reached 0 or timestamp expired.', 'Packet expired or max hops reached.');
    }

    // 2. Zero-trust verification. An unsigned packet is not relayable: without a
    // signature there is nothing tying it to a traveller, and forwarding it
    // would let any node inject incidents into the mesh.
    if (!packet.nostrEvent || !verifyNostrSOSEvent(packet.nostrEvent)) {
      return this.drop('INVALID_SIGNATURE_DROPPED', packet, currentDeviceId,
        'Nostr event id or BIP-340 signature failed verification.', 'Invalid cryptographic signature.');
    }

    // 3. Deduplication on the immutable event id. The Bloom filter is only a
    // fast negative; the durable seen-set is always consulted, so a page reload
    // that empties the in-memory filter cannot reopen a relay loop.
    const eventId = meshEventId(packet);
    if (await hasSeenPacket(packet.packetId, eventId)) {
      return this.drop('DUPLICATE_DROPPED', packet, currentDeviceId,
        'Packet already processed by this node.', 'Duplicate packet already seen.');
    }

    this.localBloomFilter.add(eventId);
    await markPacketAsSeen(packet.packetId, eventId);

    this.emit({
      type: 'PACKET_RECEIVED',
      packetId: packet.packetId,
      hopCount: packet.hopCount,
      timestamp: Date.now(),
      relayDeviceId: currentDeviceId,
    });

    // 4. Store locally before anything else, so the packet survives even if
    // this device loses power before it can forward or upload.
    const updatedPacket = incrementPacketHop(packet, currentDeviceId, 'BLE_RELAY');
    await saveQueuedPacket(updatedPacket, 'QUEUED');

    // 5. If this node has a network, it is the mesh's exit point.
    if (typeof navigator !== 'undefined' && navigator.onLine) {
      try {
        const res = await fetch('/api/sos-relay', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ packet: updatedPacket }),
        });

        if (res.ok) {
          await saveQueuedPacket(updatedPacket, 'DELIVERED');
          this.emit({
            type: 'PACKET_FORWARDED',
            packetId: updatedPacket.packetId,
            hopCount: updatedPacket.hopCount,
            timestamp: Date.now(),
            relayDeviceId: currentDeviceId,
            detail: 'Relayed to the authority gateway over this device’s internet connection.',
          });
          return { action: 'UPLOADED', reason: 'Relayed to the authority gateway over internet.' };
        }
      } catch (err) {
        console.warn('[BLERelayEngine] Gateway upload failed, keeping in local queue:', err);
      }
    }

    // 6. No network here: hand it to every other link this device holds.
    const peersReached = await this.forwardToPeers(updatedPacket);

    this.emit({
      type: 'PACKET_FORWARDED',
      packetId: updatedPacket.packetId,
      hopCount: updatedPacket.hopCount,
      timestamp: Date.now(),
      relayDeviceId: currentDeviceId,
      detail: `Forwarded to ${peersReached} nearby device${peersReached === 1 ? '' : 's'}.`,
    });

    return { action: 'RELAYED', reason: 'Packet verified, stored locally, and forwarded to the mesh.' };
  }

  /**
   * Fans a packet out across every registered link. A packet whose TTL is spent
   * is still stored, but is not put back on the air.
   */
  public async forwardToPeers(packet: SOSPacket): Promise<number> {
    if (packet.ttl <= 0) return 0;

    const results = await Promise.all(
      Array.from(this.forwarders).map(async (forward) => {
        try {
          return await forward(packet);
        } catch (err) {
          console.warn('[BLERelayEngine] Forwarder failed:', err);
          return 0;
        }
      })
    );
    return results.reduce((total, count) => total + count, 0);
  }

  private emit(event: RelayEvent) {
    this.eventListeners.forEach((listener) => {
      try { listener(event); } catch (err) { console.error('[BLERelayEngine] Listener error:', err); }
    });
  }
}

export const globalBLERelayEngine = new BLERelayEngine();
