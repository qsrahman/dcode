import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { main } from '../src/index.ts'

describe('main: API key handling', () => {
  let writeSpy: ReturnType<typeof vi.spyOn>
  let exitSpy: ReturnType<typeof vi.spyOn>
  let tmpHome: string
  let savedExitCode: typeof process.exitCode

  // Throwing rather than calling through: a regression to process.exit(1)
  // would otherwise kill the vitest worker instead of failing one test.
  function mockExit(): void {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called')
    }) as (code?: string | number | null) => never)
  }

  // main() reports failure by setting process.exitCode rather than calling
  // process.exit, so these tests must put it back or the vitest worker itself
  // would exit 1 at the end of the run.
  beforeEach(() => {
    savedExitCode = process.exitCode
    // Isolate the global config so a real ~/.config/dcode/dcode.json (e.g. one
    // written via /key) doesn't satisfy the "no key configured" scenario.
    tmpHome = mkdtempSync(join(tmpdir(), 'dcode-itest-'))
    vi.stubEnv('XDG_CONFIG_HOME', tmpHome)
  })

  afterEach(() => {
    writeSpy.mockRestore()
    exitSpy.mockRestore()
    process.exitCode = savedExitCode
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('prints setup guidance and exits 1 when no key is configured', async () => {
    vi.stubEnv('OPENAI_API_KEY', '')
    mockExit()
    writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    await expect(main()).resolves.toBeUndefined()

    expect(writeSpy).toHaveBeenCalledWith(
      expect.stringContaining('OPENAI_API_KEY is not set'),
    )
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('~/.zshrc'))
    expect(process.exitCode).toBe(1)
  })

  // The reason for exitCode over process.exit: writes to a pipe are async on
  // POSIX, so exiting right after writing throws away whatever hadn't been
  // flushed. These are exactly the messages most likely to be redirected —
  // `dcode … 2>err.log` — so a stubbed process.exit that merely records the
  // call proves nothing; the invariant is that it is never called.
  it.each([
    ['no key is configured', { OPENAI_API_KEY: '' }],
    ['auth fails', { OPENAI_API_KEY: 'ollama' }],
  ])('never calls process.exit when %s', async (_label, env) => {
    vi.stubEnv('OPENAI_API_KEY', env.OPENAI_API_KEY)
    if (env.OPENAI_API_KEY) {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ status: 401 } as Response),
      )
    }
    mockExit()
    writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    await expect(main()).resolves.toBeUndefined()

    expect(exitSpy).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
  })

  it('prints an invalid-key message when auth fails', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'ollama')
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ status: 401 } as Response),
    )
    mockExit()
    writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    await expect(main()).resolves.toBeUndefined()

    expect(writeSpy).toHaveBeenCalledWith(
      expect.stringContaining('OPENAI_API_KEY is invalid'),
    )
    expect(writeSpy).toHaveBeenCalledWith(
      expect.stringContaining('authentication failed'),
    )
    expect(process.exitCode).toBe(1)
  })
})
