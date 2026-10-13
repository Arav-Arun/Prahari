import { ethers } from "ethers";

/**
 * Shared chain configuration for the identity and incident registries. A
 * funded deployer key plus an Alchemy URL selects Sepolia; otherwise the local
 * Hardhat variables are used. Only hashes are ever written on-chain.
 */
const useSepolia = Boolean(process.env.DEPLOYER_PRIVATE_KEY && process.env.ALCHEMY_SEPOLIA_URL);
const rpcUrl = useSepolia ? process.env.ALCHEMY_SEPOLIA_URL : process.env.CHAIN_RPC_URL;
const signerKey = process.env.DEPLOYER_PRIVATE_KEY ?? process.env.ANCHOR_PRIVATE_KEY;

export const chainNetwork = useSepolia ? "sepolia" : "local";
export const chainId = useSepolia ? 11_155_111 : Number(process.env.CHAIN_ID ?? 31_337);

export const registryAddress = {
  identity: useSepolia ? process.env.SEPOLIA_IDENTITY_REGISTRY_ADDRESS : process.env.IDENTITY_REGISTRY_ADDRESS,
  incident: useSepolia ? process.env.SEPOLIA_INCIDENT_REGISTRY_ADDRESS : process.env.INCIDENT_REGISTRY_ADDRESS,
};

export const canReadRegistry = (address?: string) => Boolean(rpcUrl && address);
export const canWriteRegistry = (address?: string) => Boolean(rpcUrl && address && signerKey);

/** Connects to a registry after checking the RPC serves the expected chain. */
export async function connectRegistry(address: string, abi: string[], write = false) {
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== chainId) {
    throw new Error(`Registry network mismatch: expected ${chainId}, received ${network.chainId}.`);
  }
  return new ethers.Contract(address, abi, write ? new ethers.Wallet(signerKey as string, provider) : provider);
}
