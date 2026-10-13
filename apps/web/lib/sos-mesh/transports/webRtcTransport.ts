/**
 * Offline SOS Mesh — Direct Peer WebRTC DataChannel Transport
 *
 * A browser cannot advertise as a BLE peripheral, so this is the real
 * phone-to-phone link in the mesh. Two devices exchange an SDP offer/answer
 * pair out of band (QR code or copied text) and then hold an encrypted
 * DataChannel open over local Wi-Fi, a hotspot, or any shared LAN — no server
 * and no internet once the handshake is done.
 *
 * Packets cross the wire as signed binary mesh frames. Verification, storage,
 * and onward forwarding all belong to the relay engine; this file is only the
 * link.
 */

import { SOSTransport, TransportResult } from './types';
import { SOSPacket, fromNostrSOSEvent, meshEventId, verifyNostrSOSEvent } from '../sosPacket';
import { packMeshFrame, unpackMeshFrame } from '../nostrEncoder';
import { BloomFilter, MESH_BLOOM_HASHES, MESH_BLOOM_SIZE_BITS } from '../bloomFilter';
import { globalBLERelayEngine } from '../ble/bleRelay';
import { getAllQueuedPackets } from '../indexedDbQueue';

export interface PeerMeshInfo {
  peerId: string;
  connectedAt: number;
  status: 'CONNECTING' | 'CONNECTED' | 'DISCONNECTED';
}

/** Control frames are JSON strings; SOS payloads are binary. */
interface BloomDigestMessage {
  t: 'BLOOM';
  v: 1;
  bits: string;
}

const ICE_GATHERING_TIMEOUT_MS = 3000;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return typeof btoa === 'function' ? btoa(binary) : Buffer.from(bytes).toString('base64');
}

function base64ToBytes(value: string): Uint8Array {
  if (typeof atob === 'function') {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  return new Uint8Array(Buffer.from(value, 'base64'));
}

/**
 * Copies a frame into a plain ArrayBuffer. TypeScript's typed-array generics
 * otherwise permit a SharedArrayBuffer here, while RTCDataChannel.send accepts
 * only an ArrayBuffer-backed value.
 */
function toWireBuffer(frame: Uint8Array): ArrayBuffer {
  return new Uint8Array(frame).buffer as ArrayBuffer;
}

/**
 * Resolves once ICE has finished gathering, or after a short timeout. Host
 * candidates for the local network appear immediately, so an offline device on
 * a shared hotspot still produces a usable offer even when no STUN server is
 * reachable.
 */
function waitForIceGathering(pc: RTCPeerConnection, timeoutMs = ICE_GATHERING_TIMEOUT_MS): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', onStateChange);
      resolve();
    };
    const onStateChange = () => {
      if (pc.iceGatheringState === 'complete') finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    pc.addEventListener('icegatheringstatechange', onStateChange);
  });
}

class WebRtcTransport implements SOSTransport {
  public readonly name = 'PEER_MESH' as const;
  private peerConnections: Map<string, RTCPeerConnection> = new Map();
  private dataChannels: Map<string, RTCDataChannel> = new Map();
  private connectedAt: Map<string, number> = new Map();
  private peerListeners: Set<(peers: PeerMeshInfo[]) => void> = new Set();

  public async isAvailable(): Promise<boolean> {
    if (typeof window === 'undefined') return false;
    if (typeof RTCPeerConnection === 'undefined') return false;
    return this.openChannels().length > 0;
  }

  private openChannels(): RTCDataChannel[] {
    return Array.from(this.dataChannels.values()).filter((dc) => dc.readyState === 'open');
  }

  public subscribePeers(listener: (peers: PeerMeshInfo[]) => void): () => void {
    this.peerListeners.add(listener);
    listener(this.getConnectedPeers());
    return () => this.peerListeners.delete(listener);
  }

