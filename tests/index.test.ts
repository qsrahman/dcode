import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { main } from '../src/index.ts'

describe('main: API key handling', () => {
  let writeSpy: ReturnType<typeof vi.spyOn>
  let exitSpy: ReturnType<typeof vi.spyOn>
  let tmpHome: string

  function mockExit(): void {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('EXIT')
    }) as (code?: string | number | null) => never)
  }

  // Isolate the global config so a real ~/.config/dcode/dcode.json (e.g. one
  // written via /key) doesn't satisfy the "no key configured" scenario.
  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'dcode-itest-'))
    vi.stubEnv('DCODE_CONFIG_HOME', tmpHome)
  })

  afterEach(() => {
    writeSpy.mockRestore()
    exitSpy.mockRestore()
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('prints setup guidance and exits 1 when no key is configured', async () => {
    vi.stubEnv('OPENAI_API_KEY', '')
    mockExit()
    writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    try {
      await main()
    } catch (e) {
      expect((e as Error).message).toBe('EXIT')
    }

    expect(writeSpy).toHaveBeenCalledWith(
      expect.stringContaining('OPENAI_API_KEY is not set'),
    )
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('~/.zshrc'))
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('prints an invalid-key message and exits 1 when auth fails', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'ollama')
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ status: 401 } as Response),
    )
    mockExit()
    writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    try {
      await main()
    } catch (e) {
      expect((e as Error).message).toBe('EXIT')
    }

    expect(writeSpy).toHaveBeenCalledWith(
      expect.stringContaining('OPENAI_API_KEY is invalid'),
    )
    expect(writeSpy).toHaveBeenCalledWith(
      expect.stringContaining('authentication failed'),
    )
    expect(exitSpy).toHaveBeenCalledWith(1)
  })
})
