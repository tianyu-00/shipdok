// Which connections may say who the real client is (X-Forwarded-For). Getting this wrong either lets a client forge its
// address (rate limits become useless) or makes every client look like the proxy (one shared limit for everyone).
import { makeApp, closeDb } from './helpers.js';

afterAll(closeDb);
const trusts = async (options, address) => (await makeApp(options)).get('trust proxy fn')(address, 0);
const OLD_ENV = process.env.TRUST_PROXY;
afterEach(() => { if (OLD_ENV === undefined) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = OLD_ENV; });

describe('trust proxy', () => {
  test('by default only this machine is believed', async () => {
    delete process.env.TRUST_PROXY;
    expect(await trusts({}, '127.0.0.1')).toBe(true);
    expect(await trusts({}, '::1')).toBe(true);
    expect(await trusts({}, '172.18.0.5')).toBe(false); // a container, a neighbour, or anyone on the network
    expect(await trusts({}, '192.168.1.20')).toBe(false);
    expect(await trusts({}, '8.8.8.8')).toBe(false);
  });

  test('compose adds private addresses (the dashboard\'s nginx), and still not the internet', async () => {
    const opts = { trustProxy: 'loopback,uniquelocal' };
    expect(await trusts(opts, '127.0.0.1')).toBe(true);
    expect(await trusts(opts, '172.18.0.5')).toBe(true);
    expect(await trusts(opts, '10.0.0.4')).toBe(true);
    expect(await trusts(opts, '8.8.8.8')).toBe(false);
  });

  test('the environment variable is what compose sets', async () => {
    process.env.TRUST_PROXY = 'loopback,uniquelocal';
    expect(await trusts({}, '172.18.0.5')).toBe(true);
  });

  test('an empty variable means the safe default', async () => {
    process.env.TRUST_PROXY = '';
    expect(await trusts({}, '172.18.0.5')).toBe(false);
  });
});
