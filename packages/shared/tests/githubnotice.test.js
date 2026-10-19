import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { oldGithubEnvNotice } from '../src/index.js';

describe('oldGithubEnvNotice', () => {
  test('nothing set: nothing to say', () => {
    assert.equal(oldGithubEnvNotice({}), null);
    assert.equal(oldGithubEnvNotice({ GITHUB_APP_ID: '', GITHUB_WEBHOOK_SECRET: '   ' }), null);
  });

  test('names the old settings that are set, singular and plural, and points at the dashboard', () => {
    const one = oldGithubEnvNotice({ GITHUB_WEBHOOK_SECRET: 'x'.repeat(20) });
    assert.match(one, /^GITHUB_WEBHOOK_SECRET is set but no longer read/);
    assert.match(one, /GitHub page of the dashboard/);
    const many = oldGithubEnvNotice({ GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY_FILE: '/k.pem', GITHUB_WEBHOOK_SECRET: 'x'.repeat(20) });
    assert.match(many, /GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY_FILE, GITHUB_WEBHOOK_SECRET are set but/);
  });

  test('never prints a value', () => {
    const notice = oldGithubEnvNotice({ GITHUB_APP_ID: '12345678', GITHUB_APP_PRIVATE_KEY: 'PRIVATE-KEY-TEXT', GITHUB_WEBHOOK_SECRET: 'super-secret-value-123' });
    for (const v of ['12345678', 'PRIVATE-KEY-TEXT', 'super-secret-value-123']) assert.ok(!notice.includes(v));
  });

  test('other settings are not mentioned', () => {
    assert.equal(oldGithubEnvNotice({ WEB_ORIGIN: 'http://x', SESSION_SECRET: 's'.repeat(40) }), null);
  });
});
