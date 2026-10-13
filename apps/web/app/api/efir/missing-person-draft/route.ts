import { NextRequest, NextResponse } from 'next/server';
import { getTourist, listLocations, updateIncident, getIncident } from '@/lib/db';
import { isFixtureIncident } from '@/lib/operationalData';
import { canAccessTouristData, requireAuth } from '@/lib/auth/guards';

import { buildMissingPersonDraft } from '@/lib/services/missingPersonDraft';
import { emitToGateway } from '@/lib/services/gatewayEmit';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, ['authority', 'admin', 'responder']);
  if (auth.errorResponse) return auth.errorResponse;
  try {
    const body = await request.json().catch(() => ({}));
    const incidentId = typeof body.incidentId === 'string' ? body.incidentId.trim() : '';
    if (!incidentId) return NextResponse.json({ success: false, error: 'Select an incident before preparing a missing-person draft.' }, { status: 400 });

    const incident = await getIncident(incidentId);
    if (!incident || isFixtureIncident(incident)) return NextResponse.json({ success: false, error: 'Incident not found.' }, { status: 404 });
    if (!canAccessTouristData(auth.session, incident.touristId)) return NextResponse.json({ success: false, error: 'You are not authorised to access this tourist record.' }, { status: 403 });

    const tourist = await getTourist(incident.touristId);
    if (!tourist || tourist.identityStatus !== 'verified') {
      return NextResponse.json({ success: false, error: 'A verified tourist record is required to create this draft.' }, { status: 409 });
    }
    const [lastLocation] = await listLocations(tourist.touristId, 1);
    const draft = buildMissingPersonDraft({ tourist, incident, lastLocation, generatedBy: auth.session.name });
    const now = new Date().toISOString();
    const updated = await updateIncident(incidentId, {
      missingPersonDraft: draft,
      timeline: [...(incident.timeline ?? []), {
        event: 'Missing-person information draft generated for authorised review; not filed with police.',
        at: now,
        actor: auth.session.name,
      }],
    });
    if (!updated) return NextResponse.json({ success: false, error: 'The draft could not be saved to the incident.' }, { status: 503 });
    await emitToGateway('incident:update', { incidentId, missingPersonDraft: draft });
    return NextResponse.json({ success: true, draft, incident: updated });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message || 'Missing-person draft generation failed.' }, { status: 500 });
  }
}
