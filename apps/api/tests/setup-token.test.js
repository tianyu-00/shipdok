// Separate file because SETUP_TOKEN is read from the environment when the app loads.
import request from 'supertest';
import { makeApp, resetDb, closeDb, PASSWORD } from './helpers.js';

const TOKEN = 'a-test-setup-token-123';
let app;

beforeAll(async () => {
  process.env.SETUP_TOKEN = TOKEN; // before the first dynamic import of the app
});
beforeEach(async () => {
  await resetDb();
  app = await makeApp();
});
afterAll(closeDb);

const body = (extra = {}) => ({ username: 'admin', password: PASSWORD, ...extra });

test('setup without the token is refused', async () => {
  const res = await request(app).post('/api/auth/setup').send(body());
  expect(res.status).toBe(403);
});

test('setup with a wrong token is refused', async () => {
  const res = await request(app).post('/api/auth/setup').send(body({ setupToken: 'nope' }));
  expect(res.status).toBe(403);
});

test('setup with the right token succeeds', async () => {
  const res = await request(app).post('/api/auth/setup').send(body({ setupToken: TOKEN }));
  expect(res.status).toBe(201);
});