  public getConnectedPeers(): PeerMeshInfo[] {
    return Array.from(this.dataChannels.entries()).map(([peerId, dc]) => ({
      peerId,
      connectedAt: this.connectedAt.get(peerId) ?? 0,
      status: dc.readyState === 'open' ? 'CONNECTED' : 'CONNECTING',
    }));
  }

  private notifyPeers() {
    const current = this.getConnectedPeers();
    this.peerListeners.forEach((l) => {
      try { l(current); } catch { /* a UI listener must never break the mesh */ }
    });
  }

  private createPeerConnection(peerId: string): RTCPeerConnection {
    const pc = new RTCPeerConnection({
      // STUN only helps when there is internet. Host candidates cover the
      // offline hotspot case, which is the one that matters here.
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.teardownPeer(peerId);
      }
    };
    this.peerConnections.set(peerId, pc);
    return pc;
  }

  private teardownPeer(peerId: string) {
    this.dataChannels.delete(peerId);
    this.connectedAt.delete(peerId);
    const pc = this.peerConnections.get(peerId);
    if (pc) {
      try { pc.close(); } catch { /* already closed */ }
      this.peerConnections.delete(peerId);
    }
    this.notifyPeers();
  }

  /** Generates the offer a second device scans or pastes to pair. */
  public async createOffer(): Promise<{ offerSdp: string; peerId: string }> {
    if (typeof window === 'undefined') throw new Error('Peer mesh pairing requires a browser.');

    const peerId = `PEER-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
    const pc = this.createPeerConnection(peerId);
    this.setupDataChannel(peerId, pc.createDataChannel('prahari_mesh', { ordered: true }));

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceGathering(pc);

    return { offerSdp: bytesToBase64(new TextEncoder().encode(JSON.stringify(pc.localDescription))), peerId };
  }

  /** Device B consumes Device A's offer and returns an answer to carry back. */
  public async acceptOffer(offerSdpBase64: string): Promise<{ answerSdp: string; peerId: string }> {
    if (typeof window === 'undefined') throw new Error('Peer mesh pairing requires a browser.');

    const offerDesc = JSON.parse(new TextDecoder().decode(base64ToBytes(offerSdpBase64.trim())));
    const peerId = `PEER-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
    const pc = this.createPeerConnection(peerId);

    pc.ondatachannel = (evt) => this.setupDataChannel(peerId, evt.channel);

    await pc.setRemoteDescription(new RTCSessionDescription(offerDesc));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitForIceGathering(pc);

    return { answerSdp: bytesToBase64(new TextEncoder().encode(JSON.stringify(pc.localDescription))), peerId };
  }

  /** Device A completes the handshake with Device B's answer. */
  public async completeHandshake(peerId: string, answerSdpBase64: string): Promise<boolean> {
    const pc = this.peerConnections.get(peerId);
    if (!pc) return false;

    try {
      const answerDesc = JSON.parse(new TextDecoder().decode(base64ToBytes(answerSdpBase64.trim())));
      await pc.setRemoteDescription(new RTCSessionDescription(answerDesc));
      return true;
    } catch (err) {
      console.warn('[WebRtcTransport] Failed to complete handshake:', err);
      return false;
    }
  }

  private setupDataChannel(peerId: string, dc: RTCDataChannel) {
    dc.binaryType = 'arraybuffer';
    this.dataChannels.set(peerId, dc);

    dc.onopen = () => {
      this.connectedAt.set(peerId, Date.now());
      this.notifyPeers();
      // Announce what this node already holds so the peer can push only what
      // is missing, instead of replaying its whole queue over the radio.
      void this.sendBloomDigest(dc);
    };

    dc.onclose = () => this.teardownPeer(peerId);
    dc.onerror = () => this.teardownPeer(peerId);

    dc.onmessage = async (event) => {
      try {
        if (event.data instanceof ArrayBuffer) {
          await this.handleIncomingFrame(new Uint8Array(event.data));
          return;
        }
        if (typeof event.data === 'string') await this.handleControlMessage(dc, event.data);
      } catch (err) {
        console.error('[WebRtcTransport] Error handling peer message:', err);
      }
    };
  }

