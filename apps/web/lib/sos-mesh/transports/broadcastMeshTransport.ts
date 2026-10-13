/**
 * Same-browser relay. An SOS raised in one Prahari tab is announced to other
 * Prahari tabs in this browser (BroadcastChannel and a storage event), and any
 * tab that is online verifies the signature and uploads it to /api/sos-relay.
 * It cannot reach another device; the WebRTC transport does that.
 */

import { SOSTransport, TransportResult } from './types';
import { SOSPacket, fromNostrSOSEvent, verifyNostrSOSEvent } from '../sosPacket';
import { packMeshFrame, unpackMeshFrame } from '../nostrEncoder';
import { saveQueuedPacket } from '../indexedDbQueue';

const MESH_CHANNEL_NAME = 'prahari_bitchat_mesh_v1';
const LOCAL_STORAGE_KEY = 'prahari_mesh_broadcast_bus';

const seenPacketIds = new Set<string>();
let broadcastChannel: BroadcastChannel | null = null;
let isListenerActive = false;

function getChannel(): BroadcastChannel | null {
  if (typeof window === 'undefined') return null;
  if (!broadcastChannel && typeof BroadcastChannel !== 'undefined') {
    try {
      broadcastChannel = new BroadcastChannel(MESH_CHANNEL_NAME);
    } catch {
      broadcastChannel = null;
    }
  }
  return broadcastChannel;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Starts background listening on any active client.
 * Any device receiving a nearby SOS broadcast will verify its signature and,
 * if connected to a network, immediately forward it to Police HQ.
 */
export function startMeshBroadcastListener(onRelaySuccess?: (packet: SOSPacket) => void): () => void {
  if (typeof window === 'undefined' || isListenerActive) return () => {};
  isListenerActive = true;

  const handleIncomingFrame = async (hexFrame: string) => {
    try {
      if (!hexFrame || typeof hexFrame !== 'string') return;
      const frameBuffer = hexToBytes(hexFrame);
      const frame = unpackMeshFrame(frameBuffer);
      if (!frame || !frame.event) return;

      const event = frame.event;
      if (!verifyNostrSOSEvent(event)) {
        console.warn('[BitChat Mesh] Rejected invalid/tampered mesh broadcast');
        return;
      }

      // Rebuild full packet from signed event
      const packet = fromNostrSOSEvent(event, {
        ttl: frame.ttl,
        hopCount: frame.hopCount,
        relayPath: frame.relayPath,
      });

      // Deduplicate multi-hop duplicates
      if (seenPacketIds.has(packet.packetId)) return;
      seenPacketIds.add(packet.packetId);
      if (seenPacketIds.size > 1000) {
        const first = seenPacketIds.values().next().value;
        if (first) seenPacketIds.delete(first);
      }

      console.info(`[BitChat Mesh] Received valid offline SOS broadcast from ${packet.touristId} (${packet.incidentId})`);

      // If this device is online, relay immediately to Police HQ
      if (navigator.onLine) {
        const relayResponse = await fetch('/api/sos-relay', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            packet: {
              ...packet,
              hopCount: (packet.hopCount || 0) + 1,
              relayPath: [...(packet.relayPath || []), 'WIFI_BROADCAST_NODE'],
            },
          }),
        }).catch(() => null);

        if (relayResponse?.ok) {
          console.info(`[BitChat Mesh] Relayed ${packet.incidentId} to the authority desk.`);
          onRelaySuccess?.(packet);
          return;
        }
      }

      // If this device is offline, store in local IndexedDB so it flushes when this device reconnects
      await saveQueuedPacket(
        {
          ...packet,
          hopCount: (packet.hopCount || 0) + 1,
          relayPath: [...(packet.relayPath || []), 'OFFLINE_RETAINED_NODE'],
        },
        'QUEUED'
      );
    } catch (err) {
      console.warn('[BitChat Mesh] Listener error:', err);
    }
  };

  // 1. Listen on BroadcastChannel
  const channel = getChannel();
  const channelHandler = (event: MessageEvent) => {
    if (event.data?.type === 'BITCHAT_SOS_FRAME' && event.data?.frame) {
      void handleIncomingFrame(event.data.frame);
    }
  };
  channel?.addEventListener('message', channelHandler);

  // 2. Listen on localStorage event bus (cross-tab / local network fallback)
  const storageHandler = (event: StorageEvent) => {
    if (event.key === LOCAL_STORAGE_KEY && event.newValue) {
      void handleIncomingFrame(event.newValue);
    }
  };
  window.addEventListener('storage', storageHandler);

  return () => {
    channel?.removeEventListener('message', channelHandler);
    window.removeEventListener('storage', storageHandler);
    isListenerActive = false;
  };
}

class BroadcastMeshTransport implements SOSTransport {
  public readonly name = 'PEER_MESH';

  public async isAvailable(): Promise<boolean> {
    return typeof window !== 'undefined';
  }

  public async send(packet: SOSPacket): Promise<TransportResult> {
    try {
      const frameBuffer = packMeshFrame(packet);
      const hexFrame = bytesToHex(frameBuffer);
      seenPacketIds.add(packet.packetId);

      // Broadcast over BroadcastChannel
      const channel = getChannel();
      channel?.postMessage({
        type: 'BITCHAT_SOS_FRAME',
        frame: hexFrame,
        timestamp: Date.now(),
      });

      // Broadcast over localStorage event bus for cross-tab / local network sync
      try {
        localStorage.setItem(LOCAL_STORAGE_KEY, hexFrame);
        setTimeout(() => localStorage.removeItem(LOCAL_STORAGE_KEY), 500);
      } catch {}

      return {
        success: true,
        channel: 'PEER_MESH',
        message: 'SOS shared with other Prahari tabs in this browser.',
        incidentId: packet.incidentId,
        transmittedAt: Date.now(),
      };
    } catch (err: any) {
      return {
        success: false,
        channel: 'PEER_MESH',
        error: err.message || 'Could not broadcast SOS over local mesh.',
      };
    }
  }
}

export const globalBroadcastMeshTransport = new BroadcastMeshTransport();
