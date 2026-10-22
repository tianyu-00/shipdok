import { describe, test, expect } from 'vitest'
import { METHOD_CARDS, DEFAULT_METHOD, cardFor, methodChanges } from './build-methods'

describe('the cards', () => {
  test('Dockerfile, Railpack and Static site are the cards, and all can be chosen (Nixpacks was dropped: it is in maintenance mode)', () => {
    expect(METHOD_CARDS.map((c) => [c.id, c.available])).toEqual([['dockerfile', true], ['railpack', true], ['static', true]])
  })
  test('Railpack is the default, and it can be chosen (a default that cannot be chosen would trap the form)', () => {
    expect(DEFAULT_METHOD).toBe('railpack')
    expect(cardFor(DEFAULT_METHOD).available).toBe(true)
  })
  test('every card says what it is', () => {
    for (const c of METHOD_CARDS) expect(c.text.length).toBeGreaterThan(20)
  })
  test('looking one up', () => {
    expect(cardFor('railpack').title).toBe('Railpack')
    expect(cardFor('nope')).toBeNull()
  })
})

describe('choosing a method changes the starting values', () => {
  const form = (over = {}) => ({ build_method: 'railpack', container_port: '3000', memory_mb: '512', install_command: '', build_command: '', output_dir: '', ...over })

  test('Static site fills in its port, a small memory limit, the npm commands and the dist folder', () => {
    expect(methodChanges(form(), 'static')).toEqual({ build_method: 'static', container_port: '8080', memory_mb: '128', install_command: 'npm ci', build_command: 'npm run build', output_dir: 'dist' })
  })
  test('only what is still at its starting value is replaced', () => {
    expect(methodChanges(form({ container_port: '5000', memory_mb: '256' }), 'static')).toMatchObject({ build_method: 'static' })
    const p = methodChanges(form({ container_port: '5000', memory_mb: '256' }), 'static')
    expect('container_port' in p || 'memory_mb' in p).toBe(false)
  })
  test('commands the person already typed are not replaced (even one of the two), nor a folder', () => {
    for (const over of [{ install_command: 'yarn' }, { build_command: 'make' }]) {
      const p = methodChanges(form(over), 'static')
      expect('install_command' in p || 'build_command' in p).toBe(false)
    }
    expect('output_dir' in methodChanges(form({ output_dir: 'public' }), 'static')).toBe(false)
  })
  test('choosing Static site again changes nothing more', () => {
    expect(methodChanges(form({ build_method: 'static', container_port: '9000' }), 'static')).toEqual({ build_method: 'static' })
  })
  test('leaving Static site puts back only what it filled in', () => {
    const filled = form({ build_method: 'static', container_port: '8080', memory_mb: '128', install_command: 'npm ci', build_command: 'npm run build', output_dir: 'dist' })
    expect(methodChanges(filled, 'railpack')).toEqual({ build_method: 'railpack', container_port: '3000', memory_mb: '512', install_command: '', build_command: '', output_dir: '' })
    const edited = form({ build_method: 'static', container_port: '9000', memory_mb: '256', install_command: 'pnpm i', build_command: 'npm run build', output_dir: 'public' })
    expect(methodChanges(edited, 'dockerfile')).toEqual({ build_method: 'dockerfile' })
  })
  test('moving between the other two methods changes nothing', () => {
    expect(methodChanges(form(), 'dockerfile')).toEqual({ build_method: 'dockerfile' })
  })
})
