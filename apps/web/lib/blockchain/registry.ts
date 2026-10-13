import { canReadRegistry, canWriteRegistry, chainId, connectRegistry, registryAddress } from "./chain";

/**
 * Client for the on-chain TouristIdentityRegistry. Anchors credential hashes
 * (never PII) so a credential can be verified independently. Every function
 * returns null when the chain is unconfigured or unreachable, so issuance
 * never fails because anchoring is unavailable.
 */
const ABI = [
  "function registerCredential(bytes32 credentialHash, uint64 expiresAt) external",
  "function verifyCredential(bytes32 credentialHash) external view returns (bool isValid, uint8 currentState, uint64 expiresAt)",
];

const ADDRESS = registryAddress.identity;
const CREDENTIAL_STATE = ["Inexistent", "Active", "Suspended", "Revoked", "Expired"] as const;

/** credentialHash is already `0x` + 64 hex (sha256) — a valid bytes32. */
const toBytes32 = (hash: string) => (hash.startsWith("0x") ? hash : `0x${hash}`);

export async function anchorCredential(credentialHash: string, expiresAtISO: string) {
  if (!canWriteRegistry(ADDRESS)) return null;
  try {
    const contract = await connectRegistry(ADDRESS as string, ABI, true);
    const hash = toBytes32(credentialHash);

    // The contract reverts on a duplicate, so skip hashes already anchored.
    const [, state] = await contract.verifyCredential(hash);
    if (Number(state) !== 0) return { txHash: "", blockNumber: 0, chainId, alreadyAnchored: true };

    const tx = await contract.registerCredential(hash, Math.floor(new Date(expiresAtISO).getTime() / 1000));
    const receipt = await tx.wait();
    return { txHash: tx.hash as string, blockNumber: receipt?.blockNumber ?? 0, chainId };
  } catch (err: any) {
    console.warn("[prahari] anchorCredential:", err?.message ?? err);
    return null;
  }
}

export async function verifyOnChain(credentialHash: string) {
  if (!canReadRegistry(ADDRESS)) return null;
  try {
    const contract = await connectRegistry(ADDRESS as string, ABI);
    const [isValid, state, expiresAt] = await contract.verifyCredential(toBytes32(credentialHash));
    return {
      exists: Number(state) !== 0,
      isValid: Boolean(isValid),
      state: CREDENTIAL_STATE[Number(state)] ?? "Unknown",
      expiresAt: Number(expiresAt),
      chainId,
    };
  } catch (err: any) {
    console.warn("[prahari] verifyOnChain:", err?.message ?? err);
    return null;
  }
}
