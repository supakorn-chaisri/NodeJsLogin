import assert from 'node:assert/strict';
import test from 'node:test';
import { constantTimeEqual, normalizeEmail, sha256 } from './crypto.js';

test('normalizes email without changing its local-part boundaries', () => {
  assert.equal(normalizeEmail('  User+tag@EXAMPLE.COM  '), 'user+tag@example.com');
});

test('hashes tokens deterministically and compares them without accepting different lengths', () => {
  assert.equal(sha256('token').length, 64);
  assert.equal(sha256('token'), sha256('token'));
  assert.equal(constantTimeEqual('same-token', 'same-token'), true);
  assert.equal(constantTimeEqual('token', 'token-longer'), false);
});
