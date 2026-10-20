import { describe, test, expect } from 'vitest'
import { appLabel, startingApp, githubAppBody } from './github-apps'

describe('appLabel', () => {
  test('the name and the account that owns it, so apps with alike names can be told apart', () => {
    expect(appLabel({ name: 'Shipdok-ab12', ownerLogin: 'tianyu-00' })).toBe('Shipdok-ab12 (tianyu-00)')
  })
  test('without an owner just the name; without a name the slug; without either the number', () => {
    expect(appLabel({ name: 'Shipdok-ab12' })).toBe('Shipdok-ab12')
    expect(appLabel({ name: null, slug: 'shipdok-ab12', ownerLogin: 'me' })).toBe('shipdok-ab12 (me)')
    expect(appLabel({ name: null, slug: null, appId: '77' })).toBe('App 77')
  })
})

describe('startingApp', () => {
  test('the only app is the starting choice', () => {
    expect(startingApp([{ id: 'a' }])).toBe('a')
  })
  test('with none or several, nothing is chosen for you', () => {
    expect(startingApp([])).toBeUndefined()
    expect(startingApp([{ id: 'a' }, { id: 'b' }])).toBeUndefined()
  })
})

describe('githubAppBody', () => {
  test('no app is connected: nothing is sent', () => {
    expect(githubAppBody([], undefined)).toEqual({})
    expect(githubAppBody([], 'a')).toEqual({})
  })
  test('an app is sent by id; none (empty) or not chosen is sent as null', () => {
    const apps = [{ id: 'a' }, { id: 'b' }]
    expect(githubAppBody(apps, 'b')).toEqual({ github_app_id: 'b' })
    expect(githubAppBody(apps, '')).toEqual({ github_app_id: null })
    expect(githubAppBody(apps, undefined)).toEqual({ github_app_id: null })
  })
})
