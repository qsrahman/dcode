import { afterEach, describe, expect, it, vi } from 'vitest'

// web_fetch resolves hostnames via node:dns/promises before connecting (SSRF
// guard). Mock it so tests stay deterministic/offline by default — real DNS
// lookups have no place in a unit test — while still letting individual
// tests override the resolved address to exercise the guard itself.
const lookupMock = vi.hoisted(() =>
  vi.fn(async (_hostname: string, _opts?: unknown) => [
    { address: '93.184.216.34', family: 4 },
  ]),
)
vi.mock('node:dns/promises', () => ({
  lookup: lookupMock,
}))

import {
  webTools,
  webFetchTool,
  htmlToMarkdown,
} from '../../src/tools/local/web.ts'
import { runTool } from '../../src/agent/run.ts'
import type { ToolContext } from '../../src/agent/types.ts'
import { cfg } from '../helpers.ts'
import { createLogger } from '../../src/util/log.ts'

const tool = webTools[0]!
const fetchTool = webFetchTool()
const ctx: ToolContext = {
  root: '/tmp',
  config: cfg({ brave: 'test-key' }),
  logger: createLogger(cfg()),
}

function mockFetchResponse(opts: {
  body?: string
  contentType?: string
  contentLength?: string
  ok?: boolean
  status?: number
}): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        ({
          ok: opts.ok ?? true,
          status: opts.status ?? 200,
          headers: {
            get: (k: string) => {
              const key = k.toLowerCase()
              if (key === 'content-type')
                return opts.contentType ?? 'text/plain'
              if (key === 'content-length') return opts.contentLength ?? null
              return null
            },
          },
          text: async () => opts.body ?? '',
          json: async () => JSON.parse(opts.body ?? 'null'),
        }) as unknown as Response,
    ),
  )
}

function mockFetch(body: unknown, ok = true, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        ({
          ok,
          status,
          json: async () => body,
        }) as unknown as Response,
    ),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
  lookupMock.mockClear()
})

describe('web_search', () => {
  it('formats Brave results as title/url/snippet blocks', async () => {
    mockFetch({
      web: {
        results: [
          { title: 'A', url: 'https://a.example', description: 'da' },
          { title: 'B', url: 'https://b.example', description: 'db' },
        ],
      },
    })
    const out = await tool.execute({ query: 'q' }, ctx)
    expect(out).toContain('A')
    expect(out).toContain('https://a.example')
    expect(out).toContain('da')
    expect(out).toContain('B')
  })

  it('reports a missing API key', async () => {
    const noKeyCtx: ToolContext = { ...ctx, config: cfg() }
    await expect(tool.execute({ query: 'q' }, noKeyCtx)).rejects.toThrow(
      'BRAVE_API_KEY',
    )
  })

  // ctx.config.brave is the only source dcode reads for this key (buildConfig
  // already folds BRAVE_API_KEY into it before a tool ever runs) — a bare
  // process.env value with no matching config must not work.
  it('ignores process.env.BRAVE_API_KEY; only ctx.config.brave is used', async () => {
    process.env.BRAVE_API_KEY = 'env-key'
    try {
      const noKeyCtx: ToolContext = { ...ctx, config: cfg() }
      await expect(tool.execute({ query: 'q' }, noKeyCtx)).rejects.toThrow(
        'BRAVE_API_KEY',
      )
    } finally {
      delete process.env.BRAVE_API_KEY
    }
  })

  it('forwards ctx.signal to the search request', async () => {
    const fetchSpy = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ web: { results: [] } }),
        }) as unknown as Response,
    )
    vi.stubGlobal('fetch', fetchSpy)
    const ac = new AbortController()
    await tool.execute({ query: 'q' }, { ...ctx, signal: ac.signal })
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ signal: ac.signal }),
    )
  })

  it('returns (no results) when the result set is empty', async () => {
    mockFetch({ web: { results: [] } })
    const out = await tool.execute({ query: 'q' }, ctx)
    expect(out).toBe('(no results)')
  })

  it('surfaces API errors', async () => {
    mockFetch({}, false, 401)
    await expect(tool.execute({ query: 'q' }, ctx)).rejects.toThrow('401')
  })

  it('surfaces network failures', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connection reset')
      }),
    )
    await expect(tool.execute({ query: 'q' }, ctx)).rejects.toThrow(
      'web search request failed: connection reset',
    )
  })

  // Thrown tool errors must reach the model as ok:false outcomes (decision D),
  // not as successful output that merely looks like an error.
  it('yields ok:false via runTool on API error', async () => {
    mockFetch({}, false, 401)
    const outcome = await runTool(
      { id: 'c1', name: 'web_search', arguments: '{"query":"q"}' },
      tool,
      ctx,
    )
    expect(outcome.ok).toBe(false)
    expect(outcome.output).toContain('error: Brave API returned 401')
  })
})

