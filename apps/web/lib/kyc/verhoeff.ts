/**
 * Verhoeff checksum — the algorithm UIDAI uses for the 12th digit of every
 * Aadhaar number. This is the real algorithm, not a simulation: it genuinely
 * rejects mistyped or invented Aadhaar numbers.
 *
 * Reference: Verhoeff, J. (1969), "Error Detecting Decimal Codes".
 */

// Multiplication table over the dihedral group D5.
const D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];

// Permutation table.
const P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

// Inverse table over D5, used to derive a check digit rather than verify one.
const INV = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9];

/** True when the digit string carries a valid Verhoeff check digit. */
function verhoeffValidate(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let c = 0;
  const reversed = digits.split('').reverse();
  for (let i = 0; i < reversed.length; i++) {
    c = D[c][P[i % 8][Number(reversed[i])]];
  }
  return c === 0;
}

/**
 * The digit that makes `digits` Verhoeff-valid when appended. Same tables as
 * verhoeffValidate, with the permutation index shifted by one because the
 * check digit will occupy position 0 of the reversed string.
 */
function verhoeffCheckDigit(digits: string): number {
  if (!/^\d+$/.test(digits)) return -1;
  let c = 0;
  const reversed = digits.split('').reverse();
  for (let i = 0; i < reversed.length; i++) {
    c = D[c][P[(i + 1) % 8][Number(reversed[i])]];
  }
  return INV[c];
}

/**
 * A fresh, checksum-valid Aadhaar number for sandbox enrolment.
 *
 * Every call returns a different number, and that is the point: identity
 * issuance deduplicates on a salted hash of the document number, so a shared
 * demo number makes every sandbox enrolment resolve to one tourist record and
 * overwrite the previous holder's name, DID and recovery code.
 */
export function generateSandboxAadhaar(): string {
  const bytes = new Uint8Array(11);
  globalThis.crypto.getRandomValues(bytes);
  // UIDAI never issues numbers beginning with 0 or 1.
  let body = String(2 + (bytes[0] % 8));
  for (let i = 1; i < 11; i++) body += String(bytes[i] % 10);
  return body + String(verhoeffCheckDigit(body));
}

type AadhaarValidation =
  | { valid: true; masked: string }
  | { valid: false; reason: string };

/**
 * Validates a 12-digit Aadhaar number: format, leading digit, and checksum.
 * UIDAI never issues numbers beginning with 0 or 1.
 */
export function validateAadhaar(raw: string): AadhaarValidation {
  const digits = raw.replace(/[\s-]/g, '');

  if (!/^\d+$/.test(digits)) return { valid: false, reason: 'Aadhaar number must contain digits only.' };
  if (digits.length !== 12) return { valid: false, reason: 'Aadhaar number must be exactly 12 digits.' };
  if (digits[0] === '0' || digits[0] === '1') {
    return { valid: false, reason: 'Aadhaar numbers never begin with 0 or 1.' };
  }
  if (!verhoeffValidate(digits)) {
    return { valid: false, reason: 'Checksum failed — this is not a valid Aadhaar number.' };
  }

  return { valid: true, masked: `XXXX-XXXX-${digits.slice(8)}` };
}
