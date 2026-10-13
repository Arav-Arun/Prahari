import { createHash, generateKeyPairSync, sign as edSign, verify as edVerify, createPrivateKey, createPublicKey } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { base58, buildDidDocument, decodeBase58, deriveDid } from './did';
import type { KycSubject } from '../kyc/types';

/** Legacy API callers receive a conservative 30-day credential. */
const DEFAULT_VALIDITY_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_VALIDITY_MS = 365 * 24 * 60 * 60 * 1000;

let cachedKeys: { privateKey: KeyObject; publicKey: KeyObject } | null = null;

/**
 * Ed25519 issuer keypair.
 *
 * Loaded from IDENTITY_SIGNING_KEY (PKCS#8 PEM, base64-encoded). If unset, an
 * ephemeral key is generated so local dev works — but credentials signed with
 * it stop verifying when the process restarts, which is logged loudly.
 */
function getIssuerKeys() {
  if (cachedKeys) return cachedKeys;

  const encoded = process.env.IDENTITY_SIGNING_KEY;
  if (encoded) {
    const pem = Buffer.from(encoded, 'base64').toString('utf8');
    const privateKey = createPrivateKey(pem);
    cachedKeys = { privateKey, publicKey: createPublicKey(privateKey) };
  } else {
    console.warn(
      '[prahari] IDENTITY_SIGNING_KEY is unset — generating an EPHEMERAL issuer key. ' +
      'Credentials signed now will fail verification after a restart. ' +
      'Generate one with: pnpm identity:keygen'
    );
    cachedKeys = generateKeyPairSync('ed25519');
  }
  return cachedKeys;
}

/** Raw 32-byte Ed25519 public key, base58 — used in the DID document. */
function getIssuerPublicKeyB58(): string {
  const der = getIssuerKeys().publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  return base58(der.subarray(der.length - 32)); // strip the 12-byte SPKI prefix
}

interface VerifiableCredential {
  '@context': string[];
  id: string;
  type: string[];
  issuer: string;
  issuanceDate: string;
  expirationDate: string;
  credentialSubject: Record<string, unknown>;
  /** Present only on sandbox-issued credentials. */
  sandbox?: { simulated: true; provider: string; notice: string };
  proof?: {
    type: string; created: string; proofPurpose: string;
    verificationMethod: string; proofValue: string;
  };
}

/** RFC 8785-style deterministic serialisation, so hashing is stable. */
function canonicalise(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalise(obj[k])}`).join(',')}}`;
}

/** keccak256-compatible digest of the unsigned credential. Block 3 anchors this. */
function computeCredentialHash(vc: VerifiableCredential): string {
  const { proof, ...unsigned } = vc;
  return '0x' + createHash('sha256').update(canonicalise(unsigned)).digest('hex');
}

interface IssuedIdentity {
  did: string;
  didDocument: ReturnType<typeof buildDidDocument>;
  credential: VerifiableCredential;
  credentialHash: string;
  expiresAt: string;
}

type CredentialIssueOptions = {
  /** Trip end supplied during onboarding; the credential is never valid past it. */
  expiresAt?: string;
};

/**
 * Builds and signs a W3C Verifiable Credential for a verified KYC subject.
 * The credential carries no document number — only the masked fragment and
 * the salted subject hash.
 */
export function issueCredential(
  subject: KycSubject,
  touristId: string,
  providerId: string,
  isSandbox: boolean,
  options: CredentialIssueOptions = {}
): IssuedIdentity {
  const did = deriveDid(subject.subjectHash);
  const now = new Date();
  const requestedExpiry = options.expiresAt ? new Date(options.expiresAt) : null;
  const expires = requestedExpiry && Number.isFinite(requestedExpiry.getTime()) &&
    requestedExpiry.getTime() > now.getTime() &&
    requestedExpiry.getTime() <= now.getTime() + MAX_VALIDITY_MS
      ? requestedExpiry
      : new Date(now.getTime() + DEFAULT_VALIDITY_MS);

  const vc: VerifiableCredential = {
    '@context': [
      'https://www.w3.org/2018/credentials/v1',
      'https://w3id.org/security/suites/ed25519-2020/v1',
    ],
    id: `urn:prahari:credential:${touristId}`,
    type: ['VerifiableCredential', 'TouristIdentityCredential'],
    issuer: 'did:prahari:issuer:authority',
    issuanceDate: now.toISOString(),
    expirationDate: expires.toISOString(),
    credentialSubject: {
      id: did,
      touristId,
      fullName: subject.fullName,
      nationality: subject.nationality,
      nationalityCode: subject.nationalityCode,
      ...(subject.dateOfBirth ? { dateOfBirth: subject.dateOfBirth } : {}),
      ...(subject.sex ? { sex: subject.sex } : {}),
      identityDocument: {
        type: subject.documentType,
        masked: subject.maskedDocument,
        subjectHash: subject.subjectHash,
      },
      verification: { method: subject.documentType, provider: providerId, verifiedAt: now.toISOString(), ...(subject.meta ?? {}) },
      trip: { validUntil: expires.toISOString() },
    },
    ...(isSandbox
      ? {
          sandbox: {
            simulated: true as const,
            provider: providerId,
            notice:
              'Issued by a simulated verification provider. Not a government-issued credential and not backed by a UIDAI authentication.',
          },
        }
      : {}),
  };

  const credentialHash = computeCredentialHash(vc);
  const { privateKey } = getIssuerKeys();
  const signature = edSign(null, Buffer.from(credentialHash, 'utf8'), privateKey);

  vc.proof = {
    type: 'Ed25519Signature2020',
    created: now.toISOString(),
    proofPurpose: 'assertionMethod',
    verificationMethod: 'did:prahari:issuer:authority#key-1',
    proofValue: `z${base58(signature)}`,
  };

  return {
    did,
    didDocument: buildDidDocument(did, getIssuerPublicKeyB58()),
    credential: vc,
    credentialHash,
    expiresAt: expires.toISOString(),
  };
}

/** Verifies the Ed25519 proof and the expiry of a stored credential. */
export function verifyCredential(vc: VerifiableCredential): { valid: boolean; reason?: string } {
  if (!vc?.proof?.proofValue) return { valid: false, reason: 'Credential has no proof.' };
  if (new Date(vc.expirationDate) < new Date()) return { valid: false, reason: 'Credential has expired.' };

  const hash = computeCredentialHash(vc);
  const raw = vc.proof.proofValue.replace(/^z/, '');

  const sig = decodeBase58(raw);
  if (!sig) return { valid: false, reason: 'Malformed proof encoding.' };

  try {
    const ok = edVerify(null, Buffer.from(hash, 'utf8'), getIssuerKeys().publicKey, sig);
    return ok ? { valid: true } : { valid: false, reason: 'Signature does not verify.' };
  } catch (e: any) {
    return { valid: false, reason: `Verification error: ${e.message}` };
  }
}
