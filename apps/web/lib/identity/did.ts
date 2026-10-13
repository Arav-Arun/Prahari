import { createHash } from 'node:crypto';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58(buf: Buffer): string {
  let n = BigInt('0x' + buf.toString('hex'));
  let out = '';
  const base = 58n;
  while (n > 0n) { out = B58[Number(n % base)] + out; n /= base; }
  for (const byte of buf) { if (byte === 0) out = '1' + out; else break; }
  return out;
}

/**
 * Decodes the multibase payload used by the credential proof. Leading zero
 * bytes are significant for Ed25519 signatures, so each leading `1` restores
 * one zero byte instead of being silently lost in the BigInt conversion.
 */
export function decodeBase58(value: string): Buffer | null {
  let n = 0n;
  for (const character of value) {
    const index = B58.indexOf(character);
    if (index < 0) return null;
    n = n * 58n + BigInt(index);
  }

  let encoded = Buffer.alloc(0);
  if (n > 0n) {
    let hex = n.toString(16);
    if (hex.length % 2) hex = `0${hex}`;
    encoded = Buffer.from(hex, 'hex');
  }
  let leadingZeroes = 0;
  for (const character of value) {
    if (character !== '1') break;
    leadingZeroes += 1;
  }
  return leadingZeroes ? Buffer.concat([Buffer.alloc(leadingZeroes), encoded]) : encoded;
}

/**
 * Deterministic DID from the salted subject hash.
 *
 * Deterministic matters: re-verifying the same document yields the same DID,
 * so a tourist who re-enrols is recognised rather than duplicated. The DID is
 * derived from the *hash*, never from the document number, so it leaks nothing.
 */
export function deriveDid(subjectHash: string): string {
  const digest = createHash('sha256').update(`did:prahari:${subjectHash}`).digest();
  return `did:prahari:${base58(digest.subarray(0, 20))}`;
}

interface DidDocument {
  '@context': string[];
  id: string;
  controller: string;
  verificationMethod: Array<{
    id: string; type: string; controller: string; publicKeyMultibase: string;
  }>;
  authentication: string[];
  assertionMethod: string[];
  created: string;
}

/** Minimal W3C DID document for the issued identity. */
export function buildDidDocument(did: string, issuerPublicKeyB58: string): DidDocument {
  return {
    '@context': ['https://www.w3.org/ns/did/v1'],
    id: did,
    controller: did,
    verificationMethod: [{
      id: `${did}#key-1`,
      type: 'Ed25519VerificationKey2020',
      controller: did,
      publicKeyMultibase: `z${issuerPublicKeyB58}`,
    }],
    authentication: [`${did}#key-1`],
    assertionMethod: [`${did}#key-1`],
    created: new Date().toISOString(),
  };
}

export { base58 };
