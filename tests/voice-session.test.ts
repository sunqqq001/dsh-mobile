import { describe, expect, it } from 'vitest'
import { phaseIsDictating } from '../src/voice-session.js'

describe('screen wake phases', () => {
  it('holds the screen while audio is being captured or turned into text', () => {
    for (const phase of ['requesting', 'recording', 'transcribing']) {
      expect(phaseIsDictating(phase), phase).toBe(true)
    }
  })

  it('releases the screen for every phase where nothing is being captured', () => {
    for (const phase of [
      'idle', 'standby', 'ready', 'feedback',
      'downloading', 'cancelled', 'cancelling', 'failed',
    ]) {
      expect(phaseIsDictating(phase), phase).toBe(false)
    }
  })

  it('treats a missing or unknown phase as releasing the screen', () => {
    for (const phase of [null, undefined, '', 'something-new']) {
      expect(phaseIsDictating(phase), String(phase)).toBe(false)
    }
  })

  it('is not confused by a phase that merely contains a held one', () => {
    expect(phaseIsDictating('transcribing-failed')).toBe(false)
    expect(phaseIsDictating('not-recording')).toBe(false)
  })
})
