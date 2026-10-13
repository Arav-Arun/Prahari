/**
 * ICAO 9303 TD3 Machine Readable Zone parser and validator.
 *
 * TD3 is the passport format: two lines of exactly 44 characters. Every
 * passport's MRZ carries check digits computed with a 7-3-1 weighting, which
 * lets us verify the document number, date of birth, expiry date, and a
 * composite across all of them — entirely offline, no third-party service.
 *
 * This validates the document's internal consistency. It proves the MRZ was
 * not mistyped or fabricated at random; it does not prove the passport is
 * genuine, which would require an issuing-authority check.
 */

const WEIGHTS = [7, 3, 1];

/** ICAO 9303 character value: digits are themselves, A–Z are 10–35, '<' is 0. */
function charValue(ch: string): number {
  if (ch >= '0' && ch <= '9') return ch.charCodeAt(0) - 48;
  if (ch >= 'A' && ch <= 'Z') return ch.charCodeAt(0) - 55;
  if (ch === '<') return 0;
  return -1;
}

/** Computes the 7-3-1 weighted check digit for an MRZ field. */
function mrzCheckDigit(field: string): number {
  let sum = 0;
  for (let i = 0; i < field.length; i++) {
    const v = charValue(field[i]);
    if (v < 0) return -1;
    sum += v * WEIGHTS[i % 3];
  }
  return sum % 10;
}

function checkField(field: string, expected: string): boolean {
  if (!/^\d$/.test(expected)) return false;
  return mrzCheckDigit(field) === Number(expected);
}

/** YYMMDD -> ISO date. `pivot` decides the century for two-digit years. */
function parseMrzDate(yymmdd: string, kind: 'birth' | 'expiry'): string | null {
  if (!/^\d{6}$/.test(yymmdd)) return null;
  const yy = Number(yymmdd.slice(0, 2));
  const mm = Number(yymmdd.slice(2, 4));
  const dd = Number(yymmdd.slice(4, 6));
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;

  const nowYY = new Date().getFullYear() % 100;
  // Birth dates are in the past; expiry dates are near-future.
  const century = kind === 'birth' ? (yy > nowYY ? 1900 : 2000) : (yy < nowYY - 50 ? 2100 : 2000);
  const year = century + yy;

  const d = new Date(Date.UTC(year, mm - 1, dd));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== mm - 1 || d.getUTCDate() !== dd) return null;
  return d.toISOString().slice(0, 10);
}

/** Pads or truncates a field to `length` using the MRZ filler character. */
function mrzPad(value: string, length: number): string {
  return value.slice(0, length).padEnd(length, '<');
}

/**
 * Builds a check-digit-valid TD3 MRZ for sandbox enrolment, with a randomised
 * document number on every call.
 *
 * A fixed specimen MRZ would hash to a single subject and make every sandbox
 * passport enrolment resolve to one shared tourist record, so the document
 * number must differ per traveller even when the demo name does not.
 */
