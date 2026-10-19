import { describe, test, expect, vi, afterEach } from 'vitest'
import { postManifest, connectProblem, manualProblem, errorMessage, installUrl } from './githubconnect'

afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = '' })

describe('postManifest', () => {
  test('posts the app definition to GitHub in a form, as the one field GitHub expects', () => {
    const submit = vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(function submitted() {
      const form = this
      expect(form.method).toBe('post')
      expect(form.action).toBe('https://github.com/settings/apps/new?state=abc')
      expect([...form.elements].map((e) => e.name)).toEqual(['manifest'])
      expect(JSON.parse(form.elements.manifest.value)).toEqual({ name: 'Shipdok-ab12', public: false })
    })
    postManifest({ postUrl: 'https://github.com/settings/apps/new?state=abc', manifest: { name: 'Shipdok-ab12', public: false } })
    expect(submit).toHaveBeenCalledTimes(1)
  })

  test('removes the form afterwards, and never sends the definition anywhere but GitHub', () => {
    vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => {})
    postManifest({ postUrl: 'https://github.com/organizations/my-org/settings/apps/new?state=x', manifest: {} })
    expect(document.querySelector('form')).toBeNull()
    expect(() => postManifest({ postUrl: 'https://evil.example.com/steal', manifest: {} })).toThrow(/GitHub/)
    expect(() => postManifest({ postUrl: 'http://github.com/settings/apps/new', manifest: {} })).toThrow(/GitHub/)
    expect(() => postManifest({ postUrl: 'https://github.com.evil.example/settings/apps/new', manifest: {} })).toThrow(/GitHub/)
  })
})

describe('connectProblem', () => {
  test('personal account with no name is fine', () => expect(connectProblem({ kind: 'personal', org: '', name: '' })).toBeNull())
  test('an organisation needs a valid login', () => {
    expect(connectProblem({ kind: 'org', org: '', name: '' })).toMatch(/organisation/i)
    expect(connectProblem({ kind: 'org', org: 'a/b', name: '' })).toMatch(/organisation/i)
    expect(connectProblem({ kind: 'org', org: 'my-org', name: '' })).toBeNull()
  })
  test('a name has to be a usable GitHub app name', () => {
    expect(connectProblem({ kind: 'personal', org: '', name: 'My Shipdok' })).toBeNull()
    expect(connectProblem({ kind: 'personal', org: '', name: 'x'.repeat(35) })).toMatch(/name/i)
    expect(connectProblem({ kind: 'personal', org: '', name: '<b>' })).toMatch(/name/i)
  })
})

describe('manualProblem', () => {
  const ok = { appId: '123456', privateKey: '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----', webhookSecret: 'a-webhook-secret-0123', password: 'pw' }
  test('a complete form is fine', () => expect(manualProblem(ok)).toBeNull())
  test.each([
    [{ appId: '' }, /app id/i], [{ appId: 'abc' }, /number/i], [{ appId: '12 34' }, /number/i],
    [{ privateKey: '' }, /private key/i], [{ privateKey: 'not a key' }, /private key/i],
    [{ webhookSecret: '' }, /webhook secret/i], [{ webhookSecret: 'short' }, /at least 16/i],
    [{ password: '' }, /password/i],
  ])('%j is refused', (over, why) => expect(manualProblem({ ...ok, ...over })).toMatch(why))
})

describe('errorMessage', () => {
  test.each(['login', 'state', 'exchange_failed', 'github_unreachable', 'already_connected'])('%s has a plain explanation', (code) => {
    expect(errorMessage(code)).toEqual(expect.any(String))
    expect(errorMessage(code).length).toBeGreaterThan(20)
  })
  test('an unknown code still says something, and shows no code', () => {
    expect(errorMessage('whatever')).toMatch(/did not finish/i)
    expect(errorMessage('whatever')).not.toMatch(/whatever/)
  })
})

describe('installUrl', () => {
  test('is the page where the app is installed on repositories', () => {
    expect(installUrl('shipdok-ab12')).toBe('https://github.com/apps/shipdok-ab12/installations/new')
  })
  test('is null without a usable slug', () => {
    expect(installUrl(null)).toBeNull()
    expect(installUrl('a/b')).toBeNull()
    expect(installUrl('x y')).toBeNull()
  })
})