describe('web_fetch', () => {
  it('converts HTML to Markdown', () => {
    expect(htmlToMarkdown('<h1>T</h1><p>body</p>')).toContain('# T')
    expect(htmlToMarkdown('<h1>T</h1><p>body</p>')).toContain('body')
  })

  it('returns Markdown for an HTML response', async () => {
    mockFetchResponse({
      body: '<h1>Title</h1><p>Hello</p>',
      contentType: 'text/html',
    })
    const out = await fetchTool.execute({ url: 'https://example.com' }, ctx)
    expect(out).toContain('# Title')
    expect(out).toContain('Hello')
  })

  it('pretty-prints JSON', async () => {
    mockFetchResponse({ body: '{"a":1}', contentType: 'application/json' })
    const out = await fetchTool.execute({ url: 'https://example.com' }, ctx)
    expect(out).toContain('"a": 1')
  })

  it('returns plain text as-is', async () => {
    mockFetchResponse({ body: 'just text', contentType: 'text/plain' })
    const out = await fetchTool.execute({ url: 'https://example.com' }, ctx)
    expect(out).toBe('just text')
  })

  it('describes binary payloads instead of dumping them', async () => {
    mockFetchResponse({ contentType: 'image/png', contentLength: '1234' })
    const out = await fetchTool.execute({ url: 'https://example.com' }, ctx)
    expect(out).toContain('binary')
    expect(out).toContain('image/png')
    expect(out).toContain('1234 bytes')
  })

  it('rejects unsupported schemes', async () => {
    await expect(
      fetchTool.execute({ url: 'ftp://example.com' }, ctx),
    ).rejects.toThrow(/scheme/)
  })

  it('rejects unparseable URLs', async () => {
    await expect(fetchTool.execute({ url: 'not a url' }, ctx)).rejects.toThrow(
      /invalid URL/,
    )
  })

  it('yields ok:false via runTool on a non-2xx status', async () => {
    mockFetchResponse({
      ok: false,
      status: 404,
      contentType: 'text/html',
      body: '<p>nf</p>',
    })
    const outcome = await runTool(
      {
        id: 'c2',
        name: 'web_fetch',
        arguments: '{"url":"https://example.com"}',
      },
      fetchTool,
      ctx,
    )
    expect(outcome.ok).toBe(false)
    expect(outcome.output).toContain('error: web fetch failed: HTTP 404')
  })

  it('surfaces network failures', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED')
      }),
    )
    await expect(
      fetchTool.execute({ url: 'https://example.com' }, ctx),
    ).rejects.toThrow('web fetch request failed: ECONNREFUSED')
  })

  describe('SSRF guard', () => {
    it('rejects a literal loopback address without a DNS lookup', async () => {
      const fetchSpy = vi.fn()
      vi.stubGlobal('fetch', fetchSpy)
      await expect(
        fetchTool.execute({ url: 'http://127.0.0.1/admin' }, ctx),
      ).rejects.toThrow(/private\/internal address/)
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(lookupMock).not.toHaveBeenCalled()
    })

    it('rejects the cloud metadata address', async () => {
      const fetchSpy = vi.fn()
      vi.stubGlobal('fetch', fetchSpy)
      await expect(
        fetchTool.execute(
          { url: 'http://169.254.169.254/latest/meta-data/' },
          ctx,
        ),
      ).rejects.toThrow(/private\/internal address/)
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('rejects a hostname that resolves to a private address', async () => {
      lookupMock.mockResolvedValueOnce([{ address: '10.0.0.5', family: 4 }])
      const fetchSpy = vi.fn()
      vi.stubGlobal('fetch', fetchSpy)
      await expect(
        fetchTool.execute({ url: 'https://internal.example' }, ctx),
      ).rejects.toThrow(/private\/internal address/)
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('re-validates redirect targets and rejects a redirect into a private address', async () => {
      const fetchSpy = vi.fn(
        async () =>
          ({
            ok: false,
            status: 302,
            headers: {
              get: (k: string) =>
                k.toLowerCase() === 'location'
                  ? 'http://127.0.0.1/secret'
                  : null,
            },
            text: async () => '',
          }) as unknown as Response,
      )
      vi.stubGlobal('fetch', fetchSpy)
      await expect(
        fetchTool.execute({ url: 'https://example.com/redirect' }, ctx),
      ).rejects.toThrow(/private\/internal address/)
      // The second (private) hop is never actually requested.
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })

    it('always passes an AbortSignal to fetch, even without ctx.signal', async () => {
      const fetchSpy = vi.fn(
        async (_url: string | URL, _init?: RequestInit) =>
          ({
            ok: true,
            status: 200,
            headers: { get: () => 'text/plain' },
            text: async () => 'ok',
          }) as unknown as Response,
      )
      vi.stubGlobal('fetch', fetchSpy)
      await fetchTool.execute({ url: 'https://example.com' }, ctx)
      expect(fetchSpy.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
    })
  })

  it('truncates a response body larger than the buffer cap', async () => {
    const bigLength = 6 * 1024 * 1024 // > the 5 MiB web_fetch buffer cap
    const bytes = new TextEncoder().encode('a'.repeat(bigLength))
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const chunkSize = 1024 * 1024
        for (let i = 0; i < bytes.length; i += chunkSize) {
          controller.enqueue(bytes.subarray(i, i + chunkSize))
        }
        controller.close()
      },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            headers: {
              get: (k: string) =>
                k.toLowerCase() === 'content-type' ? 'text/plain' : null,
            },
            body: stream,
          }) as unknown as Response,
      ),
    )
    const out = await fetchTool.execute({ url: 'https://example.com/big' }, ctx)
    expect(out.length).toBeLessThan(bigLength)
    expect(out).toContain('truncated')
  })
})
