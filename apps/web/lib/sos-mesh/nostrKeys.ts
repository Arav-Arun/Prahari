/**
 * Offline SOS Mesh — Device Nostr Identity (secp256k1 / BIP-340 Schnorr)
 *
 * Every device holds one long-lived secp256k1 secret. The x-only public key
 * derived from it is the device's Nostr pubkey and the only thing an authority
 * needs in order to attribute a relayed SOS to a real traveller.
 *
 * The secret never leaves this browser. Only the public half is registered
 * against the tourist record, so a relaying stranger can carry a packet it can
 * neither read into nor forge.
 */

import { schnorr } from '@noble/curves/secp256k1';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils';

const SECRET_STORAGE_KEY = 'prahari_mesh_secret_v1';

interface DeviceKeyPair {
  /** 32-byte secret, hex. Never transmitted. */
  secretHex: string;
  /** 32-byte BIP-340 x-only public key, hex. This is the Nostr pubkey. */
  pubkeyHex: string;
}

let cachedKeyPair: DeviceKeyPair | null = null;

function deriveKeyPair(secretHex: string): DeviceKeyPair {
  const pubkeyHex = bytesToHex(schnorr.getPublicKey(hexToBytes(secretHex)));
  return { secretHex, pubkeyHex };
}

function readStoredSecret(): string | null {
  try {
    const stored = localStorage.getItem(SECRET_STORAGE_KEY);
    // A truncated or hand-edited value must be discarded rather than used to
    // derive a key that cannot verify.
    return stored && /^[0-9a-f]{64}$/i.test(stored) ? stored.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Returns this device's mesh identity, creating and persisting one on first
 * use. Returns null on the server, where there is no device to speak for.
 */
function getDeviceKeyPair(): DeviceKeyPair | null {
  // The cache is consulted before the environment check so a test or a native
  // shell can install a known identity outside a browser.
  if (cachedKeyPair) return cachedKeyPair;
  if (typeof window === 'undefined') return null;

  const stored = readStoredSecret();
  if (stored) {
    cachedKeyPair = deriveKeyPair(stored);
    return cachedKeyPair;
  }

  const secretHex = bytesToHex(randomBytes(32));
  try {
    localStorage.setItem(SECRET_STORAGE_KEY, secretHex);
  } catch {
    // A private-mode browser still gets a working in-memory identity for the
    // lifetime of the tab; the SOS path must not depend on storage succeeding.
  }
  cachedKeyPair = deriveKeyPair(secretHex);
  return cachedKeyPair;
}

/** This device's Nostr pubkey, or null on the server. */
export function getDevicePubkey(): string | null {
  return getDeviceKeyPair()?.pubkeyHex ?? null;
}

/**
 * Signs a 32-byte hex event id with this device's secret.
 * Returns null when no device identity exists (server-side rendering).
 */
export function signEventId(eventIdHex: string): string | null {
  const keyPair = getDeviceKeyPair();
  if (!keyPair) return null;
  try {
    return bytesToHex(schnorr.sign(hexToBytes(eventIdHex), hexToBytes(keyPair.secretHex)));
  } catch {
    return null;
  }
}

/**
 * Verifies a BIP-340 signature over an event id. Runs identically in the
 * browser and on the Next.js server, so a relay node and the authority gateway
 * reach the same verdict on the same bytes.
 */
export function verifyEventSignature(sigHex: string, eventIdHex: string, pubkeyHex: string): boolean {
  if (!/^[0-9a-f]{128}$/i.test(sigHex)) return false;
  if (!/^[0-9a-f]{64}$/i.test(eventIdHex)) return false;
  if (!/^[0-9a-f]{64}$/i.test(pubkeyHex)) return false;
  try {
    return schnorr.verify(hexToBytes(sigHex), hexToBytes(eventIdHex), hexToBytes(pubkeyHex));
  } catch {
    return false;
  }
}

/** Test seam: installs a known identity so signatures are reproducible. */
export function __setDeviceKeyPairForTesting(secretHex: string | null): DeviceKeyPair | null {
  cachedKeyPair = secretHex ? deriveKeyPair(secretHex) : null;
  return cachedKeyPair;
}
