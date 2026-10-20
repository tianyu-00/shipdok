// The interactive API reference at /api/docs: for the signed-in administrator only, nothing loaded from the internet, and it can be
// switched off with API_DOCS=false.
import request from 'supertest';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeApp, resetDb, closeDb, PASSWORD } from './helpers.js';

afterAll(closeDb);
beforeEach(resetDb);

const signedIn = async (options = {}) => {
  const agent = request.agent(await makeApp(options));
  await agent.post('/api/auth/setup').send({ username: 'admin', password: PASSWORD });
  return agent;
};
const PATHS = ['/api/docs', '/api/docs/openapi.json', '/api/docs/scalar.js'];

describe('who can open it', () => {
  test('nobody who is not signed in: every part answers 401', async () => {
    const app = await makeApp();
    for (const p of PATHS) expect([p, (await request(app).get(p)).status]).toEqual([p, 401]);
  });

  test('a browser that is not signed in is sent to the dashboard\'s login, which brings it back; the other parts stay a plain 401', async () => {
    const app = await makeApp();
    const res = await request(app).get('/api/docs').set('Accept', 'text/html,application/xhtml+xml,*/*;q=0.8');
    expect([res.status, res.headers.location]).toEqual([302, '/api-docs']);
    for (const p of ['/api/docs/openapi.json', '/api/docs/scalar.js']) {
      expect([p, (await request(app).get(p).set('Accept', 'text/html')).status]).toEqual([p, 401]);
    }
    expect((await request(app).get('/api/docs').set('Accept', 'application/json')).status).toBe(401); // a program still gets the error
  });

  test('a visitor from outside the local network gets a plain 404 even with a session cookie', async () => {
    const agent = await signedIn();
    // A trusted proxy (here: this machine) reporting a public client address.
    for (const p of PATHS) expect([p, (await agent.get(p).set('X-Forwarded-For', '203.0.113.5')).status]).toEqual([p, 404]);
  });

  test('API_DOCS=false removes it: 404 for the signed-in administrator too', async () => {
    const agent = await signedIn({ apiDocs: false });
    for (const p of PATHS) expect([p, (await agent.get(p)).status]).toEqual([p, 404]);
  });
});

describe('what the administrator gets', () => {
  test('the page: loads Scalar and the document from this server only, and allows exactly its own inline script', async () => {
    const agent = await signedIn();
    const res = await agent.get('/api/docs');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('/api/docs/scalar.js');
    expect(res.text).toContain('/api/docs/openapi.json');
    expect(res.text).not.toMatch(/https?:\/\/(?!www\.w3\.org)/); // nothing from the internet
    const csp = res.headers['content-security-policy'];
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(res.text).toContain(`nonce="${nonce}"`);
    expect(csp).toMatch(/connect-src 'self'/);
    expect(csp).not.toMatch(/unsafe-eval|https?:/);
    expect((await agent.get('/api/docs')).headers['content-security-policy']).not.toBe(csp); // a new nonce every time
  });

  test('the document is the generated one', async () => {
    const agent = await signedIn();
    const res = await agent.get('/api/docs/openapi.json');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toEqual(JSON.parse(await readFile(new URL('../openapi/openapi.json', import.meta.url), 'utf8')));
  });

  test('Scalar itself is served from here (no internet needed)', async () => {
    const agent = await signedIn();
    const res = await agent.get('/api/docs/scalar.js').buffer(true).parse((r, cb) => { let n = 0; r.on('data', (c) => { n += c.length; }); r.on('end', () => cb(null, n)); });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/javascript/);
    expect(res.body).toBeGreaterThan(100_000);
  });
});

describe('the Docker image carries Scalar as one file', () => {
  test('SCALAR_BUNDLE names the file that is served (the image has no copy of the package)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scalar-'));
    const file = join(dir, 'scalar.js');
    await writeFile(file, 'window.fromTheImage = true;');
    process.env.SCALAR_BUNDLE = file;
    try {
      const res = await (await signedIn()).get('/api/docs/scalar.js');
      expect(res.status).toBe(200);
      expect(res.text).toBe('window.fromTheImage = true;');
    } finally {
      delete process.env.SCALAR_BUNDLE;
    }
  });
});
