import { NextRequest, NextResponse } from "next/server";
import { kycProvider } from "@/lib/kyc/sandboxProvider";
import { issueCredential } from "@/lib/identity/credential";
import {
  upsertTourist, getTourist, getTouristBySubjectHash, logCredentialIssuance, updateTourist, isSupabaseConfigured,
} from "@/lib/db";
import { createSessionToken, setSessionCookie } from "@/lib/auth/session";
import { anchorCredential } from "@/lib/blockchain/registry";
import { isCommunicationLanguageCode } from '@/lib/languages';
import { hashPassword, verifyPassword } from '@/lib/auth/crypto';
import { randomBytes } from 'node:crypto';

export const dynamic = "force-dynamic";

/**
 * Human-readable tourist id, DTI-<ISO3>-<6 digits>, derived from the document
 * hash. Six digits can collide, so later slices of the hash are tried until the
 * id is unused; otherwise a second traveller would overwrite the first.
 */
async function allocateTouristId(nationalityCode: string, subjectHash: string): Promise<string> {
  for (let offset = 0; offset + 8 <= subjectHash.length; offset += 8) {
    const n = parseInt(subjectHash.slice(offset, offset + 8), 16) % 1_000_000;
    const touristId = `DTI-${nationalityCode}-${String(n).padStart(6, "0")}`;
    if (!(await getTourist(touristId))) return touristId;
  }
  throw new Error("Could not allocate a tourist ID. Please try again.");
}

