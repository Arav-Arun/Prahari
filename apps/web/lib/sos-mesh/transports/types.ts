/**
 * Offline SOS Mesh — Transport Layer Abstractions
 */

import { SOSPacket } from '../sosPacket';

/**
 * PEER_MESH is a direct browser-to-browser WebRTC DataChannel link between two
 * nearby devices. BLE_RELAY is a GATT write to a separately provisioned relay
 * gateway. They are different links with different trust stories, so they are
 * never reported under one name.
 */
export type TransportChannel = 'INTERNET' | 'PEER_MESH' | 'BLE_RELAY' | 'LOCAL_QUEUE';

export interface TransportResult {
  success: boolean;
  channel: TransportChannel;
  message?: string;
  incidentId?: string;
  incidentRecord?: any;
  error?: string;
  transmittedAt?: number;
}

export interface SOSTransport {
  name: TransportChannel;
  isAvailable(): Promise<boolean>;
  send(packet: SOSPacket): Promise<TransportResult>;
}
