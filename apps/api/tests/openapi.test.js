// The API documentation (openapi/): it must describe exactly the routes the API has, be up to date, be a valid OpenAPI document, and
// tell the truth about which calls need a sign-in. API documentation does not replace the behaviour tests in the other files.
import request from 'supertest';
import { readFile } from 'node:fs/promises';
import SwaggerParser from '@apidevtools/swagger-parser';
import { jest } from '@jest/globals';
import { makeApp, resetDb, closeDb } from './helpers.js';
import { realRoutes, render, OUTPUT } from '../openapi/generate.js';
import { buildSpec, compare, operations } from '../openapi/build.js';

afterAll(closeDb);

describe('coverage: the documentation and the routes agree', () => {
  const routes = realRoutes();

  test('the route list is the real one (a guard against the walker silently finding nothing)', () => {
    expect(routes.length).toBeGreaterThan(50);
    expect(routes).toContainEqual({ method: 'POST', path: '/api/auth/login' });
    expect(routes).toContainEqual({ method: 'DELETE', path: '/api/apps/{id}/env/{key}' });
  });

  test('every route has a description (add it in openapi/operations/ when you add a route)', () => {
    expect(compare(routes).undocumented).toEqual([]);
  });

  test('every description belongs to a route that exists (no stale ones after a rename or removal)', () => {
    expect(compare(routes).stale).toEqual([]);
  });

  test('openapi/openapi.json is up to date (run: npm run openapi -w apps/api)', async () => {
    expect(await readFile(OUTPUT, 'utf8')).toBe(render());
  });
});

describe('the document', () => {
  const spec = buildSpec();

  test('is a valid OpenAPI 3 document', async () => {
    await expect(SwaggerParser.validate(structuredClone(spec))).resolves.toBeDefined();
    expect(spec.openapi).toMatch(/^3\.0/);
  });

  test('every operation says what it does, how it answers, and every tag is declared', () => {
    const tags = new Set(spec.tags.map((t) => t.name));
    for (const [key, o] of Object.entries(operations)) {
      expect([key, o.summary?.length > 5]).toEqual([key, true]);
      expect([key, o.description?.length > 30]).toEqual([key, true]);
      expect([key, Object.keys(o.responses).some((s) => /^[23]/.test(s))]).toEqual([key, true]);
      expect(o.tags.every((t) => tags.has(t))).toBe(true);
    }
  });

  test('a call that needs a sign-in documents the 401, and every error answer is the shared shape', () => {
    for (const [key, o] of Object.entries(operations)) {
      if (o.security.length) expect([key, '401' in o.responses]).toEqual([key, true]);
      for (const [status, r] of Object.entries(o.responses)) {
        // The readiness check answers its own small shape, not the error shape.
        if (/^[45]/.test(status) && r.content && key !== 'GET /health/ready') expect([key, r.content['application/json'].schema.$ref]).toEqual([key, '#/components/schemas/Error']);
      }
    }
  });

  test('request bodies of the app calls come from the validators the API really uses', () => {
    const create = spec.components.schemas.AppCreate;
    expect(create.properties.container_port).toMatchObject({ minimum: 1, maximum: 65535 });
    expect(create.additionalProperties).toBe(false);
    expect(create.required).toEqual(expect.arrayContaining(['name', 'repo', 'container_port']));
  });
});

describe('the sign-in requirements are the real ones', () => {
  const ZERO = '00000000-0000-0000-0000-000000000000';
  const urlOf = (path) => path.replace('{id}', ZERO).replace('{key}', 'SOME_KEY');
  let app;
  beforeEach(async () => {
    await resetDb();
    app = await makeApp({ queue: { add: jest.fn(async () => ({ id: '1' })), remove: jest.fn(async () => {}) } });
  });

  test('without a session every call documented as needing one answers 401, and the others do not', async () => {
    const wrong = [];
    for (const [key, o] of Object.entries(operations)) {
      const [method, path] = key.split(' ');
      const res = await request(app)[method.toLowerCase()](urlOf(path)).send({});
      const needsSession = o.security.length > 0;
      const gave401 = res.status === 401;
      // The webhook is open to everyone and answers 401 for a missing signature; it is the only open call that may.
      if (needsSession !== gave401 && !(key === 'POST /api/webhooks/github' && gave401)) wrong.push(`${key}: documented ${needsSession ? 'session' : 'open'}, answered ${res.status}`);
    }
    expect(wrong).toEqual([]);
  });
});
