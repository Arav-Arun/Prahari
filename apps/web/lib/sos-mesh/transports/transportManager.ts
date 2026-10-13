/**
 * SOS delivery coordinator.
 *
 * Internet is the complete, primary path, and no offline link is loaded or
 * queried while it works. When it fails, the packet is first written to this
 * browser's durable queue — nothing is ever handed to a relay without also
 * being kept here — and only then offered to the direct peer mesh and, if the
 * traveller paired one, a BLE relay gateway.
 */

import type { SOSTransport, TransportResult } from './types';
import { InternetTransport } from './internetTransport';
import { LocalTransport } from './localTransport';
import { SOSPacket } from '../sosPacket';
import { globalSOSStateMachine } from '../sosStateMachine';
import { getPendingQueuedPackets, updateQueuedPacketStatus } from '../indexedDbQueue';

type TransportLoader = () => Promise<SOSTransport | null>;

type SOSTransportManagerDependencies = {
  internetTransport?: InternetTransport;
  localTransport?: LocalTransport;
  loadBleTransport?: TransportLoader;
  loadPeerMeshTransport?: TransportLoader;
};

const loadOptionalBleTransport: TransportLoader = async () => {
  const { globalBleTransport } = await import('./bleTransport');
  return globalBleTransport;
};

// A paired phone over WebRTC. It reports itself unavailable until a pairing is
// open, so an unpaired traveller is never told a nearby device has the SOS.
const loadOptionalPeerMeshTransport: TransportLoader = async () => {
  const { globalWebRtcTransport } = await import('./webRtcTransport');
  return globalWebRtcTransport;
};

export class SOSTransportManager {
  private readonly internetTransport: InternetTransport;
  private readonly localTransport: LocalTransport;
  private readonly loadBleTransport: TransportLoader;
  private readonly loadPeerMeshTransport: TransportLoader;
  private isProcessingQueue = false;