  private async handleIncomingFrame(bytes: Uint8Array) {
    const frame = unpackMeshFrame(bytes);
    if (!frame) return;

    // Verified before it is allowed anywhere near storage or the authority
    // gateway. A relay that altered one byte fails here.
    if (!verifyNostrSOSEvent(frame.event)) {
      console.warn('[WebRtcTransport] Dropped peer frame with an invalid Nostr signature.');
      return;
    }

    const packet = fromNostrSOSEvent(frame.event, {
      ttl: frame.ttl,
      hopCount: frame.hopCount,
      relayPath: frame.relayPath.length > 0 ? frame.relayPath : undefined,
      lastKnownTransport: 'BLE_RELAY',
    });
    await globalBLERelayEngine.handleIncomingPacket(packet);
  }

  private async handleControlMessage(dc: RTCDataChannel, raw: string) {
    const message = JSON.parse(raw) as BloomDigestMessage;
    if (message?.t !== 'BLOOM' || typeof message.bits !== 'string') return;

    const peerFilter = BloomFilter.fromBuffer(base64ToBytes(message.bits));
    const held = await getAllQueuedPackets();
    const undelivered = held.filter((record) => record.status === 'QUEUED' || record.status === 'RELAYED');
    const missing = undelivered.filter((record) => !peerFilter.has(meshEventId(record.packet)));

    for (const record of missing) {
      if (dc.readyState !== 'open' || !record.packet.nostrEvent) continue;
      try {
        dc.send(toWireBuffer(packMeshFrame(record.packet)));
      } catch (err) {
        console.warn('[WebRtcTransport] Could not push a missing packet to peer:', err);
      }
    }
  }

  private async sendBloomDigest(dc: RTCDataChannel) {
    try {
      const filter = new BloomFilter(MESH_BLOOM_SIZE_BITS, MESH_BLOOM_HASHES);
      for (const record of await getAllQueuedPackets()) filter.add(meshEventId(record.packet));
      if (dc.readyState !== 'open') return;
      const digest: BloomDigestMessage = { t: 'BLOOM', v: 1, bits: bytesToBase64(filter.toBuffer()) };
      dc.send(JSON.stringify(digest));
    } catch (err) {
      console.warn('[WebRtcTransport] Could not send Bloom digest:', err);
    }
  }

  /** Broadcasts a packet to every connected peer device. */
  public async send(packet: SOSPacket): Promise<TransportResult> {
    const activeChannels = this.openChannels();
    if (activeChannels.length === 0) {
      return { success: false, channel: 'PEER_MESH', error: 'No device is connected to the direct peer mesh.' };
    }
    if (!packet.nostrEvent) {
      return { success: false, channel: 'PEER_MESH', error: 'SOS packet carries no signed Nostr event.' };
    }

    let sentCount = 0;
    const wireFrame = toWireBuffer(packMeshFrame(packet));
    for (const dc of activeChannels) {
      try {
        dc.send(wireFrame);
        sentCount++;
      } catch (err) {
        console.warn('[WebRtcTransport] Direct send error:', err);
      }
    }

    return {
      success: sentCount > 0,
      channel: 'PEER_MESH',
      incidentId: packet.incidentId,
      // A peer accepting the packet is not an authority receipt. It means a
      // nearby device now carries it and will upload when it finds a network.
      message: `SOS handed to ${sentCount} nearby device${sentCount === 1 ? '' : 's'}. Delivery to the authority queue happens when one of them reaches a network.`,
      error: sentCount > 0 ? undefined : 'No peer accepted the SOS packet.',
      transmittedAt: Date.now(),
    };
  }
}

export const globalWebRtcTransport = new WebRtcTransport();

// The relay engine owns store-and-forward but must not depend on any single
// link. Registering here keeps the dependency one-way: link knows engine.
globalBLERelayEngine.registerForwarder(async (packet) => {
  const result = await globalWebRtcTransport.send(packet);
  return result.success ? 1 : 0;
});
