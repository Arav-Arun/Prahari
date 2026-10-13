import { NextRequest, NextResponse } from "next/server";
import { isValidSOSPacket, SOSPacket } from "@/lib/sos-mesh/sosPacket";
import { emitToGateway } from "@/lib/services/gatewayEmit";
import { updateIncident, getIncident } from '@/lib/db';
import { canAccessTouristData, requireAuth } from '@/lib/auth/guards';

// Short-lived cache only; the protected incident record is the durable source.
const serverChatThreads = new Map<string, SOSPacket[]>();

/**
 * GET /api/chat-relay?incidentId=INC-1234
 * Fetches the emergency chat transcript for an active incident.
 */
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, ['tourist', 'authority', 'admin', 'responder']);
  if (auth.errorResponse) return auth.errorResponse;
  try {
    const { searchParams } = new URL(request.url);
    const incidentId = searchParams.get("incidentId");

    if (!incidentId) {
      return NextResponse.json({ success: false, error: "incidentId is required" }, { status: 400 });
    }

    const incident = await getIncident(incidentId);
    if (!incident) return NextResponse.json({ success: false, error: 'Incident not found.' }, { status: 404 });
    if (!canAccessTouristData(auth.session, incident.touristId)) {
      return NextResponse.json({ success: false, error: 'You are not authorised to read this incident communication.' }, { status: 403 });
    }

    let messages = Array.isArray(incident.incidentMessages)
      ? [...incident.incidentMessages]
      : [...(serverChatThreads.get(incidentId) ?? [])];

    if (incident.voiceStatement && !messages.some((m: any) => m.packetId?.startsWith('PKT-VOICE-') || m.chatText === incident.voiceStatement)) {
      const voicePacket = {
        version: 1,
        packetId: `PKT-VOICE-${incidentId}`,
        incidentId,
        touristId: incident.touristId,
        type: 'SOS',
        severity: incident.severity || 'CRITICAL',
        latitude: incident.location?.lat ?? null,
        longitude: incident.location?.lng ?? null,
        accuracy: 10,
        timestamp: typeof incident.createdAt === 'string' ? new Date(incident.createdAt).getTime() : Date.now(),
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
        ttl: 8,
        hopCount: 0,
        originDeviceId: 'WEB',
        lastKnownTransport: incident.transportType || 'INTERNET',
        relayPath: [],
        packetCategory: 'CHAT_MESSAGE',
        senderRole: 'tourist',
        senderName: `${incident.touristName || 'Traveller'} (Voice SOS)`,
        chatText: incident.voiceStatement,
        chatLanguage: incident.voiceStatementLanguage || 'mr-IN',
      };
      messages = [voicePacket, ...messages];
    }

    return NextResponse.json({ success: true, messages });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

/**
 * POST /api/chat-relay
 * Receives an incoming offline/online chat message packet, persists it, and broadcasts to Realtime.
 */
export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, ['tourist', 'authority', 'admin', 'responder']);
  if (auth.errorResponse) return auth.errorResponse;
  try {
    const body = await request.json();
    const packet = (body.packet ?? body) as SOSPacket;

    if (!isValidSOSPacket(packet)) {
      return NextResponse.json({ success: false, error: "Invalid chat packet schema." }, { status: 400 });
    }
    if (packet.packetCategory !== 'CHAT_MESSAGE' || typeof packet.chatText !== 'string' || !packet.chatText.trim() || packet.chatText.length > 2_000) {
      return NextResponse.json({ success: false, error: 'A valid emergency chat message is required.' }, { status: 400 });
    }

    const incidentId = packet.incidentId;
    if (!incidentId) {
      return NextResponse.json({ success: false, error: "incidentId required in packet." }, { status: 400 });
    }

    const incident = await getIncident(incidentId);
    if (!incident) return NextResponse.json({ success: false, error: 'Incident not found.' }, { status: 404 });
    if (!canAccessTouristData(auth.session, incident.touristId)) {
      return NextResponse.json({ success: false, error: 'You are not authorised to send this incident communication.' }, { status: 403 });
    }

    // Never trust the client to claim an authority identity, a sender name, or
    // a different tourist's chat thread. The relay packet keeps its transport
    // metadata but the authenticated server assigns communication identity.
    packet.touristId = incident.touristId;
    packet.senderRole = auth.session.role === 'tourist' ? 'tourist' : 'authority';
    packet.senderName = auth.session.name || (packet.senderRole === 'authority' ? 'Authority desk' : 'Traveller');
    packet.lastKnownTransport = 'INTERNET';

    const existingList = Array.isArray(incident.incidentMessages)
      ? [...incident.incidentMessages] as SOSPacket[]
      : [...(serverChatThreads.get(incidentId) ?? [])];
    const exists = existingList.some((m) => m.packetId === packet.packetId);

    if (!exists) {
      existingList.push(packet);
      serverChatThreads.set(incidentId, existingList);
      const stored = await updateIncident(incidentId, {
        incidentMessages: existingList.slice(-100),
      });
      if (!stored) {
        return NextResponse.json({ success: false, error: 'The emergency message could not be saved.' }, { status: 503 });
      }
    }

    // Broadcast live over Realtime Gateway to authority console and citizen UI
    await emitToGateway("chat:message", packet);

    return NextResponse.json({
      success: true,
      message: "Chat packet recorded by the Prahari authority server.",
      packet,
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