export function buildSandboxMrz(): { line1: string; line2: string } {
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = new Uint8Array(9);
  globalThis.crypto.getRandomValues(bytes);
  const documentNumber = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');

  const nationality = 'UTO';
  const dateOfBirth = '740812';
  const sex = 'F';
  // Five years out, so the specimen never ages into a "passport expired" error.
  const expiryDate = (() => {
    const d = new Date();
    d.setUTCFullYear(d.getUTCFullYear() + 5);
    return `${String(d.getUTCFullYear() % 100).padStart(2, '0')}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  })();
  const personalNumber = mrzPad('', 14);

  const documentCheck = String(mrzCheckDigit(documentNumber));
  const dobCheck = String(mrzCheckDigit(dateOfBirth));
  const expiryCheck = String(mrzCheckDigit(expiryDate));
  const personalCheck = String(mrzCheckDigit(personalNumber));
  const composite = String(mrzCheckDigit(
    documentNumber + documentCheck + dateOfBirth + dobCheck + expiryDate + expiryCheck + personalNumber + personalCheck
  ));

  return {
    line1: mrzPad(`P<${nationality}ERIKSSON<<ANNA<MARIA`, 44),
    line2:
      documentNumber + documentCheck + nationality +
      dateOfBirth + dobCheck + sex + expiryDate + expiryCheck +
      personalNumber + personalCheck + composite,
  };
}

interface MrzResult {
  documentType: string;
  issuingState: string;
  surname: string;
  givenNames: string;
  documentNumber: string;
  nationality: string;
  dateOfBirth: string;
  sex: 'M' | 'F' | 'X';
  expiryDate: string;
  personalNumber: string;
  checks: {
    documentNumber: boolean;
    dateOfBirth: boolean;
    expiryDate: boolean;
    composite: boolean;
  };
}

type MrzParseResult =
  | { valid: true; data: MrzResult }
  | { valid: false; reason: string; checks?: Partial<MrzResult['checks']> };

/** Normalises input: uppercase, strip whitespace, keep only MRZ-legal chars. */
function normaliseMrzLine(line: string): string {
  return line.toUpperCase().replace(/\s+/g, '').replace(/[^A-Z0-9<]/g, '');
}

/**
 * Parses and validates a TD3 MRZ.
 * @param line1 First MRZ line (44 chars) — type, state, name.
 * @param line2 Second MRZ line (44 chars) — number, dates, check digits.
 */
export function parsePassportMrz(line1: string, line2: string): MrzParseResult {
  const l1 = normaliseMrzLine(line1);
  const l2 = normaliseMrzLine(line2);

  if (l1.length !== 44) return { valid: false, reason: `Line 1 must be 44 characters (got ${l1.length}).` };
  if (l2.length !== 44) return { valid: false, reason: `Line 2 must be 44 characters (got ${l2.length}).` };
  if (l1[0] !== 'P') return { valid: false, reason: 'Line 1 must begin with "P" for a passport.' };

  // ---- line 1: P<ISSUER<SURNAME<<GIVEN<NAMES<<<...
  const documentType = l1.slice(0, 2).replace(/</g, '');
  const issuingState = l1.slice(2, 5).replace(/</g, '');
  const nameField = l1.slice(5);
  const [rawSurname = '', rawGiven = ''] = nameField.split('<<');
  const surname = rawSurname.replace(/</g, ' ').trim();
  const givenNames = rawGiven.replace(/</g, ' ').trim();

  if (!surname) return { valid: false, reason: 'Could not read a surname from line 1.' };

  // ---- line 2: fixed-offset fields
  const documentNumber = l2.slice(0, 9);
  const docNumCheck = l2.slice(9, 10);
  const nationality = l2.slice(10, 13).replace(/</g, '');
  const dob = l2.slice(13, 19);
  const dobCheck = l2.slice(19, 20);
  const sexRaw = l2.slice(20, 21);
  const expiry = l2.slice(21, 27);
  const expiryCheck = l2.slice(27, 28);
  const personalNumber = l2.slice(28, 42);
  const personalCheck = l2.slice(42, 43);
  const compositeCheck = l2.slice(43, 44);

  const checks = {
    documentNumber: checkField(documentNumber, docNumCheck),
    dateOfBirth: checkField(dob, dobCheck),
    expiryDate: checkField(expiry, expiryCheck),
    composite: checkField(
      documentNumber + docNumCheck + dob + dobCheck + expiry + expiryCheck + personalNumber + personalCheck,
      compositeCheck
    ),
  };

  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
  if (failed.length > 0) {
    return { valid: false, reason: `MRZ check digit failed for: ${failed.join(', ')}.`, checks };
  }

  const dateOfBirth = parseMrzDate(dob, 'birth');
  const expiryDate = parseMrzDate(expiry, 'expiry');
  if (!dateOfBirth) return { valid: false, reason: 'Date of birth in the MRZ is not a real date.', checks };
  if (!expiryDate) return { valid: false, reason: 'Expiry date in the MRZ is not a real date.', checks };

  if (new Date(expiryDate) < new Date()) {
    return { valid: false, reason: `Passport expired on ${expiryDate}.`, checks };
  }

  const sex = (['M', 'F'].includes(sexRaw) ? sexRaw : 'X') as 'M' | 'F' | 'X';

  return {
    valid: true,
    data: {
      documentType, issuingState, surname, givenNames,
      documentNumber: documentNumber.replace(/</g, ''),
      nationality, dateOfBirth, sex, expiryDate,
      personalNumber: personalNumber.replace(/</g, ''),
      checks,
    },
  };
}
