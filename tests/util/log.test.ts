import { afterEach, describe, expect, it, vi } from 'vitest'
import ansis from 'ansis'
import { appConfigSchema } from '../../src/config/schema.ts'
import { createLogger } from '../../src/util/log.ts'

function writeSpy() {
  return vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
}

describe('createLogger', () => {
  afterEach(() => vi.restoreAllMocks())

  it('debug/info are silent when verbose is off', () => {
    const spy = writeSpy()
    const log = createLogger(appConfigSchema.parse({ verbose: false }))
    log.debug('x')
    log.info('y')
    expect(spy).not.toHaveBeenCalled()
  })

  it('debug writes to stderr when verbose is on', () => {
    const spy = writeSpy()
    const log = createLogger(appConfigSchema.parse({ verbose: true }))
    log.debug('hello', 42)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(ansis.strip(spy.mock.calls[0]![0] as string)).toContain(
      '[debug] hello 42',
    )
  })

  it('warn and error always write regardless of verbose', () => {
    const spy = writeSpy()
    const log = createLogger(appConfigSchema.parse({ verbose: false }))
    log.warn('careful')
    log.error('boom')
    expect(spy).toHaveBeenCalledTimes(2)
    expect(ansis.strip(spy.mock.calls[0]![0] as string)).toContain(
      '[warn] careful',
    )
    expect(ansis.strip(spy.mock.calls[1]![0] as string)).toContain(
      '[error] boom',
    )
  })

  it('emits no ANSI codes when color is off', () => {
    const spy = writeSpy()
    const log = createLogger(
      appConfigSchema.parse({ verbose: true, color: false }),
    )
    log.error('plain')
    const out = spy.mock.calls[0]![0] as string
    expect(out).not.toContain('\u001b')
    expect(out).toContain('[error] plain')
  })

  it('color:true output strips back to the plain text', () => {
    const spy = writeSpy()
    const log = createLogger(
      appConfigSchema.parse({ verbose: true, color: true }),
    )
    log.warn('hi')
    expect(ansis.strip(spy.mock.calls[0]![0] as string)).toContain('[warn] hi')
  })
})
