import assert from 'node:assert/strict';
import test from 'node:test';
import { hashPassword, validatePassword, verifyPassword } from './passwords.js';

test('applies the passphrase length and blocklist policy', () => {
  assert.equal(validatePassword('short'), 'PASSWORD_TOO_SHORT');
  assert.equal(validatePassword('passwordpassword'), 'PASSWORD_COMMON');
  assert.equal(validatePassword('a'.repeat(257)), 'PASSWORD_TOO_LONG');
  assert.equal(validatePassword('correct horse battery staple'), null);
});

test('counts Unicode code points and enforces the encoded byte limit', () => {
  assert.equal(validatePassword('ก'.repeat(15)), null);
  assert.equal(validatePassword('ก'.repeat(257)), 'PASSWORD_TOO_LONG');
});

test('hashes and verifies passwords with Argon2id', async () => {
  const password = 'a unique long passphrase';
  const encodedHash = await hashPassword(password);

  assert.match(encodedHash, /^\$argon2id\$/);
  assert.equal(await verifyPassword(encodedHash, password), true);
  assert.equal(await verifyPassword(encodedHash, 'a different passphrase'), false);
});