export async function POST(request: NextRequest) {
  try {
    const { sessionId, otp, emergencyContacts, accommodation, itinerary, visitEndsAt, trackingConsent, communicationLanguage, recoveryAccessCode: suppliedRecoveryAccessCode } = await request.json();
    if (!sessionId) {
      return NextResponse.json({ ok: false, error: "sessionId is required." }, { status: 400 });
    }

    // Re-verify rather than trusting the client's claim that KYC succeeded.
    const verification = await kycProvider.verify({ sessionId, otp });
    if (!verification.ok) {
      return NextResponse.json({ ok: false, error: verification.error }, { status: 400 });
    }

    const subject = verification.subject;
    const normalizedEmergencyContacts = Array.isArray(emergencyContacts)
      ? emergencyContacts
        .slice(0, 5)
        .map((contact: any) => ({
          name: String(contact?.name ?? 'Emergency contact').trim().slice(0, 120) || 'Emergency contact',
          relationship: String(contact?.relationship ?? 'Emergency contact').trim().slice(0, 80) || 'Emergency contact',
          phone: String(contact?.phone ?? '').trim().slice(0, 40) || undefined,
          email: String(contact?.email ?? '').trim().toLowerCase().slice(0, 254) || undefined,
        }))
        .filter((contact: any) => contact.phone || contact.email)
      : [];
    if (normalizedEmergencyContacts.some((contact: any) => contact.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email))) {
      return NextResponse.json({ ok: false, error: 'Each emergency-contact email must be valid.' }, { status: 400 });
    }

    // Same document -> same DID. Re-enrolment updates rather than duplicates.
    const existing = await getTouristBySubjectHash(subject.subjectHash);
    const touristId = existing?.touristId ?? await allocateTouristId(subject.nationalityCode, subject.subjectHash);

    // Re-enrolment overwrites the record this document already points at —
    // its name, DID, credential and recovery code. Presenting the document is
    // not enough to authorise that, or anyone re-running onboarding with a
    // number someone else already used would take over their identity and
    // lock them out. The holder must prove possession of the current code.
    if (existing?.touristAccessCodeHash && existing?.touristAccessCodeSalt) {
      const suppliedRecoveryCode = String(suppliedRecoveryAccessCode ?? '').trim();
      if (!suppliedRecoveryCode) {
        return NextResponse.json({
          ok: false,
          error: 'This document is already enrolled. Enter the recovery code issued at that enrolment to update the existing record.',
          requiresRecoveryCode: true,
        }, { status: 409 });
      }
      if (
        suppliedRecoveryCode.length > 200 ||
        !verifyPassword(suppliedRecoveryCode, existing.touristAccessCodeHash, existing.touristAccessCodeSalt)
      ) {
        return NextResponse.json({
          ok: false,
          error: 'That recovery code does not match the enrolment already held for this document.',
          requiresRecoveryCode: true,
        }, { status: 401 });
      }
    }

    if (communicationLanguage !== undefined && !isCommunicationLanguageCode(communicationLanguage)) {
      return NextResponse.json({ ok: false, error: 'Choose a supported preferred communication language.' }, { status: 400 });
    }
    const preferences = {
      ...(existing?.preferences && typeof existing.preferences === 'object' ? existing.preferences : {}),
      ...(communicationLanguage ? { language: communicationLanguage } : {}),
    };

    const requestedVisitEnd = typeof visitEndsAt === 'string' ? new Date(visitEndsAt) : null;
    if (requestedVisitEnd && (!Number.isFinite(requestedVisitEnd.getTime()) || requestedVisitEnd.getTime() <= Date.now())) {
      return NextResponse.json({ ok: false, error: 'Visit end date must be in the future.' }, { status: 400 });
    }
    const normalizedItinerary = itinerary && typeof itinerary === 'object'
      ? {
        ...(requestedVisitEnd ? { visitEndsAt: requestedVisitEnd.toISOString() } : {}),
        ...(typeof itinerary.summary === 'string' ? { summary: itinerary.summary.trim().slice(0, 1_000) } : {}),
        ...(Array.isArray(itinerary.route)
          ? {
            route: itinerary.route.slice(0, 100).filter((point: any) =>
              Number.isFinite(point?.lat) && Number.isFinite(point?.lng)
            ).map((point: any) => ({ lat: Number(point.lat), lng: Number(point.lng) }))
          }
          : {}),
      }
      : requestedVisitEnd
        ? { visitEndsAt: requestedVisitEnd.toISOString() }
        : undefined;

    const issued = issueCredential(subject, touristId, kycProvider.id, kycProvider.isSandbox, {
      expiresAt: normalizedItinerary?.visitEndsAt ?? existing?.itinerary?.visitEndsAt,
    });
    // A returning traveller must prove possession of this one-time-issued
    // recovery code. The raw value is shown only in this response; the database
    // receives a salted PBKDF2 hash, never the code itself.
    const recoveryAccessCode = randomBytes(18).toString('base64url');
    const recoveryCode = hashPassword(recoveryAccessCode);

    const saved = await upsertTourist({
      touristId,
      name: subject.fullName,
      nationality: subject.nationality,
      nationalityCode: subject.nationalityCode,
      identityStatus: "verified",
      did: issued.did,
      issueDate: new Date().toISOString().slice(0, 10),
      didDocument: issued.didDocument,
      credential: issued.credential,
      credentialHash: issued.credentialHash,
      credentialStatus: "active",
      kycMethod: subject.documentType,
      kycProvider: kycProvider.id,
      kycVerifiedAt: new Date().toISOString(),
      kycSubjectHash: subject.subjectHash,
      touristAccessCodeHash: recoveryCode.hash,
      touristAccessCodeSalt: recoveryCode.salt,
      trackingConsent: trackingConsent ?? true,
      ...(Object.keys(preferences).length ? { preferences } : {}),
      ...(normalizedEmergencyContacts.length ? { emergencyContacts: normalizedEmergencyContacts } : {}),
      ...(accommodation ? { accommodation } : {}),
      ...(normalizedItinerary ? { itinerary: normalizedItinerary } : {}),
      ...(existing ? {} : { createdAt: new Date().toISOString() }),
    });

    if (!saved) {
      return NextResponse.json(
        { ok: false, error: "Credential was issued but could not be saved." },
        { status: 500 }
      );
    }

    const issuanceLogged = await logCredentialIssuance({
      touristId,
      did: issued.did,
      credentialHash: issued.credentialHash,
      kycMethod: subject.documentType,
      kycProvider: kycProvider.id,
      action: existing ? "reinstated" : "issued",
    });
    if (!issuanceLogged) {
      return NextResponse.json(
        { ok: false, error: "Credential was saved, but its issuance audit entry could not be recorded." },
        { status: 503 }
      );
    }

    // Anchor the credential hash on-chain (best-effort — never blocks issuance).
    // Only the hash goes on-chain; no PII. Returns null if no chain is configured.
    let anchor: { txHash: string; chainId: number; alreadyAnchored?: boolean } | null = null;
    try {
      const result = await anchorCredential(issued.credentialHash, issued.expiresAt);
      if (result) {
        anchor = result;
        if (result.txHash) {
          await updateTourist(touristId, {
            anchorTxHash: result.txHash,
            anchorChainId: result.chainId,
          });
        }
      }
    } catch (err) {
      console.warn("[prahari] anchoring skipped:", err);
    }

    const sessionToken = await createSessionToken({
      userId: touristId,
      role: 'tourist',
      name: subject.fullName,
      touristId,
      entityId: touristId,
      did: issued.did,
    });

    const response = NextResponse.json({
      ok: true,
      touristId,
      did: issued.did,
      credentialHash: issued.credentialHash,
      expiresAt: issued.expiresAt,
      credential: issued.credential,
      reissued: Boolean(existing),
      anchorTxHash: anchor?.txHash || null,
      anchorChainId: anchor?.chainId ?? null,
      anchored: Boolean(anchor),
      recoveryAccessCode,
    });

    setSessionCookie(response, sessionToken);

    return response;
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}
