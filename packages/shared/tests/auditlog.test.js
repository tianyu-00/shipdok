import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { change, fact, changesOf, recordAudit, AUDIT_CATEGORIES, AUDIT_SOURCES, KEEP_DAYS_CHOICES } from '../src/index.js';

describe('the entries of the activity log', () => {
  test('a change and a fact are text; nothing is "null" or "undefined"', () => {
    assert.deepEqual(change('Mode', null, undefined), { label: 'Mode', from: '', to: '' });
    assert.deepEqual(change('Port', 8080, 9090), { label: 'Port', from: '8080', to: '9090' });
    assert.deepEqual(fact('App', 'Blog'), { label: 'App', value: 'Blog' });
  });
  test('a text is cut at 300 characters', () => {
    assert.equal(fact('x', 'y'.repeat(500)).value.length, 300);
  });
  test('changesOf lists only what differs: null and empty are the same, 1 and 1.00 are the same, true and "true" are the same', () => {
    const labels = { a: 'A', b: 'B', c: 'C', d: 'D', e: 'E' };
    const out = changesOf({ a: null, b: '1.00', c: true, d: 'x', e: 3 }, { a: '', b: 1, c: 'true', d: 'y', e: 4 }, labels);
    assert.deepEqual(out, [{ label: 'D', from: 'x', to: 'y' }, { label: 'E', from: '3', to: '4' }]);
  });
  test('changesOf looks only at the keys of the new values, and a label falls back to the key', () => {
    assert.deepEqual(changesOf({ a: 1, z: 1 }, { a: 2 }, {}), [{ label: 'a', from: '1', to: '2' }]);
  });
  test('the categories, the sources and the kept times', () => {
    assert.deepEqual(AUDIT_CATEGORIES, ['security', 'github', 'backups', 'apps', 'deployments', 'variables', 'storage']);
    assert.deepEqual(AUDIT_SOURCES, ['user', 'webhook', 'schedule', 'system']);
    assert.deepEqual(KEEP_DAYS_CHOICES, [7, 30, 90, 365]);
  });
  test('an unknown category or source is refused before anything is written', async () => {
    const client = { query: async () => { throw new Error('must not be called'); } };
    await assert.rejects(recordAudit(client, { category: 'nope', action: 'x', summary: 'x', actor: 'a', address: 'b' }), /category/);
    await assert.rejects(recordAudit(client, { category: 'apps', source: 'nope', action: 'x', summary: 'x', actor: 'a', address: 'b' }), /source/);
  });
  test('the entry is written with its details as JSON, at most 20, and then the old rows are trimmed', async () => {
    const calls = [];
    const client = { query: async (sql, params) => { calls.push({ sql, params }); return { rowCount: 0 }; } };
    await recordAudit(client, { category: 'apps', action: 'x', summary: 'S', actor: 'a', address: 'b', details: Array.from({ length: 30 }, (_, i) => fact(`F${i}`, 'v')) });
    assert.match(calls[0].sql, /^INSERT INTO audit_log/);
    assert.equal(JSON.parse(calls[0].params[3]).length, 20);
    assert.deepEqual(calls[0].params.slice(4), ['a', 'b', 'user', null, null]);
    assert.match(calls[1].sql, /DELETE FROM login_attempts/);
    assert.match(calls[2].sql, /DELETE FROM audit_log/);
  });
  test('an entry with no details stores null', async () => {
    const calls = [];
    await recordAudit({ query: async (sql, params) => { calls.push(params); return { rowCount: 0 }; } }, { category: 'apps', action: 'x', summary: 'S', actor: 'a', address: 'b' });
    assert.equal(calls[0][3], null);
  });
});
