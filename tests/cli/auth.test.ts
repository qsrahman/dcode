import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { validateApiKey } from '../../src/cli/auth.ts'
import type { Config } from '../../src/config/schema.ts'

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    apiKey: 'sk-test',
    model: 'gpt-4o',
    baseURL: undefined,
    maxRetries: 2,
    maxTokens: 16000,
    maxHistoryItems: 30,
    context: { enabled: false, maxChars: 24000, mode: 'auto' },
    color: false,
    verbose: false,
    stateful: false,
    tools: { write: true, edit: true, shell: true },
    ...overrides,
  } as Config
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
