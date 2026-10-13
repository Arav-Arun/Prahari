import { newIncidentId } from '@/lib/ids';
import { NextRequest, NextResponse } from 'next/server';
import { listIncidentsWithEfir, upsertIncident, updateIncident, getTourist, getIncident } from '@/lib/db';
import { emitToGateway } from '@/lib/services/gatewayEmit';
import { canAccessTouristData, requireAuth } from '@/lib/auth/guards';
import { anchorEfirEvidence, verifyEfirEvidence } from '@/lib/blockchain/incidentEvidence';
import { operationalIncidents, isFixtureIncident } from '@/lib/operationalData';

export const dynamic = 'force-dynamic';

const PRAHARI_DRAFT_LEGAL_STATUS = {
  primaryReference: 'BNSS 2023, section 173 (information in cognizable cases)',
  filingStatus: 'NOT_FILED_WITH_POLICE',
  signatureRequirement: 'Electronic information relating to a cognizable offence must be signed by the informant within three days before it is taken on record.',
  stateFormat: 'The receiving State/UT police authority determines the applicable CCTNS/IIF-I or other prescribed format and whether FIR registration is appropriate.',
};

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, ['tourist', 'authority', 'admin', 'responder']);
  if (auth.errorResponse) return auth.errorResponse;
  const { session } = auth;

  try {
    const body = await request.json().catch(() => ({}));
    const {
      incidentId,
      passportAadhaar,
      incidentType = 'Incident information draft',
      location,
      clothingProfile,
      emergencyContact,
      occurrenceAt,
      narrative,
      reportLanguage = 'English',
      incidentCategory,
      reportType = 'INCIDENT_INFORMATION_DRAFT',
      suspectDescription = '',
      witnesses = [],
      stolenItems = [],
      injuries = '',
      evidence = [],
      callbackNumber,
      declarationAccepted = false,
    } = body;

    const touristId = body.touristId ?? session.touristId;
    const touristName = body.touristName ?? session.name;

    if (!touristId) {
      return NextResponse.json({ success: false, error: 'An authenticated tourist identity is required.' }, { status: 400 });
    }

    if (!canAccessTouristData(session, touristId)) {
      return NextResponse.json({ success: false, error: 'You can only prepare a report draft for your own identity.' }, { status: 403 });
    }
    if (!location || !Number.isFinite(location.lat) || !Number.isFinite(location.lng)) {
      return NextResponse.json({ success: false, error: 'A valid incident location is required.' }, { status: 400 });
    }
    if (typeof narrative !== 'string' || narrative.trim().length < 20) {
      return NextResponse.json({ success: false, error: 'Please provide at least 20 characters describing what happened.' }, { status: 400 });
    }
    if (!declarationAccepted) {
      return NextResponse.json({ success: false, error: 'The truthfulness declaration must be accepted before submission.' }, { status: 400 });
    }

    const tourist = await getTourist(touristId);
    if (!tourist) {
      return NextResponse.json({ success: false, error: 'Tourist record not found.' }, { status: 404 });
    }
    if (tourist.identityStatus !== 'verified') {
      return NextResponse.json({ success: false, error: 'A verified tourist record is required before preparing a police-ready draft.' }, { status: 409 });
    }
    const storedContact = tourist?.emergencyContacts?.[0];
    const contact = emergencyContact
      ? String(emergencyContact).slice(0, 200)
      : storedContact
        ? `${storedContact.name ?? 'Not supplied'}${storedContact.phone ? ` (${storedContact.phone})` : ''}`
        : 'Not supplied';
    const reportedAt = new Date().toISOString();
    const normalizedWitnesses = Array.isArray(witnesses)
      ? witnesses.slice(0, 5).map((w: any) => ({ name: String(w?.name ?? '').slice(0, 120), contact: String(w?.contact ?? '').slice(0, 80), statement: String(w?.statement ?? '').slice(0, 1000) }))
      : [];
    const normalizedEvidence = Array.isArray(evidence)
      ? evidence.slice(0, 10).map((item: any) => ({ type: String(item?.type ?? 'other').slice(0, 40), reference: String(item?.reference ?? '').slice(0, 500), description: String(item?.description ?? '').slice(0, 1000) }))
      : [];

    const efirId = `PDR-${new Date().getUTCFullYear()}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
    const draftEfIR = {
      efirId,
      incidentId: incidentId || newIncidentId(),
      touristId,
      touristName: tourist.name ?? touristName ?? touristId,
      passportAadhaar: passportAadhaar ? String(passportAadhaar).slice(0, 120) : null,
      incidentType,
      location,
      clothingProfile,
      emergencyContact: contact,
      callbackNumber: callbackNumber || null,
      occurrenceAt: occurrenceAt || null,
      reportedAt,
      reportLanguage,
      reportType: String(reportType).slice(0, 80),
      incidentCategory: incidentCategory || incidentType,
      narrative: narrative.trim(),
      suspectDescription: String(suspectDescription).slice(0, 2000),
      witnesses: normalizedWitnesses,
      stolenItems: Array.isArray(stolenItems) ? stolenItems.slice(0, 20) : [],
      injuries: String(injuries).slice(0, 2000),
      evidence: normalizedEvidence,
      declarationAccepted: true,
      declarationAcceptedAt: reportedAt,
      legalFramework: PRAHARI_DRAFT_LEGAL_STATUS,
      policeFilingStatus: 'NOT_FILED_WITH_POLICE',
      status: 'DRAFT_PENDING_AUTHORISED_REVIEW',
      // Kept for existing authority-screen compatibility. This denotes a
      // Prahari review only—not a police or CCTNS verification outcome.
      policeVerification: 'PENDING_AUTHORISED_REVIEW',
      createdAt: reportedAt,
      auditTrail: [{ event: 'SUBMITTED', at: reportedAt, actor: session.name, actorRole: session.role }],
    };

    // Attach the draft to the incident, creating a stub incident if absent.
    const existing = await getIncident(draftEfIR.incidentId);
    if (!await upsertIncident({
      ...(existing ?? {
        incidentId: draftEfIR.incidentId,
        touristId,
        touristName: draftEfIR.touristName,
        type: 'SOS',
        status: 'new',
        location,
        severity: 'critical',
      }),
      efirDraft: draftEfIR,
      timeline: [
        ...((existing?.timeline as any[]) ?? []),
        { event: 'Police-ready incident draft saved for authorised review; not filed with police.', at: reportedAt, actor: session.name },
      ],
    })) {
      return NextResponse.json({ success: false, error: 'The incident information draft could not be saved for authorised review.' }, { status: 503 });
    }

    return NextResponse.json({
      success: true,
      message: 'Police-ready incident draft saved to Prahari’s authorised review queue. It has not been filed with a police authority.',
      efir: draftEfIR,
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, ['tourist', 'authority', 'admin', 'responder']);
  if (auth.errorResponse) return auth.errorResponse;
  const { session } = auth;

  try {
    const incidentId = new URL(request.url).searchParams.get('incidentId');
    if (incidentId) {
      const incident = await getIncident(incidentId);
      if (!incident?.efirDraft || isFixtureIncident(incident)) return NextResponse.json({ success: false, error: 'Incident information draft not found.' }, { status: 404 });
      if (session.role === 'tourist' && incident.touristId !== session.touristId) {
        return NextResponse.json({ success: false, error: 'Unauthorised.' }, { status: 403 });
      }
      return NextResponse.json({ success: true, evidence: await verifyEfirEvidence(incidentId, incident.efirDraft), efir: incident.efirDraft });
    }
    let incidentsWithEfir = operationalIncidents(await listIncidentsWithEfir());
    if (session.role === 'tourist') {
      incidentsWithEfir = incidentsWithEfir.filter((i: any) => i.touristId === session.touristId);
    }

    return NextResponse.json({ success: true, efirs: incidentsWithEfir.map((i) => ({ ...i.efirDraft, _incidentId: i.incidentId })) });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

/**
 * Authorised-review step for a Prahari incident information draft.
 * Accepts: { incidentId, action: 'APPROVE' | 'REJECT', officerName?, officerBadge?, remarks? }
 */
export async function PATCH(request: NextRequest) {
  const auth = await requireAuth(request, ['authority', 'admin']);
  if (auth.errorResponse) return auth.errorResponse;

  const { session } = auth;

  try {
    const body = await request.json();
    const { incidentId, action, officerName = session.name, officerBadge = session.badge || 'AUTH-001', remarks } = body;

    if (!incidentId || !action) {
      return NextResponse.json(
        { success: false, error: "incidentId and action ('APPROVE' or 'REJECT') are required" },
        { status: 400 }
      );
    }

    if (!['APPROVE', 'REJECT'].includes(action)) {
      return NextResponse.json(
        { success: false, error: "action must be 'APPROVE' or 'REJECT'" },
        { status: 400 }
      );
    }

    // Find the incident with the Prahari draft.
    const incident = await getIncident(incidentId);

    if (!incident?.efirDraft || isFixtureIncident(incident)) {
      return NextResponse.json(
        { success: false, error: `Incident ${incidentId} not found or has no incident information draft` },
        { status: 404 }
      );
    }

    const now = new Date().toISOString();
    const event = action === 'APPROVE' ? 'AUTHORISED_REVIEWED' : 'RETURNED_FOR_CORRECTION';
    const draftForAnchor = {
      ...incident.efirDraft,
      policeVerification: action === 'APPROVE' ? 'AUTHORISED_REVIEWED' : 'RETURNED_FOR_CORRECTION',
      status: action === 'APPROVE' ? 'DRAFT_REVIEWED' : 'DRAFT_RETURNED_FOR_CORRECTION',
      policeFilingStatus: incident.efirDraft.policeFilingStatus ?? 'NOT_FILED_WITH_POLICE',
      reviewedAt: now,
      reviewedBy: officerName || 'Authority Officer',
      officerBadge: officerBadge || null,
      remarks: remarks ? String(remarks).slice(0, 2000) : null,
      auditTrail: [
        ...(incident.efirDraft.auditTrail ?? []),
        { event, at: now, actor: officerName || 'Authority Officer', actorBadge: officerBadge || null, remarks: remarks ? String(remarks).slice(0, 2000) : null },
      ],
    };
    const anchor = action === 'APPROVE' ? await anchorEfirEvidence(incidentId, draftForAnchor) : null;
    const updatedDraft = {
      ...draftForAnchor,
      blockchainEvidence: anchor
        ? { status: 'ANCHORED', ...anchor }
        : action === 'APPROVE'
          ? { status: 'PENDING_ANCHOR', attemptedAt: now }
          : incident.efirDraft.blockchainEvidence ?? null,
    };

    const updated = await updateIncident(incidentId, {
      efirDraft: updatedDraft,
      timeline: [
        ...(incident.timeline ?? []),
        { event: `Police-ready incident draft ${action === 'APPROVE' ? 'reviewed' : 'returned for correction'}; not filed with police.`, at: now, actor: officerName || 'Authority Officer', remarks: remarks || null },
      ],
    });

    if (!updated) {
      return NextResponse.json(
        { success: false, error: 'Failed to update incident' },
        { status: 500 }
      );
    }

    await emitToGateway('incident:update', { incidentId, efirDraft: updatedDraft });

    return NextResponse.json({
      success: true,
      message: `Police-ready draft ${action === 'APPROVE' ? 'reviewed' : 'returned for correction'} by ${officerName || 'Authority Officer'}. This is not a police filing acknowledgement.`,
      efir: updatedDraft,
      blockchain: updatedDraft.blockchainEvidence,
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
