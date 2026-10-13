import { NextRequest, NextResponse } from 'next/server';
import { canAccessTouristData, requireAuth } from '@/lib/auth/guards';
import { isCommunicationLanguageCode } from '@/lib/languages';
import { getIncident } from '@/lib/db';
import { translateCommunication } from '@/lib/services/multilingualCommunication';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, ['tourist', 'authority', 'admin', 'responder']);
  if (auth.errorResponse) return auth.errorResponse;
  try {
    const body = await request.json();
    const incidentId = typeof body.incidentId === 'string' ? body.incidentId.trim() : '';
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    const sourceLanguage = body.sourceLanguage === 'auto' ? 'auto' : body.sourceLanguage;
    const targetLanguage = body.targetLanguage;
    if (!incidentId || !text || text.length > 2_000) {
      return NextResponse.json({ success: false, error: 'An incident ID and up to 2,000 characters of text are required.' }, { status: 400 });
    }
    if ((sourceLanguage !== 'auto' && !isCommunicationLanguageCode(sourceLanguage)) || !isCommunicationLanguageCode(targetLanguage)) {
      return NextResponse.json({ success: false, error: 'Choose supported source and target languages.' }, { status: 400 });
    }

    const incident = await getIncident(incidentId);
    if (!incident) return NextResponse.json({ success: false, error: 'Incident not found.' }, { status: 404 });
    if (!canAccessTouristData(auth.session, incident.touristId)) {
      return NextResponse.json({ success: false, error: 'You are not authorised to translate this incident communication.' }, { status: 403 });
    }

    const result = await translateCommunication({ text, sourceLanguage, targetLanguage });
    return NextResponse.json({ success: true, ...result });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message || 'Translation could not be completed.' }, { status: 502 });
  }
}
