import { NextRequest, NextResponse } from "next/server";
import { insertIncident, listIncidents, updateIncident, getTourist, getIncident } from "@/lib/db";
import { availableResponders, findNearestResponder } from "@/lib/services/dispatchEngine";
import { emitToGateway } from "@/lib/services/gatewayEmit";
import { canAccessTouristData, requireAuth } from "@/lib/auth/guards";
import { notifyEmergencyContacts } from "@/lib/services/emergencyNotifications";
import { isFixtureIncident, operationalIncidents } from "@/lib/operationalData";
import { isTravellerAssistanceLanguageCode } from '@/lib/languages';
import { newIncidentId } from '@/lib/ids';

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, ['tourist', 'authority', 'admin', 'responder']);
  if (auth.errorResponse) return auth.errorResponse;

  const { session } = auth;

  try {
    const body = await request.json();
    const touristId = body.touristId ?? session.touristId;
    const touristName = body.touristName ?? session.name;
    const {
      type = "PANIC",
      location,
      lat,
      lng,
      severity = "CRITICAL",
      status = "ACTIVE",
      transportType = "INTERNET",
      hopCount = 0,
      originalTimestamp,
      relayPath,
      originDeviceId,
      packetId,
    } = body;
    const voiceStatement = typeof body.voiceStatement === 'string' ? body.voiceStatement.trim().slice(0, 2_000) : '';
    const voiceStatementLanguage = isTravellerAssistanceLanguageCode(body.voiceStatementLanguage)
      ? body.voiceStatementLanguage
      : null;

    const incidentLat = location?.lat ?? lat;
    const incidentLng = location?.lng ?? lng;
    const incidentId = body.incidentId ?? newIncidentId();

    if (!touristId) {
      return NextResponse.json({ success: false, error: 'An authenticated tourist identity is required.' }, { status: 400 });
    }
    if (!canAccessTouristData(session, touristId)) {
      return NextResponse.json({ success: false, error: 'You cannot create an incident for another tourist.' }, { status: 403 });
    }
    if (!Number.isFinite(incidentLat) || !Number.isFinite(incidentLng)) {
      return NextResponse.json({ success: false, error: 'A valid emergency location is required.' }, { status: 400 });
    }
    if (body.voiceStatement != null && !voiceStatement) {
      return NextResponse.json({ success: false, error: 'A voice SOS statement must contain text.' }, { status: 400 });
    }
    if (body.voiceStatement != null && !voiceStatementLanguage) {
      return NextResponse.json({ success: false, error: 'Choose a supported language for the voice SOS statement.' }, { status: 400 });
    }
    const tourist = await getTourist(touristId);
    if (!tourist) {
      return NextResponse.json({ success: false, error: 'Tourist record not found.' }, { status: 404 });
    }
    // A queued browser retry and a BLE gateway uplink can carry the same
    // packet. Treat the incident ID as the idempotency key so the traveller
    // does not receive duplicate contact notifications or case records.
    const existingIncident = await getIncident(incidentId);
    if (existingIncident) {
      if (existingIncident.touristId !== touristId) {
        return NextResponse.json({ success: false, error: 'An incident with this ID already exists.' }, { status: 409 });
      }
      return NextResponse.json({
        success: true,
        message: 'This SOS was already recorded in the Prahari authority queue.',
        incident: existingIncident,
        idempotent: true,
      });
    }
    // Only registered responders are matched; otherwise the desk assigns one.
    const match = findNearestResponder(incidentLat, incidentLng, await availableResponders());

    const initialMessages: any[] = [];
    if (voiceStatement) {
      initialMessages.push({
        version: 1,
        packetId: `PKT-VOICE-${incidentId}`,
        incidentId,
        touristId,
        type: 'SOS',
        severity,
        latitude: incidentLat,
        longitude: incidentLng,
        accuracy: 10,
        timestamp: Date.now(),
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
        ttl: 8,
        hopCount,
        originDeviceId: originDeviceId || 'WEB',
        lastKnownTransport: transportType || 'INTERNET',
        relayPath: relayPath || [],
        packetCategory: 'CHAT_MESSAGE',
        senderRole: 'tourist',
        senderName: `${tourist.name ?? touristName ?? 'Traveller'} (Voice SOS)`,
        chatText: voiceStatement,
        chatLanguage: voiceStatementLanguage || 'mr-IN',
      });
    }

    const incident = {
      incidentId,
      touristId,
      touristName: tourist.name ?? touristName ?? touristId,
      type,
      status,
      location: { lat: incidentLat, lng: incidentLng, ...(location?.address || body.address ? { address: location?.address ?? body.address } : {}) },
      severity,
      riskScore: severity === 'CRITICAL' ? 95 : 75,
      createdAt: new Date().toISOString(),
      assignedResponder: match?.responder?.id ?? null,
      assignedResponderUnitId: match?.responder?.unitId ?? null,
      assignedResponderName: match?.responder?.name ?? null,
      etaMinutes: match?.etaMinutes ?? null,
      resolvedAt: null,
      emergencyContactNotifications: null,
      // Mesh transport metadata:
      transportType,
      hopCount,
      originalTimestamp: originalTimestamp ?? new Date().toISOString(),
      relayPath: relayPath ?? [],
      originDeviceId: originDeviceId ?? null,
      packetId: packetId ?? null,
      // This is a reviewed text transcript, not a retained audio recording.
      // It gives authorised officers the speaker's own wording alongside an
      // explicitly labelled language for later translation.
      ...(voiceStatement ? { voiceStatement, voiceStatementLanguage } : {}),
      incidentMessages: initialMessages,
      ...(tourist.clothingProfile ? {
        emergencyIdentificationProfile: tourist.clothingProfile,
        emergencyIdentificationProfileSharedAt: new Date().toISOString(),
      } : {}),
      timeline: [
        { event: `SOS created via ${transportType} (Hops: ${hopCount})`, at: new Date().toISOString(), actor: session.name },
        ...(voiceStatement ? [{ event: 'Traveller reviewed and attached a voice SOS statement.', at: new Date().toISOString(), actor: session.name }] : []),
        ...(tourist.clothingProfile ? [{ event: 'Emergency identification profile attached for authorised case handling.', at: new Date().toISOString(), actor: 'system' }] : []),
      ],
    };

    if (!await insertIncident(incident as any)) {
      return NextResponse.json({ success: false, error: 'The emergency incident could not be recorded. Call local emergency services directly.' }, { status: 503 });
    }

    const notificationPlan = await notifyEmergencyContacts(tourist.emergencyContacts, incidentId, {
      kind: 'sos',
      travellerName: tourist.name,
      location: { lat: incidentLat, lng: incidentLng },
    });
    const updatedRecord = (await updateIncident(incidentId, { emergencyContactNotifications: notificationPlan })) ?? incident;

    // Notify the realtime gateway so the authority dashboard updates instantly
    await emitToGateway("incident:create", updatedRecord);

    // The incident is recorded whatever the contact notification did, so the
    // primary message must confirm that first. A contact-notification note is
    // appended only when it tells the traveller something they can act on.
    const notificationNote = notificationPlan.status === 'NO_CONTACTS' || notificationPlan.status === 'NO_EMAIL_CONTACTS'
      ? ''
      : ` ${notificationPlan.message}`;
    return NextResponse.json({
      success: true,
      message: `SOS recorded in the Prahari authority queue.${notificationNote}`,
      incident: updatedRecord,
      contactNotification: {
        status: notificationPlan.status,
        recipientCount: notificationPlan.contacts.length,
        message: notificationPlan.message,
      },
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth.errorResponse) return auth.errorResponse;

  const { session } = auth;

  try {
    // A traveller only ever sees their own incidents.
    const incidents = session.role === 'tourist'
      ? await listIncidents(20, session.touristId ?? session.userId)
      : operationalIncidents(await listIncidents(50));

    return NextResponse.json({ success: true, incidents });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

/**
 * Dispatch / status update. A tourist may only cancel their own active alert.
 */
export async function PATCH(request: NextRequest) {
  const auth = await requireAuth(request, ['tourist', 'responder', 'authority', 'admin']);
  if (auth.errorResponse) return auth.errorResponse;

  try {
    const body = await request.json();
    const { session } = auth;
    const { incidentId, status, assignedResponderUnitId, assignedResponderName, etaMinutes, action } = body;

    if (!incidentId) {
      return NextResponse.json({ success: false, error: "incidentId is required" }, { status: 400 });
    }

    const existing = await getIncident(incidentId);
    if (!existing) {
      return NextResponse.json({ success: false, error: 'Incident not found.' }, { status: 404 });
    }
    if (isFixtureIncident(existing)) {
      return NextResponse.json({ success: false, error: 'Fixture incidents cannot be changed through the operational workflow.' }, { status: 400 });
    }

    if (action === 'AUTO_DISPATCH') {
      if (!['authority', 'admin', 'responder'].includes(session.role)) {
        return NextResponse.json({ success: false, error: 'Only authorised operational users can dispatch a responder.' }, { status: 403 });
      }
      const lat = existing.location?.lat;
      const lng = existing.location?.lng;
      if (typeof lat !== 'number' || typeof lng !== 'number') {
        return NextResponse.json({ success: false, error: 'A reported incident location is required before dispatch.' }, { status: 400 });
      }
      const match = findNearestResponder(lat, lng, await availableResponders());
      if (!match) {
        return NextResponse.json({
          success: false,
          error: 'No available registered responder was found within the 15 km automatic-dispatch radius. The incident remains unassigned.',
        }, { status: 409 });
      }
      const updated = await updateIncident(incidentId, {
        status: 'DISPATCHED',
        assignedResponder: match.responder.id,
        assignedResponderUnitId: match.responder.unitId,
        assignedResponderName: match.responder.name,
        etaMinutes: match.etaMinutes,
        timeline: [
          ...(Array.isArray(existing.timeline) ? existing.timeline : []),
          {
            event: `Automatic dispatch assigned ${match.responder.unitId} within the 15 km response radius.`,
            at: new Date().toISOString(),
            actor: session.name,
            estimatedDistanceKm: match.distanceKm,
            estimatedEtaMinutes: match.etaMinutes,
          },
        ],
      });
      if (!updated) {
        return NextResponse.json({ success: false, error: 'The responder assignment could not be saved.' }, { status: 503 });
      }
      await emitToGateway("incident:update", updated);
      return NextResponse.json({ success: true, incident: updated, automaticDispatch: true });
    }
    if (action) {
      return NextResponse.json({ success: false, error: 'Unsupported incident action.' }, { status: 400 });
    }
    if (session.role === 'tourist') {
      if (status !== 'CANCELLED' || !canAccessTouristData(session, existing.touristId)) {
        return NextResponse.json({ success: false, error: 'Tourists may only cancel their own alert.' }, { status: 403 });
      }
    }

    const fields: Record<string, any> = {};
    if (status) fields.status = status;
    const isStaff = session.role !== 'tourist';
    if (isStaff && assignedResponderUnitId) fields.assignedResponderUnitId = String(assignedResponderUnitId).slice(0, 120);
    if (isStaff && assignedResponderName) fields.assignedResponderName = String(assignedResponderName).slice(0, 120);
    if (isStaff && typeof etaMinutes === "number") fields.etaMinutes = etaMinutes;
    if (fields.assignedResponderName) {
      fields.timeline = [
        ...(Array.isArray(existing.timeline) ? existing.timeline : []),
        {
          event: `Assigned ${fields.assignedResponderName}${typeof etaMinutes === 'number' ? ` (ETA ${etaMinutes} min)` : ''}.`,
          at: new Date().toISOString(),
          actor: session.name,
        },
      ];
    }
    if (status === "resolved" || status === "RESOLVED") fields.resolvedAt = new Date().toISOString();
    if (status === 'CANCELLED') {
      fields.cancelledAt = new Date().toISOString();
      fields.cancelledBy = session.name;
      fields.assignedResponder = null;
      fields.assignedResponderUnitId = null;
      fields.assignedResponderName = null;
    }

    if (Object.keys(fields).length === 0) {
      return NextResponse.json({ success: false, error: "No updatable fields supplied" }, { status: 400 });
    }

    const updated = await updateIncident(incidentId, fields);
    if (!updated) {
      return NextResponse.json(
        { success: false, error: `Incident ${incidentId} not found or database unavailable` },
        { status: 404 }
      );
    }

    await emitToGateway("incident:update", updated);

    return NextResponse.json({ success: true, incident: updated });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
