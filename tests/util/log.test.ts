import { afterEach, describe, expect, it, vi } from 'vitest'
import { styleText, stripVTControlCharacters } from 'node:util'
import { createLogger, errorMessage } from '../../src/util/log.ts'
import { cfg } from '../helpers.ts'

function writeSpy() {
  return vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
}

describe('createLogger', () => {
  afterEach(() => vi.restoreAllMocks())

  it('debug is silent when verbose is off', () => {
    const spy = writeSpy()
    const log = createLogger(cfg({ verbose: false }))
    log.debug('x')
    expect(spy).not.toHaveBeenCalled()
  })

  it('debug writes to stderr when verbose is on', () => {
    const spy = writeSpy()
    const log = createLogger(cfg({ verbose: true }))
    log.debug('hello', 42)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(stripVTControlCharacters(spy.mock.calls[0]![0] as string)).toContain(
      '[debug] hello 42',
    )
  })

  it('warn and error always write regardless of verbose', () => {
    const spy = writeSpy()
    const log = createLogger(cfg({ verbose: false }))
    log.warn('careful')
    log.error('boom')
    expect(spy).toHaveBeenCalledTimes(2)
    expect(stripVTControlCharacters(spy.mock.calls[0]![0] as string)).toContain(
      '[warn] careful',
    )
    expect(stripVTControlCharacters(spy.mock.calls[1]![0] as string)).toContain(
      '[error] boom',
    )
  })

  it('emits no ANSI codes when color is off', () => {
    const spy = writeSpy()
    const log = createLogger(cfg({ verbose: true, color: false }))
    log.error('plain')
    const out = spy.mock.calls[0]![0] as string
    expect(out).not.toContain('\u001b')
    expect(out).toContain('[error] plain')
  })

  it('color:true output strips back to the plain text', () => {
    const spy = writeSpy()
    const log = createLogger(cfg({ verbose: true, color: true }))
    log.warn('hi')
    expect(stripVTControlCharacters(spy.mock.calls[0]![0] as string)).toContain(
      '[warn] hi',
    )
  })

  // The test above only checks the *stripped* text — it would pass
  // identically even if color:true silently emitted no ANSI at all (e.g.
  // if paintFor's branches were ever swapped). Assert the raw output
  // actually differs from its stripped form, i.e. codes are genuinely
  // present, not just "harmless if absent".
  it('color:true actually emits ANSI codes, not just plain text that survives stripping', () => {
    const spy = writeSpy()
    const log = createLogger(cfg({ verbose: true, color: true }))
    log.warn('hi')
    const out = spy.mock.calls[0]![0] as string
    expect(out).not.toBe(stripVTControlCharacters(out))
    expect(out).toBe(`${styleText('yellow', '[warn]')} hi\n`)
  })
})

describe('errorMessage', () => {
  it("returns an Error instance's own message", () => {
    expect(errorMessage(new Error('boom'))).toBe('boom')
  })

  it("returns a subclassed Error instance's own message", () => {
    class MyError extends Error {}
    expect(errorMessage(new MyError('custom'))).toBe('custom')
  })

  it('stringifies a plain string as-is', () => {
    expect(errorMessage('already a string')).toBe('already a string')
  })

  it('stringifies a non-Error object via String()', () => {
    expect(errorMessage({ some: 'object' })).toBe('[object Object]')
  })

  it('stringifies other primitives via String()', () => {
    expect(errorMessage(42)).toBe('42')
    expect(errorMessage(null)).toBe('null')
    expect(errorMessage(undefined)).toBe('undefined')
  })
})
