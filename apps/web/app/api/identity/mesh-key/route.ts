import { NextRequest, NextResponse } from 'next/server';
import { getTourist, updateTourist } from '@/lib/db';
import { canAccessTouristData, requireAuth } from '@/lib/auth/guards';
import {
  MESH_PUBKEY_FIELD,
  normalizeMeshPubkey,
  registeredMeshPubkeys,
  withRegisteredMeshPubkey,
} from '@/lib/sos-mesh/meshTrust';

/**
 * Registers a device's mesh public key against a tourist record.
 *
 * Only the public half is ever sent; the secret stays in the traveller's
 * browser. Registering is what later lets a stranger's phone relay this
 * traveller's SOS — the gateway trusts the signature, and this is where it
 * learns which keys count.
 */
export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, ['tourist', 'authority', 'admin', 'responder']);
  if (auth.errorResponse) return auth.errorResponse;

  try {
    const body = await request.json();
    const pubkey = normalizeMeshPubkey(body?.pubkey);
    const touristId = typeof body?.touristId === 'string' ? body.touristId : null;

    if (!pubkey) {
      return NextResponse.json({ success: false, error: 'A 32-byte hex mesh public key is required.' }, { status: 400 });
    }
    if (!touristId) {
      return NextResponse.json({ success: false, error: 'touristId is required.' }, { status: 400 });
    }
    if (!canAccessTouristData(auth.session, touristId)) {
      return NextResponse.json({ success: false, error: 'You are not authorised to register a mesh key for this tourist.' }, { status: 403 });
    }

    let tourist = await getTourist(touristId);
    if (!tourist) {
      await updateTourist(touristId, { touristId, name: 'Traveller' });
      tourist = await getTourist(touristId) ?? { touristId, name: 'Traveller' };
    }

    const existing = registeredMeshPubkeys(tourist);
    if (existing.includes(pubkey)) {
      return NextResponse.json({ success: true, message: 'Mesh key already registered.', registeredKeys: existing.length });
    }

    const updated = withRegisteredMeshPubkey(existing, pubkey);
    const saved = await updateTourist(touristId, { [MESH_PUBKEY_FIELD]: updated });
    if (!saved) {
      // Almost always a pending schema migration rather than a transient fault,
      // so say which one instead of a bare 500.
      return NextResponse.json({
        success: false,
        error: 'Could not save the mesh device key. If the tourists.meshPubkeys column is missing, add it from supabase/schema.sql — /api/health lists any outstanding columns.',
      }, { status: 503 });
    }

    return NextResponse.json({
      success: true,
      message: 'Mesh device key registered. Nearby devices can now relay this traveller’s SOS.',
      registeredKeys: updated.length,
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
