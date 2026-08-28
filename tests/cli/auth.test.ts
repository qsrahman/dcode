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

  it('returns true on a successful models listing', async () => {
    fetchMock.mockResolvedValue({ status: 200 } as Response)
    expect(await validateApiKey(baseConfig())).toBe(true)
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.openai.com/v1/models',
      expect.objectContaining({ headers: { Authorization: 'Bearer sk-test' } }),
    )
  })

  it('treats 401 as an invalid key', async () => {
    fetchMock.mockResolvedValue({ status: 401 } as Response)
    expect(await validateApiKey(baseConfig())).toBe(false)
  })

  it('treats 403 as an invalid key', async () => {
    fetchMock.mockResolvedValue({ status: 403 } as Response)
    expect(await validateApiKey(baseConfig())).toBe(false)
  })

  it('does not block startup on a network error (treats as valid)', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))
    expect(await validateApiKey(baseConfig())).toBe(true)
  })

  it('does not block startup on a non-auth error status (treats as valid)', async () => {
    fetchMock.mockResolvedValue({ status: 404 } as Response)
    expect(await validateApiKey(baseConfig())).toBe(true)
  })

  it('uses the configured baseURL for the probe', async () => {
    fetchMock.mockResolvedValue({ status: 200 } as Response)
    await validateApiKey(baseConfig({ baseURL: 'http://localhost:11434/' }))
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:11434/v1/models',
      expect.anything(),
    )
  })

  it('appends /v1 to a bare-origin baseURL for the probe', async () => {
    fetchMock.mockResolvedValue({ status: 200 } as Response)
    await validateApiKey(baseConfig({ baseURL: 'http://localhost:11434' }))
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:11434/v1/models',
      expect.anything(),
    )
  })
})
