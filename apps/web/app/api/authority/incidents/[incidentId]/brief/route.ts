import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/guards';
import { getIncident } from '@/lib/db';
import { isFixtureIncident } from '@/lib/operationalData';
import { createIncidentBrief } from '@/lib/services/multilingualCommunication';
import { isCommunicationLanguageCode } from '@/lib/languages';

export const dynamic = 'force-dynamic';

export async function POST(_request: NextRequest, context: { params: Promise<{ incidentId: string }> }) {
  const auth = await requireAuth(_request, ['authority', 'admin', 'responder']);
  if (auth.errorResponse) return auth.errorResponse;
  try {
    const { incidentId } = await context.params;
    const body = await _request.json().catch(() => ({}));
    const outputLanguage = body?.outputLanguage ?? 'en-IN';
    if (!incidentId || incidentId.length > 120) {
      return NextResponse.json({ success: false, error: 'A valid incident ID is required.' }, { status: 400 });
    }
    if (!isCommunicationLanguageCode(outputLanguage)) {
      return NextResponse.json({ success: false, error: 'Choose a supported incident-brief language.' }, { status: 400 });
    }
    const incident = await getIncident(incidentId);
    if (!incident) return NextResponse.json({ success: false, error: 'Incident not found.' }, { status: 404 });
    if (isFixtureIncident(incident)) {
      return NextResponse.json({ success: false, error: 'AI briefs are available only for live incident records.' }, { status: 400 });
    }
    const brief = await createIncidentBrief(incident, outputLanguage);
    return NextResponse.json({ success: true, incidentId, outputLanguage, brief, provider: 'sarvam_ai' });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message || 'The AI incident brief could not be generated.' }, { status: 502 });
  }
}
