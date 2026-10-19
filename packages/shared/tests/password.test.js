import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { passwordProblem, PASSWORD_MIN, PASSWORD_MAX } from '../src/index.js';

describe('passwordProblem', () => {
  test('accepts a long, password', () => {
    assert.equal(passwordProblem('correct-horse-battery-staple'), null);
    assert.equal(passwordProblem('a-long-test-password'), null);
  });

  test('limits are 12 and 256', () => {
    assert.equal(PASSWORD_MIN, 12);
    assert.equal(PASSWORD_MAX, 256);
    assert.match(passwordProblem('x7!kQ2#mZ9a'), /at least 12/);
    assert.equal(passwordProblem('x7!kQ2#mZ9ab'), null);
    const varied = (n) => Array.from({ length: n }, (_, i) => String.fromCharCode(33 + ((i * 37) % 94))).join('');
    assert.equal(passwordProblem(varied(256)), null);
    assert.match(passwordProblem(varied(257)), /at most 256/);
  });

  test('refuses non-strings', () => {
    assert.match(passwordProblem(undefined), /password/i);
    assert.match(passwordProblem(123456789012), /password/i);
  });

  test('refuses a password made of one repeated character or short pattern', () => {
    assert.match(passwordProblem('aaaaaaaaaaaaaaaa'), /repeat/i);
    assert.match(passwordProblem('abababababababab'), /repeat/i);
    assert.match(passwordProblem('x7Kx7Kx7Kx7Kx7K'), /repeat/i);
  });

  test('refuses a plain run of characters', () => {
    for (const p of ['123456789012', '210987654321', 'abcdefghijklmn']) {
      assert.match(passwordProblem(p), /sequence/i, p);
    }
    assert.match(passwordProblem('123456789012'), /sequence/i);
  });

  test('refuses a password that contains the username', () => {
    assert.match(passwordProblem('my-admin-secret-phrase', { username: 'admin' }), /username/i);
    assert.match(passwordProblem('MY-ADMIN-secret-phrase', { username: 'Admin' }), /username/i);
    assert.equal(passwordProblem('my-boat-secret-phrase', { username: 'admin' }), null);
  });

  test('a username shorter than 3 characters is not matched inside the password', () => {
    assert.equal(passwordProblem('my-boat-secret-phrase', { username: 'a' }), null);
  });
});
