import { newIncidentId } from '@/lib/ids';
import { NextRequest, NextResponse } from "next/server";
import { insertIncident, updateIncident, getTourist, getIncident } from "@/lib/db";
import { emitToGateway } from "@/lib/services/gatewayEmit";
import { availableResponders, findNearestResponder } from "@/lib/services/dispatchEngine";
import { isPacketExpired, isValidSOSPacket, type SOSPacket } from "@/lib/sos-mesh/sosPacket";
import { signedTouristId, verifyRelayedPacket } from "@/lib/sos-mesh/meshTrust";
import { notifyEmergencyContacts } from "@/lib/services/emergencyNotifications";
import { canAccessTouristData, requireAuth } from '@/lib/auth/guards';

function hasGatewayCredential(request: NextRequest): boolean {
  const configured = process.env.PRAHARI_MESH_GATEWAY_KEY;
  const supplied = request.headers.get('x-prahari-mesh-gateway-key') ?? '';
  if (!configured || supplied.length !== configured.length) return false;
  let difference = 0;
  for (let index = 0; index < configured.length; index += 1) {
    difference |= configured.charCodeAt(index) ^ supplied.charCodeAt(index);
  }
  return difference === 0;
}

/**
 * Authenticated emergency gateway relay endpoint.
 *
 * Three ways in, in decreasing order of privilege:
 *  - a provisioned relay gateway presenting its shared key;
 *  - an authenticated user filing an SOS for a tourist they may act for;
 *  - any authenticated user relaying a *stranger's* packet, accepted purely on
 *    the strength of the origin's BIP-340 signature over a key that tourist has
 *    registered. This is what makes the offline mesh worth anything: the phone
 *    that carries your SOS out never needs permission to speak for you, and can
 *    neither read routing fields into it nor alter the ones that are there.
 */
export async function POST(request: NextRequest) {
  const gatewayAuthenticated = hasGatewayCredential(request);
  const auth = gatewayAuthenticated ? null : await requireAuth(request, ['tourist', 'authority', 'admin', 'responder']);
  if (auth?.errorResponse) return auth.errorResponse;
  try {
    const body = await request.json();
    const packet = body.packet ?? body;

    if (!isValidSOSPacket(packet)) {
      return NextResponse.json({ success: false, error: "Invalid SOS packet payload schema." }, { status: 400 });
    }
    if (isPacketExpired(packet)) {
      return NextResponse.json({ success: false, error: 'This SOS packet has expired and cannot be delivered.' }, { status: 410 });
    }
    if (packet.packetCategory !== 'SOS_ALERT' || typeof packet.latitude !== 'number' || typeof packet.longitude !== 'number') {
      return NextResponse.json({ success: false, error: 'Only location-bearing SOS alert packets can be relayed.' }, { status: 400 });
    }

    // Who is asking, and on whose behalf.
    const envelopeTouristId = packet.touristId;
    const selfService = gatewayAuthenticated || (!!auth?.session && canAccessTouristData(auth.session, envelopeTouristId));

    // For a mesh relay the envelope is untrusted, so the tourist record is
    // looked up under the id inside the signed event.
    const lookupTouristId = selfService ? envelopeTouristId : (signedTouristId(packet) ?? envelopeTouristId);
    const tourist = await getTourist(lookupTouristId);
    if (!tourist) {
      return NextResponse.json({ success: false, error: 'Tourist record not found.' }, { status: 404 });
    }

    let effectivePacket: SOSPacket = packet;
    let meshRelayed = false;

    if (!selfService) {
      const verdict = verifyRelayedPacket(packet, tourist);
      if (!verdict.trusted) {
        return NextResponse.json({ success: false, error: verdict.reason }, { status: 403 });
      }
      // Rebuilt from signed data only.
      effectivePacket = verdict.packet;
      meshRelayed = true;
    }

    const incidentId = effectivePacket.incidentId ?? newIncidentId();
    const touristId = effectivePacket.touristId;
    const lat = effectivePacket.latitude as number;
    const lng = effectivePacket.longitude as number;
    // The packet schema does not constrain this field, so a queued packet from
    // an older client can arrive without it. Never write an unrecognised value
    // into the incident's transport provenance or its timeline wording.
    const relayedTransport = meshRelayed || gatewayAuthenticated
      ? 'BLE_RELAY'
      : (['INTERNET', 'PEER_MESH', 'BLE_RELAY', 'SMS', 'LOCAL_QUEUE'] as const).find((known) => known === effectivePacket.lastKnownTransport) ?? 'BLE_RELAY';

    const existing = await getIncident(incidentId);
    if (existing) {
      return NextResponse.json({ success: true, message: 'SOS packet was already recorded.', incident: existing, idempotent: true });
    }

    const match = findNearestResponder(lat, lng, await availableResponders());

    const incidentRecord = {
      incidentId,
      touristId,
      touristName: tourist.name ?? touristId,
      type: effectivePacket.type ?? 'PANIC',
      status: 'ACTIVE',
      location: { lat, lng },
      severity: effectivePacket.severity ?? 'CRITICAL',
      riskScore: 95,
      createdAt: new Date().toISOString(),
      assignedResponder: match?.responder?.id ?? null,
      assignedResponderUnitId: match?.responder?.unitId ?? null,
      assignedResponderName: match?.responder?.name ?? null,
      etaMinutes: match?.etaMinutes ?? null,
      resolvedAt: null,
      emergencyContactNotifications: null,
      // Gateway-originated packets are labelled as BLE relay receipts. The
      // browser never claims a relay or authority receipt before this record
      // has been durably written.
      transportType: relayedTransport,
      hopCount: effectivePacket.hopCount ?? 0,
      originalTimestamp: new Date(effectivePacket.timestamp).toISOString(),
      relayPath: effectivePacket.relayPath ?? [],
      originDeviceId: effectivePacket.originDeviceId ?? null,
      packetId: effectivePacket.packetId,
      // Recorded so an officer can see the alert reached them second-hand and
      // which origin key vouched for it.
      meshRelayed,
      meshOriginPubkey: meshRelayed ? effectivePacket.nostrEvent?.pubkey ?? null : null,
      timeline: [
        {
          event: `Relayed SOS recorded via ${relayedTransport} (recorded relay hops: ${effectivePacket.hopCount ?? 0})`,
          at: new Date().toISOString(),
          actor: gatewayAuthenticated
            ? 'Prahari relay gateway'
            : meshRelayed
              ? 'Nearby device on the Prahari mesh (origin signature verified)'
              : 'Authenticated Prahari user',
        },
      ],
    };

    const inserted = await insertIncident(incidentRecord as any);
    if (!inserted) {
      return NextResponse.json({ success: false, error: "Failed to record relayed incident." }, { status: 500 });
    }

    // Trigger emergency contact notification if contacts configured
    if (tourist.emergencyContacts && tourist.emergencyContacts.length > 0) {
      const notificationPlan = await notifyEmergencyContacts(tourist.emergencyContacts, incidentId, {
        kind: 'sos',
        travellerName: tourist.name,
        location: { lat, lng },
      });
      await updateIncident(incidentId, { emergencyContactNotifications: notificationPlan });
    }

    // Broadcast to Supabase Realtime Gateway so police dashboard updates live
    await emitToGateway("incident:create", incidentRecord);

    return NextResponse.json({
      success: true,
      message: "Relayed SOS packet recorded in the Prahari authority queue.",
      incident: incidentRecord,
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
