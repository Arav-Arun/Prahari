#!/usr/bin/env node
/**
 * Prints SQL that adds a staff account to the Supabase users table, with a
 * generated password shown once.
 *
 *   pnpm staff:create officer@example.gov.in "Officer Name" authority
 */
import { pbkdf2Sync, randomBytes, randomUUID } from 'node:crypto';

const [email, name, role = 'authority'] = process.argv.slice(2);
if (!email || !name || !['authority', 'responder', 'admin'].includes(role)) {
  console.error('Usage: pnpm staff:create <email> "<name>" [authority|responder|admin]');
  process.exit(1);
}

// Must match apps/web/lib/auth/crypto.ts.
const password = randomBytes(12).toString('base64url');
const salt = randomBytes(16).toString('hex');
const hash = pbkdf2Sync(password, salt, 100_000, 64, 'sha512').toString('hex');
const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
const userId = `USER-${randomUUID().slice(0, 8).toUpperCase()}`;

console.log('\nRun this in the Supabase SQL editor:\n');
console.log(`insert into users ("userId", email, "passwordHash", salt, name, role)
values (${[userId, email.trim().toLowerCase(), hash, salt, name, role].map(quote).join(', ')});\n`);
console.log(`Password (shown once): ${password}\n`);
