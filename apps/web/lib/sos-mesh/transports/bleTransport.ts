/**
 * GATT client for a provisioned Prahari BLE relay gateway.
 *
 * Web applications cannot advertise as BLE peripherals or relay directly to
 * nearby phones. This transport therefore writes to a paired native/hardware
 * gateway that implements the documented Prahari relay GATT service. A BLE
 * write receipt means the gateway accepted the packet, not that an authority
 * queue has received it.
 */
import { saveQueuedPacket } from '../indexedDbQueue';
import { serializeSOSPacket, type SOSPacket } from '../sosPacket';
import type { SOSTransport, TransportResult } from './types';

export const PRAHARI_BLE_RELAY_SERVICE_UUID = '5b0d0e1a-4f4e-4ef4-ae52-9f901d4c0101';
export const PRAHARI_BLE_RELAY_WRITE_UUID = '5b0d0e1a-4f4e-4ef4-ae52-9f901d4c0102';

const FRAME_PREFIX = [0x50, 0x52, 1]; // "PR", protocol v1
// The baseline ATT MTU is 23 bytes, which leaves 20 bytes for a GATT write.
// Five bytes are consumed by the Prahari framing header, so use 15-byte JSON
// chunks unless a future protocol version explicitly negotiates a larger MTU.
// This is deliberately conservative: a gateway can accept many small frames,
// whereas a 165-byte write silently fails on most un-negotiated BLE links.
const MAX_FRAME_PAYLOAD = 15;
const MAX_FRAMES = 255;

/**
 * Serialises a packet into the documented write frames. Kept separate from
 * Web Bluetooth so it can be contract-tested without a physical gateway.
 */
export function encodeBleRelayFrames(packet: SOSPacket): Uint8Array[] {
  const payload = new TextEncoder().encode(serializeSOSPacket({ ...packet, lastKnownTransport: 'BLE_RELAY' }));
  const totalFrames = Math.ceil(payload.length / MAX_FRAME_PAYLOAD);
  if (totalFrames === 0 || totalFrames > MAX_FRAMES) {
    throw new Error('SOS packet is too large for the BLE relay protocol.');
  }

  return Array.from({ length: totalFrames }, (_, frameIndex) => {
    const offset = frameIndex * MAX_FRAME_PAYLOAD;
    const body = payload.slice(offset, offset + MAX_FRAME_PAYLOAD);
    return new Uint8Array([...FRAME_PREFIX, totalFrames, frameIndex, ...body]);
  });
}

type BluetoothCharacteristic = {
  writeValueWithResponse?: (value: BufferSource) => Promise<void>;
  writeValue?: (value: BufferSource) => Promise<void>;
};

type BluetoothDeviceLike = {
  name?: string;
  gatt?: {
    connected: boolean;
    connect: () => Promise<{
      getPrimaryService: (service: string) => Promise<{ getCharacteristic: (characteristic: string) => Promise<BluetoothCharacteristic> }>;
    }>;
    disconnect: () => void;
  };
  addEventListener?: (event: 'gattserverdisconnected', listener: () => void) => void;
};

type BleRelayStatus = {
  supported: boolean;
  paired: boolean;
  gatewayName: string | null;
};

export class BleTransport implements SOSTransport {
  public readonly name = 'BLE_RELAY' as const;
  private device: BluetoothDeviceLike | null = null;
  private characteristic: BluetoothCharacteristic | null = null;

  getStatus(): BleRelayStatus {
    return {
      supported: typeof navigator !== 'undefined' && Boolean((navigator as any).bluetooth?.requestDevice),
      paired: Boolean(this.characteristic && this.device?.gatt?.connected),
      gatewayName: this.device?.name ?? null,
    };
  }

  private async connectDevice(device: BluetoothDeviceLike): Promise<BleRelayStatus> {
    if (!device?.gatt) throw new Error('The selected device does not expose a BLE GATT connection.');
    if (device.gatt.connected) device.gatt.disconnect();
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(PRAHARI_BLE_RELAY_SERVICE_UUID);
    this.characteristic = await service.getCharacteristic(PRAHARI_BLE_RELAY_WRITE_UUID);
    this.device = device;
    device.addEventListener?.('gattserverdisconnected', () => {
      this.characteristic = null;
    });
    return this.getStatus();
  }

  /** Must be called from a user gesture so the browser can show its chooser. */
  async pairGateway(): Promise<BleRelayStatus> {
    const bluetooth = typeof navigator !== 'undefined' ? (navigator as any).bluetooth : null;
    if (!bluetooth?.requestDevice) throw new Error('Web Bluetooth is not supported by this browser. Use a supported browser with a provisioned relay gateway.');

    const device = await bluetooth.requestDevice({
      filters: [{ services: [PRAHARI_BLE_RELAY_SERVICE_UUID] }],
      optionalServices: [PRAHARI_BLE_RELAY_SERVICE_UUID],
    }) as BluetoothDeviceLike;
    return this.connectDevice(device);
  }

  /**
   * Reconnects an already user-authorised gateway after a page reload without
   * opening the device picker. Browsers that do not implement getDevices keep
   * the explicit pairing flow; no permission is bypassed.
   */
  async reconnectKnownGateway(): Promise<BleRelayStatus> {
    const bluetooth = typeof navigator !== 'undefined' ? (navigator as any).bluetooth : null;
    if (!bluetooth?.getDevices) return this.getStatus();
    try {
      const devices = await bluetooth.getDevices() as BluetoothDeviceLike[];
      for (const device of devices) {
        try {
          return await this.connectDevice(device);
        } catch {
          // An authorised device may expose another service; continue looking.
        }
      }
    } catch {
      // The user can always reconnect through the explicit chooser.
    }
    return this.getStatus();
  }

  disconnect() {
    this.device?.gatt?.disconnect();
    this.characteristic = null;
  }

  public async isAvailable(): Promise<boolean> {
    return this.getStatus().paired;
  }

  public async send(packet: SOSPacket): Promise<TransportResult> {
    if (!this.characteristic || !this.device?.gatt?.connected) {
      return { success: false, channel: 'BLE_RELAY', error: 'No paired Prahari BLE relay gateway is connected.' };
    }

    try {
      const relayedPacket: SOSPacket = { ...packet, lastKnownTransport: 'BLE_RELAY' };
      for (const frame of encodeBleRelayFrames(relayedPacket)) {
        // Create a plain ArrayBuffer for the DOM GATT API. TypeScript's newer
        // typed-array generics otherwise permit SharedArrayBuffer here, while
        // Web Bluetooth accepts only an ArrayBuffer-backed BufferSource.
        const writeFrame = new Uint8Array(frame).buffer as ArrayBuffer;
        if (this.characteristic.writeValueWithResponse) await this.characteristic.writeValueWithResponse(writeFrame);
        else if (this.characteristic.writeValue) await this.characteristic.writeValue(writeFrame);
        else throw new Error('The relay gateway does not provide a writable GATT characteristic.');
      }
      // Preserve the actual first-hop transport so a later Internet retry does
      // not erase the BLE relay provenance in its packet metadata.
      await saveQueuedPacket(relayedPacket, 'RELAYED');
      return {
        success: true,
        channel: 'BLE_RELAY',
        incidentId: packet.incidentId,
        message: 'SOS accepted by the paired BLE relay gateway. Delivery to the authority queue is pending its internet connection.',
        transmittedAt: Date.now(),
      };
    } catch (error: any) {
      return { success: false, channel: 'BLE_RELAY', error: error.message || 'BLE relay transmission failed.' };
    }
  }
}

export const globalBleTransport = new BleTransport();
