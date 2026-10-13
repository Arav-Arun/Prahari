import { ethers, network } from "hardhat";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// Deploys the identity and incident registries and records their addresses in
// deployments/<network>.json. Copy those addresses into apps/web/.env.local.
async function main() {
  const [deployer] = await ethers.getSigners();
  const { chainId } = await ethers.provider.getNetwork();
  console.log(`Deploying to ${network.name} (chain ${chainId}) from ${deployer.address}`);

  const deploy = async (name: string) => {
    const contract = await (await ethers.getContractFactory(name)).deploy(deployer.address);
    await contract.waitForDeployment();
    const address = await contract.getAddress();
    console.log(`${name}: ${address}`);
    return address;
  };

  const deployment = {
    network: network.name,
    chainId: Number(chainId),
    deployer: deployer.address,
    addresses: {
      IncidentRegistry: await deploy("IncidentRegistry"),
      TouristIdentityRegistry: await deploy("TouristIdentityRegistry"),
    },
  };

  const dir = resolve(__dirname, "../deployments");
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, `${network.name}.json`), `${JSON.stringify(deployment, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
