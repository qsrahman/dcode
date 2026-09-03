import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { validateApiKey, ensureApiKey } from '../../src/cli/auth.ts'
import * as keys from '../../src/cli/keys.ts'
import { createLogger } from '../../src/util/log.ts'
import { cfg } from '../helpers.ts'

// Built from the real configSchema (via the shared `cfg` helper), not a
// hand-rolled object cast `as Config` — a stale/invented shape (e.g. fields
// that don't exist on the real schema) would pass type-checking under a
// cast but silently stop reflecting what validateApiKey actually receives
// at runtime.
function baseConfig(overrides: Parameters<typeof cfg>[0] = {}) {
  return cfg({ apiKey: 'sk-test', model: 'gpt-4o', ...overrides })
}

describe('validateApiKey', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns valid on a successful models listing', async () => {
    fetchMock.mockResolvedValue({ status: 200, ok: true } as Response)
    expect(await validateApiKey(baseConfig())).toBe('valid')
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.openai.com/v1/models',
      expect.objectContaining({ headers: { Authorization: 'Bearer sk-test' } }),
    )
  })

  it('treats 401 as an invalid key', async () => {
    fetchMock.mockResolvedValue({ status: 401, ok: false } as Response)
    expect(await validateApiKey(baseConfig())).toBe('invalid')
  })

  it('treats 403 as an invalid key', async () => {
    fetchMock.mockResolvedValue({ status: 403, ok: false } as Response)
    expect(await validateApiKey(baseConfig())).toBe('invalid')
  })

  it('does not block startup on a network error, but reports it as unknown (not verified)', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))
    expect(await validateApiKey(baseConfig())).toBe('unknown')
  })

  it('does not block startup on a non-auth error status, but reports it as unknown', async () => {
    fetchMock.mockResolvedValue({ status: 404, ok: false } as Response)
    expect(await validateApiKey(baseConfig())).toBe('unknown')
  })

  it('reports unknown (not blocked, not verified) when the request times out', async () => {
    fetchMock.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          const err = new Error('timeout')
          err.name = 'TimeoutError'
          reject(err)
        }),
    )
    expect(await validateApiKey(baseConfig())).toBe('unknown')
  })

  it('bounds the request with a timeout signal', async () => {
    fetchMock.mockResolvedValue({ status: 200, ok: true } as Response)
    await validateApiKey(baseConfig())
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('uses the configured baseURL for the probe', async () => {
    fetchMock.mockResolvedValue({ status: 200, ok: true } as Response)
    await validateApiKey(baseConfig({ baseURL: 'http://localhost:11434/' }))
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:11434/v1/models',
      expect.anything(),
    )
  })

  it('appends /v1 to a bare-origin baseURL for the probe', async () => {
    fetchMock.mockResolvedValue({ status: 200, ok: true } as Response)
    await validateApiKey(baseConfig({ baseURL: 'http://localhost:11434' }))
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:11434/v1/models',
      expect.anything(),
    )
  })
})

// The startup auth flow (prompt → validate → persist) moved out of index.ts's
// main(), where it was ~45 inline lines that no test could reach without
// running the whole binary. It returns the fatal message rather than calling
// process.exit, so the caller owns how the process ends and this is testable.
describe('ensureApiKey', () => {
  const realIsTTY = process.stdin.isTTY

  afterEach(() => {
    process.stdin.isTTY = realIsTTY
    vi.restoreAllMocks()
  })

  it('returns the setup help when there is no key and no TTY to prompt on', async () => {
    process.stdin.isTTY = false
    const config = cfg({ apiKey: undefined })
    const out = await ensureApiKey(config, createLogger(cfg()), true)
    expect(out).toMatch(/OPENAI_API_KEY is not set/)
  })

  it('blocks startup on a confirmed 401 and stores nothing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 401 })),
    )
    const setKey = vi.spyOn(keys, 'setGlobalKey')
    const out = await ensureApiKey(baseConfig(), createLogger(cfg()), false)
    expect(out).toMatch(/invalid \(authentication failed\)/)
    expect(setKey).not.toHaveBeenCalled()
  })

  it('allows startup on an indeterminate check', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 404 })),
    )
    expect(
      await ensureApiKey(baseConfig(), createLogger(cfg()), false),
    ).toBeNull()
  })

  it('allows startup when the key checks out', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 200 })),
    )
    expect(
      await ensureApiKey(baseConfig(), createLogger(cfg()), false),
    ).toBeNull()
  })
})
