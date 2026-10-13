import type {
  KycProvider, KycInitiateInput, KycInitiateResult, KycVerifyInput, KycVerifyResult, KycSubject,
} from './types';
import { validateAadhaar } from './verhoeff';
import { parsePassportMrz } from './passportMrz';
import { hashSubject, hashChallenge, safeEqual, newSessionId, newOtp } from './hash';
import {
  createKycSession, getKycSession, markKycSessionVerified,
  markKycSessionFailed, incrementKycAttempts,
} from '../db';

/** OTP lifetime. Real UIDAI OTPs expire in 10 minutes. */
const OTP_TTL_MS = 10 * 60 * 1000;
/** Passport sessions resolve immediately; short TTL guards the issue step. */
const PASSPORT_TTL_MS = 15 * 60 * 1000;

/** MRZ names are upper-case by specification; store them as people write them. */
const titleCase = (name: string) => name.toLowerCase().replace(/(^|[\s'-])\p{L}/gu, (m) => m.toUpperCase());

const ISO3_TO_NAME: Record<string, string> = {
  IND: 'India', USA: 'United States', GBR: 'United Kingdom', AUS: 'Australia',
  CAN: 'Canada', DEU: 'Germany', FRA: 'France', JPN: 'Japan', SGP: 'Singapore',
  ARE: 'United Arab Emirates', NPL: 'Nepal', LKA: 'Sri Lanka', BGD: 'Bangladesh',
  CHN: 'China', ITA: 'Italy', ESP: 'Spain', NLD: 'Netherlands', RUS: 'Russia',
  ZAF: 'South Africa', BRA: 'Brazil', UTO: 'Utopia (ICAO specimen)',
};

/**
 * Simulated UIDAI / passport verification.
 *
 * What is REAL here:
 *   - Aadhaar Verhoeff checksum validation (rejects invented numbers)
 *   - ICAO 9303 MRZ check-digit validation (rejects mistyped passports)
 *   - OTP challenge/response, TTL expiry, attempt limiting, lockout
 *   - Salted-hash-only storage of document numbers
 *
 * What is SIMULATED:
 *   - The OTP is not delivered by SMS; it is returned in the response
 *   - No demographic data is fetched from UIDAI, so the holder's name is
 *     self-asserted and recorded as such on the credential
 */
class SandboxKycProvider implements KycProvider {
  readonly id = 'prahari-sandbox-v1';
  readonly isSandbox = true;

  async initiate(input: KycInitiateInput): Promise<KycInitiateResult> {
    return input.method === 'aadhaar' ? this.initiateAadhaar(input) : this.initiatePassport(input);
  }

  private async initiateAadhaar(input: KycInitiateInput): Promise<KycInitiateResult> {
    const fullName = (input.fullName ?? '').trim();
    if (fullName.length < 2) {
      return { ok: false, error: 'Please enter the name as printed on your Aadhaar.' };
    }

    const check = validateAadhaar(input.aadhaarNumber ?? '');
    if (!check.valid) return { ok: false, error: check.reason };

    const digits = (input.aadhaarNumber ?? '').replace(/[\s-]/g, '');
    const subjectHash = hashSubject(digits, 'aadhaar');
    const sessionId = newSessionId();
    const otp = newOtp();
    const expiresAt = new Date(Date.now() + OTP_TTL_MS).toISOString();

    const created = await createKycSession({
      sessionId,
      method: 'aadhaar',
      status: 'pending',
      subjectHash,
      challengeHash: hashChallenge(otp, sessionId),
      expiresAt,
      // Note: the raw Aadhaar number is deliberately absent from this payload.
      payload: { fullName, maskedDocument: check.masked, nationalityCode: 'IND' },
    });
    if (!created) return { ok: false, error: 'Could not start verification. Please try again.' };

    return {
      ok: true,
      sessionId,
      requiresOtp: true,
      maskedTarget: check.masked,
      expiresAt,
      sandboxOtp: otp, // sandbox only — a licensed provider would SMS this
    };
  }

  private async initiatePassport(input: KycInitiateInput): Promise<KycInitiateResult> {
    const parsed = parsePassportMrz(input.mrzLine1 ?? '', input.mrzLine2 ?? '');
    if (!parsed.valid) return { ok: false, error: parsed.reason };

    const d = parsed.data;
    const subjectHash = hashSubject(d.documentNumber, 'passport');
    const sessionId = newSessionId();
    const expiresAt = new Date(Date.now() + PASSPORT_TTL_MS).toISOString();

    const subject: KycSubject = {
      fullName: titleCase([d.givenNames, d.surname].filter(Boolean).join(' ')),
      nationality: ISO3_TO_NAME[d.nationality] ?? d.nationality,
      nationalityCode: d.nationality,
      dateOfBirth: d.dateOfBirth,
      sex: d.sex,
      documentType: 'passport',
      maskedDocument: `${d.documentNumber.slice(0, 2)}${'X'.repeat(Math.max(0, d.documentNumber.length - 4))}${d.documentNumber.slice(-2)}`,
      subjectHash,
      meta: {
        issuingState: d.issuingState,
        expiryDate: d.expiryDate,
        mrzChecks: d.checks,
        validation: 'ICAO 9303 check digits verified',
      },
    };

    const created = await createKycSession({
      sessionId,
      method: 'passport',
      status: 'verified', // MRZ validation is self-contained; no second factor
      subjectHash,
      challengeHash: null,
      expiresAt,
      payload: subject as unknown as Record<string, unknown>,
    });
    if (!created) return { ok: false, error: 'Could not start verification. Please try again.' };

    // No OTP step: the check digits already validated the document.
    return { ok: true, sessionId, requiresOtp: false, expiresAt, subject };
  }

  async verify({ sessionId, otp }: KycVerifyInput): Promise<KycVerifyResult> {
    const session = await getKycSession(sessionId);
    if (!session) return { ok: false, error: 'Verification session not found.' };

    if (session.status === 'locked') {
      return { ok: false, error: 'Too many incorrect attempts. Start verification again.', locked: true };
    }
    if (new Date(session.expiresAt) < new Date()) {
      await markKycSessionFailed(sessionId, 'expired');
      return { ok: false, error: 'This verification session has expired. Start again.' };
    }

    // Passport sessions are already verified at initiate().
    if (session.method === 'passport') {
      if (session.status !== 'verified') return { ok: false, error: 'Passport verification did not complete.' };
      return { ok: true, subject: session.payload as KycSubject };
    }

    if (!otp) return { ok: false, error: 'Enter the 6-digit OTP.' };

    const cleanOtp = String(otp || '').replace(/\D/g, '');
    const expected = session.challengeHash;
    const isOtpValid = Boolean(expected) && safeEqual(hashChallenge(cleanOtp, sessionId), expected);

    if (!isOtpValid) {
      const attempts = await incrementKycAttempts(sessionId);
      const remaining = Math.max(0, (session.maxAttempts ?? 3) - attempts);
      if (remaining <= 0) {
        await markKycSessionFailed(sessionId, 'locked');
        return { ok: false, error: 'Too many incorrect attempts. Start verification again.', locked: true };
      }
      return { ok: false, error: `Incorrect OTP. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`, attemptsRemaining: remaining };
    }

    await markKycSessionVerified(sessionId);

    const p = (session.payload ?? {}) as Record<string, any>;
    return {
      ok: true,
      subject: {
        fullName: p.fullName,
        nationality: 'India',
        nationalityCode: 'IND',
        documentType: 'aadhaar',
        maskedDocument: p.maskedDocument,
        subjectHash: session.subjectHash,
        meta: {
          validation: 'Verhoeff checksum verified; OTP challenge passed',
          nameSource: 'self-asserted (sandbox provider returns no demographic data)',
        },
      },
    };
  }
}

export const kycProvider: KycProvider = new SandboxKycProvider();
