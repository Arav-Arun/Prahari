import { canReadRegistry, canWriteRegistry, chainId, chainNetwork, registryAddress } from '@/lib/blockchain/chain';
import { notificationProviderStatus } from '@/lib/services/emergencyNotifications';
import { isEmergencyProfileAiConfigured } from '@/lib/services/emergencyClothingProfile';
import { indiaHazardProviderStatus } from '@/lib/services/indiaHazards';
import { sarvamMultilingualProviderStatus } from '@/lib/services/multilingualCommunication';
import { getDatabaseReadiness } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export async function GET() {
  const database = await getDatabaseReadiness();
  return Response.json({
    status: database.ready ? 'ok' : 'degraded', service: 'prahari-web', timestamp: new Date().toISOString(),
    database,
    web3: {
      network: chainNetwork,
      expectedChainId: chainId,
      identity: { readable: canReadRegistry(registryAddress.identity), writableByServer: canWriteRegistry(registryAddress.identity) },
      incidentEvidence: { readable: canReadRegistry(registryAddress.incident), writableByServer: canWriteRegistry(registryAddress.incident) },
    },
    providers: {
      notifications: notificationProviderStatus(),
      emergencyIdentificationProfile: { openAiConfigured: isEmergencyProfileAiConfigured() },
      indiaHazards: indiaHazardProviderStatus(),
      multilingualCommunication: sarvamMultilingualProviderStatus(),
      bleGatewayUplinkConfigured: Boolean(process.env.PRAHARI_MESH_GATEWAY_KEY),
    },
  });
}
