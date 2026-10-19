import { describe, test, expect } from 'vitest'
import { deleteBlockedReason, deleteRemovesImage, prunableVersions, versionsById } from './versions'
import { makeImages, makeVersion } from '@/test/fixtures'

const live = makeVersion({ deploymentId: 'live', image: 'img:live', state: 'live' })
const prev = makeVersion({ deploymentId: 'prev', image: 'img:prev', state: 'previous', canRollBackTo: true })
const old = makeVersion({ deploymentId: 'old', image: 'img:old', state: 'prunable', canRollBackTo: true })
const gone = makeVersion({ deploymentId: 'gone', image: 'img:gone', state: 'removed' })
const images = makeImages([live, prev, old, gone])

describe('deleteBlockedReason', () => {
  test('the running version cannot be deleted', () => expect(deleteBlockedReason({ id: 'live' }, images)).toMatch(/running version/))
  test('a kept previous version cannot be deleted', () => expect(deleteBlockedReason({ id: 'prev' }, images)).toMatch(/rolled back/))
  test('an old or removed version can', () => {
    expect(deleteBlockedReason({ id: 'old' }, images)).toBeNull()
    expect(deleteBlockedReason({ id: 'gone' }, images)).toBeNull()
  })
  test('a newest record whose image is gone can (the API only protects an image that exists)', () => {
    const odd = makeImages([makeVersion({ deploymentId: 'x', image: 'i:x', state: 'removed' }), prev])
    expect(deleteBlockedReason({ id: 'x' }, odd)).toBeNull()
  })
  test('a failed deployment (no image) can', () => expect(deleteBlockedReason({ id: 'failed' }, images)).toBeNull())
  test('a previous version whose image another record also holds can', () => {
    const shared = makeImages([live, prev, makeVersion({ deploymentId: 'twin', image: 'img:prev', state: 'previous', canRollBackTo: true })])
    expect(deleteBlockedReason({ id: 'twin' }, shared)).toBeNull()
  })
  test('nothing is blocked before the images are known', () => expect(deleteBlockedReason({ id: 'live' }, undefined)).toBeNull())
})

describe('deleteRemovesImage', () => {
  test('true when nothing else uses the image', () => expect(deleteRemovesImage({ id: 'old' }, images)).toBe(true))
  test('false when another record shares it, when it is already gone, or when there is none', () => {
    const shared = makeImages([live, makeVersion({ deploymentId: 'a', image: 'img:x', state: 'prunable' }), makeVersion({ deploymentId: 'b', image: 'img:x', state: 'prunable' })])
    expect(deleteRemovesImage({ id: 'a' }, shared)).toBe(false)
    expect(deleteRemovesImage({ id: 'gone' }, images)).toBe(false)
    expect(deleteRemovesImage({ id: 'failed' }, images)).toBe(false)
  })
})

describe('prunableVersions', () => {
  test('lists only old images, each image once', () => {
    const dup = makeVersion({ deploymentId: 'old2', image: 'img:old', state: 'prunable' })
    expect(prunableVersions(makeImages([live, prev, old, dup, gone])).map((v) => v.deploymentId)).toEqual(['old'])
  })
  test('empty when nothing is loaded', () => expect(prunableVersions(undefined)).toEqual([]))
})

test('versionsById', () => expect(versionsById(images).get('prev').state).toBe('previous'))
