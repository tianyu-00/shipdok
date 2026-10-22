import { describe, test, expect, beforeEach, vi } from 'vitest'
import { saveDraft, loadDraft, clearDraft } from './create-draft'

beforeEach(() => sessionStorage.clear())
const APP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

describe('the draft of a new app', () => {
  test('keeps the repository and the GitHub app chosen', () => {
    saveDraft({ repo: 'o/r', githubApp: APP }, 1000)
    expect(loadDraft(2000)).toEqual({ repo: 'o/r', githubApp: APP })
  })
  test('"none" and "not chosen yet" are different things and stay different', () => {
    saveDraft({ repo: 'o/r', githubApp: '' }, 1000)
    expect(loadDraft(2000)).toEqual({ repo: 'o/r', githubApp: '' })
    saveDraft({ repo: 'o/r', githubApp: undefined }, 1000)
    expect(loadDraft(2000)).toEqual({ repo: 'o/r', githubApp: undefined })
  })
  test('nothing is kept without a repository, and an earlier draft is dropped', () => {
    saveDraft({ repo: 'o/r', githubApp: '' }, 1000)
    saveDraft({ repo: '', githubApp: '' }, 1000)
    expect(loadDraft(2000)).toBeNull()
  })
  test('is forgotten after an hour (and not before)', () => {
    saveDraft({ repo: 'o/r', githubApp: '' }, 1000)
    expect(loadDraft(1000 + 60 * 60 * 1000)).not.toBeNull()
    expect(loadDraft(1000 + 60 * 60 * 1000 + 1)).toBeNull()
  })
  test('a clock that went backwards does not keep it forever', () => {
    saveDraft({ repo: 'o/r', githubApp: '' }, 5000)
    expect(loadDraft(1000)).toBeNull()
  })
  test('clearing removes it', () => {
    saveDraft({ repo: 'o/r', githubApp: '' })
    clearDraft()
    expect(loadDraft()).toBeNull()
  })
  test.each(['{', 'null', '"x"', '{"repo":5,"at":1}', '{"repo":"o/r","at":"x"}', `{"repo":"o/r","githubApp":5,"at":${Date.now()}}`, `{"repo":"${'x'.repeat(201)}","githubApp":null,"at":${Date.now()}}`])('stored junk %s is ignored', (junk) => {
    sessionStorage.setItem('shipdok.create-app', junk)
    expect(loadDraft()).toBeNull()
  })
  test('a browser that blocks storage does not break anything', () => {
    const boom = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    expect(() => saveDraft({ repo: 'o/r', githubApp: '' })).not.toThrow()
    boom.mockRestore()
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    expect(loadDraft()).toBeNull()
    get.mockRestore()
    const rm = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('blocked') })
    expect(() => clearDraft()).not.toThrow()
    rm.mockRestore()
  })
})
