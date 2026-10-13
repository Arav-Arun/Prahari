import { ethers } from 'ethers';
import { canReadRegistry, canWriteRegistry, chainId, connectRegistry, registryAddress } from './chain';

const ABI = [
  'function anchorIncident(bytes32 incidentIdKey, bytes32 incidentHash, bytes32 locationHash) external',
  'function verifyIncidentHash(bytes32 incidentIdKey, bytes32 computedHash) external view returns (bool isValid, uint8 status, uint256 timestamp, bool isAudited)',
];

const ADDRESS = registryAddress.incident;

/**
 * Derives a stable, privacy-safe commitment. It intentionally excludes names,
 * contact data, full GPS coordinates, raw witness statements, and attachments.
 * Only the hashes and a coarse (~1 km) location grid reach the public ledger.
 */
function createEfirCommitment(incidentId: string, efir: Record<string, any>) {
  const digest = (value: unknown) => ethers.keccak256(ethers.toUtf8Bytes(String(value ?? '')));
  const canonical = JSON.stringify({
    version: 1,
    incidentId,
    efirId: efir.efirId,
    category: efir.incidentCategory ?? efir.incidentType,
    occurrenceAt: efir.occurrenceAt ?? null,
    reportedAt: efir.reportedAt ?? efir.createdAt,
    narrativeDigest: digest(efir.narrative),
    evidenceDigests: (efir.evidence ?? []).map((item: any) => digest(`${item.type ?? ''}:${item.reference ?? ''}:${item.description ?? ''}`)),
    propertyDigests: (efir.stolenItems ?? []).map((item: any) => digest(item)),
  });
  const location = efir.location ?? {};
  const coarseLocation = `${Number(location.lat).toFixed(2)},${Number(location.lng).toFixed(2)}`;

  return {
    incidentKey: digest(incidentId),
    payloadHash: digest(canonical),
    locationHash: digest(coarseLocation),
  };
}

export async function anchorEfirEvidence(incidentId: string, efir: Record<string, any>) {
  if (!canWriteRegistry(ADDRESS)) return null;
  try {
    const contract = await connectRegistry(ADDRESS as string, ABI, true);
    const commitment = createEfirCommitment(incidentId, efir);
    const anchoredAt = new Date().toISOString();

    const [alreadyMatches] = await contract.verifyIncidentHash(commitment.incidentKey, commitment.payloadHash);
    if (alreadyMatches) return { ...commitment, txHash: '', blockNumber: 0, chainId, anchoredAt, alreadyAnchored: true };

    const tx = await contract.anchorIncident(commitment.incidentKey, commitment.payloadHash, commitment.locationHash);
    const receipt = await tx.wait();
    return { ...commitment, txHash: tx.hash as string, blockNumber: receipt?.blockNumber ?? 0, chainId, anchoredAt };
  } catch (error: any) {
    // A rejected transaction must not block an officer's decision; the record
    // keeps a pending state so anchoring can be retried.
    console.warn('[prahari] anchorEfirEvidence:', error?.message ?? error);
    return null;
  }
}

export async function verifyEfirEvidence(incidentId: string, efir: Record<string, any>) {
  const commitment = createEfirCommitment(incidentId, efir);
  if (!canReadRegistry(ADDRESS)) return { configured: false, anchored: false, matches: false, commitment };
  try {
    const contract = await connectRegistry(ADDRESS as string, ABI);
    const [matches, status, timestamp, audited] = await contract.verifyIncidentHash(commitment.incidentKey, commitment.payloadHash);
    return {
      configured: true,
      anchored: Number(timestamp) > 0,
      matches: Boolean(matches),
      status: Number(status),
      timestamp: Number(timestamp),
      audited: Boolean(audited),
      chainId,
      commitment,
    };
  } catch (error: any) {
    console.warn('[prahari] verifyEfirEvidence:', error?.message ?? error);
    return { configured: true, anchored: false, matches: false, unavailable: true, commitment };
  }
}
