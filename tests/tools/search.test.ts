import { describe, expect, it } from 'vitest'
import { classifyRgFailure } from '../../src/tools/local/search.ts'

// classifyRgFailure is the error-classification runRg falls back to once a
// ripgrep spawn doesn't cleanly exit 0/1. Tested directly against synthetic
// result shapes rather than by actually triggering a maxBuffer overflow or
// timeout against a real ripgrep process, which would be slow and flaky.
function result(over: Partial<Parameters<typeof classifyRgFailure>[0]> = {}) {
  return {
    exitCode: undefined,
    signal: undefined,
    stderr: '',
    isMaxBuffer: false,
    isCanceled: false,
    timedOut: false,
    ...over,
  }
}

describe('classifyRgFailure', () => {
  it('reports a maxBuffer overflow clearly, not "exited with undefined"', () => {
    const err = classifyRgFailure(
      result({ isMaxBuffer: true }),
      10 * 1024 * 1024,
    )
    expect(err.message).toContain('exceeded')
    expect(err.message).not.toContain('undefined')
  })

  it('reports an abort as "aborted"', () => {
    const err = classifyRgFailure(
      result({ isCanceled: true }),
      10 * 1024 * 1024,
    )
    expect(err.message).toBe('aborted')
  })

  it('reports a timeout clearly', () => {
    const err = classifyRgFailure(result({ timedOut: true }), 10 * 1024 * 1024)
    expect(err.message).toBe('ripgrep timed out')
  })

  it('falls back to stderr when present', () => {
    const err = classifyRgFailure(
      result({ stderr: 'regex parse error: bad' }),
      10 * 1024 * 1024,
    )
    expect(err.message).toBe('regex parse error: bad')
  })

  it('falls back to the exit code when stderr is empty', () => {
    const err = classifyRgFailure(result({ exitCode: 2 }), 10 * 1024 * 1024)
    expect(err.message).toBe('ripgrep exited with 2')
  })

  it('falls back to the signal when there is no exit code or stderr', () => {
    const err = classifyRgFailure(
      result({ signal: 'SIGKILL' }),
      10 * 1024 * 1024,
    )
    expect(err.message).toBe('ripgrep exited with SIGKILL')
  })
})