  constructor(dependencies: SOSTransportManagerDependencies = {}) {
    this.internetTransport = dependencies.internetTransport ?? new InternetTransport();
    this.localTransport = dependencies.localTransport ?? new LocalTransport();
    this.loadBleTransport = dependencies.loadBleTransport ?? loadOptionalBleTransport;
    this.loadPeerMeshTransport = dependencies.loadPeerMeshTransport ?? loadOptionalPeerMeshTransport;

    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => {
        void this.flushQueuedPackets();
      });
    }
  }

  private async tryTransport(transport: SOSTransport, packet: SOSPacket): Promise<TransportResult | null> {
    try {
      if (!await transport.isAvailable()) return null;
      return await transport.send(packet);
    } catch (error: any) {
      return {
        success: false,
        channel: transport.name,
        error: error?.message || `${transport.name} transport failed unexpectedly.`,
      };
    }
  }

  private markDelivered(packet: SOSPacket, result: TransportResult): TransportResult {
    globalSOSStateMachine.transitionTo('DELIVERED', {
      incidentId: packet.incidentId,
      transport: 'INTERNET',
      message: result.message || 'SOS recorded directly in the Prahari authority queue via Internet.',
    });
    return result;
  }

  /**
   * Attempts an offline link that has been explicitly enabled. Returns null
   * when the link is disabled, absent, or reports itself unavailable.
   */
  private async tryOfflineLink(
    enabled: boolean,
    load: TransportLoader,
    packet: SOSPacket,
    tryingState: 'TRY_PEER_MESH' | 'TRY_BLE_RELAY'
  ): Promise<TransportResult | null> {
    if (!enabled) return null;
    try {
      const transport = await load();
      if (!transport) return null;
      globalSOSStateMachine.transitionTo(tryingState, { incidentId: packet.incidentId });
      const result = await this.tryTransport(transport, packet);
      return result?.success ? result : null;
    } catch {
      // Every offline link is optional. A missing API, an unsupported browser,
      // or a gateway error must never disturb the durable local fallback.
      return null;
    }
  }

  /**
   * Sends an SOS over the authenticated web API first. When that fails the
   * packet is persisted locally before any relay is tried, so a handoff to a
   * nearby device never becomes this browser's only copy.
   *
   * `allowBleRelay` stays opt-in: it needs a deliberately provisioned gateway.
   * `allowPeerMesh` is on by default but only does anything once the traveller
   * has actually paired a nearby device.
   */
  public async dispatch(
    packet: SOSPacket,
    { allowBleRelay = false, allowPeerMesh = true }: { allowBleRelay?: boolean; allowPeerMesh?: boolean } = {}
  ): Promise<TransportResult> {
    globalSOSStateMachine.transitionTo('TRY_INTERNET', {
      incidentId: packet.incidentId,
      message: 'Sending SOS directly to the Prahari authority queue…',
    });

    const internetResult = await this.tryTransport(this.internetTransport, packet);
    if (internetResult?.success) return this.markDelivered(packet, internetResult);

    // Durable first. Whatever happens on the radio, this device keeps a copy
    // and retries it the moment a network returns.
    const localResult = await this.tryTransport(this.localTransport, packet);

    // Other Prahari tabs in this browser relay it if they are online. Best
    // effort only: nobody may be listening, so it never counts as a handoff.
    if (typeof window !== 'undefined') {
      void import('./broadcastMeshTransport')
        .then(({ globalBroadcastMeshTransport }) => globalBroadcastMeshTransport.send(packet))
        .catch(() => undefined);
    }

    const peerResult = await this.tryOfflineLink(allowPeerMesh, this.loadPeerMeshTransport, packet, 'TRY_PEER_MESH');
    if (peerResult) {
      globalSOSStateMachine.transitionTo('RELAYED', {
        incidentId: packet.incidentId,
        transport: 'PEER_MESH',
        hopCount: packet.hopCount,
        message: peerResult.message || 'SOS handed to a nearby device on the direct peer mesh.',
      });
      return peerResult;
    }

    const bleResult = await this.tryOfflineLink(allowBleRelay, this.loadBleTransport, packet, 'TRY_BLE_RELAY');
    if (bleResult) {
      globalSOSStateMachine.transitionTo('RELAYED', {
        incidentId: packet.incidentId,
        transport: 'BLE_RELAY',
        hopCount: packet.hopCount,
        message: bleResult.message || 'SOS accepted by the optional BLE relay gateway.',
      });
      return bleResult;
    }

    if (localResult?.success) {
      globalSOSStateMachine.transitionTo('LOCAL_PERSISTED', {
        incidentId: packet.incidentId,
        transport: 'LOCAL_QUEUE',
        message: localResult.message || 'SOS saved locally and will retry when this browser reconnects.',
      });
      return localResult;
    }

    globalSOSStateMachine.transitionTo('DELIVERY_FAILED', {
      incidentId: packet.incidentId,
      message: localResult?.error || internetResult?.error || 'SOS could not be delivered or saved locally.',
    });
    return localResult ?? internetResult ?? {
      success: false,
      channel: 'LOCAL_QUEUE',
      error: 'SOS could not be delivered or saved locally.',
    };
  }

  /** Flushes browser-stored offline packets as soon as the web connection returns. */
  public async flushQueuedPackets(): Promise<{ processed: number; succeeded: number }> {
    if (this.isProcessingQueue) return { processed: 0, succeeded: 0 };
    this.isProcessingQueue = true;

    try {
      const pendingRecords = await getPendingQueuedPackets();
      let succeeded = 0;

      for (const record of pendingRecords) {
        const result = await this.tryTransport(this.internetTransport, record.packet);
        if (result?.success) {
          await updateQueuedPacketStatus(record.packetId, 'DELIVERED');
          succeeded += 1;
          this.markDelivered(record.packet, result);
        } else {
          await updateQueuedPacketStatus(record.packetId, record.status, result?.error || 'Internet is still unavailable.');
        }
      }

      return { processed: pendingRecords.length, succeeded };
    } catch (error) {
      console.error('[SOSTransportManager] Unable to flush the local SOS queue:', error);
      return { processed: 0, succeeded: 0 };
    } finally {
      this.isProcessingQueue = false;
    }
  }
}

export const globalTransportManager = new SOSTransportManager();
