import { afterEach, describe, expect, it, vi } from 'vitest'

// web_fetch does no host filtering (opencode-style — network containment is
// the surrounding sandbox's job, not the tool's), so there is no DNS mock:
// every test stubs global fetch directly.
import {
  webSearchTool,
  webFetchTool,
  htmlToMarkdown,
} from '../../src/tools/local/web.ts'
import { runTool } from '../../src/agent/exec.ts'
import type { ToolContext } from '../../src/agent/types.ts'
import { cfg } from '../helpers.ts'
import { createLogger } from '../../src/util/log.ts'

const tool = webSearchTool()
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
      async (_url: string | URL, _init?: RequestInit) =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ web: { results: [] } }),
        }) as unknown as Response,
    )
    vi.stubGlobal('fetch', fetchSpy)
    const ac = new AbortController()
    await tool.execute({ query: 'q' }, { ...ctx, signal: ac.signal })
    // fetchSafely combines ctx.signal with its own timeout signal via
    // AbortSignal.any(), so the object actually passed to fetch() is a new
    // combined signal, not === ac.signal — assert its type instead of
    // identity (the timeout-signal-combination behavior itself is covered by
    // the "always passes an AbortSignal" test in the web_fetch block below).
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(init.signal).not.toBe(ac.signal)
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

  it('returns HTML unconverted when format=html', async () => {
    mockFetchResponse({
      body: '<h1>Title</h1><p>Hello</p>',
      contentType: 'text/html',
    })
    const out = await fetchTool.execute(
      { url: 'https://example.com', format: 'html' },
      ctx,
    )
    expect(out).toBe('<h1>Title</h1><p>Hello</p>')
  })

  it('leaves JSON unconverted when format=text', async () => {
    mockFetchResponse({ body: '{"a":1}', contentType: 'application/json' })
    const out = await fetchTool.execute(
      { url: 'https://example.com', format: 'text' },
      ctx,
    )
    expect(out).toBe('{"a":1}')
  })

  it('sends an Accept header matching the requested format', async () => {
    const fetchSpy = vi.fn(
      async (_url: string | URL, _init?: RequestInit) =>
        ({
          ok: true,
          status: 200,
          headers: { get: () => 'text/plain' },
          body: null,
          text: async () => 'x',
        }) as unknown as Response,
    )
    vi.stubGlobal('fetch', fetchSpy)
    await fetchTool.execute({ url: 'https://example.com', format: 'html' }, ctx)
    const accept = (
      fetchSpy.mock.calls[0]?.[1]?.headers as Record<string, string>
    )?.Accept
    expect(accept).toContain('text/html')
  })

  it('describes binary payloads instead of dumping them', async () => {
    mockFetchResponse({ contentType: 'image/png', contentLength: '1234' })
    const out = await fetchTool.execute({ url: 'https://example.com' }, ctx)
    expect(out).toContain('binary')
    expect(out).toContain('image/png')
    expect(out).toContain('1234 bytes')
  })

  // Both cases are rejected by the tool's own zod schema (z.url with a
  // protocol restriction) before execute() ever runs — via runTool, not a
  // direct execute() call, since parameter validation happens in runTool's
  // tool.parameters.parse(raw), not inside execute() itself. zod's format
  // check doesn't distinguish "not a URL at all" from "a URL with the wrong
  // scheme" (both are the same invalid_format issue), so one message covers
  // both rather than two separately-worded ones.
  it.each(['ftp://example.com', 'not a url'])(
    'rejects a non-http(s) or unparseable URL via schema validation: %s',
    async (url) => {
      const outcome = await runTool(
        { id: 'c', name: 'web_fetch', arguments: JSON.stringify({ url }) },
        fetchTool,
        ctx,
      )
      expect(outcome.ok).toBe(false)
      expect(outcome.output).toContain('must be an absolute http(s) URL')
    },
  )

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

  describe('no host filtering (opencode-style)', () => {
    // The guard was removed deliberately: web_fetch now reaches a
    // private/loopback/metadata address like any other, leaving network
    // containment to the surrounding sandbox. These lock in that a literal
    // internal address is fetched, not refused.
    function okText(): Response {
      return {
        ok: true,
        status: 200,
        headers: {
          get: (k: string) =>
            k.toLowerCase() === 'content-type' ? 'text/plain' : null,
        },
        body: null,
        text: async () => 'internal-body',
      } as unknown as Response
    }

    it('fetches a literal loopback address', async () => {
      const fetchSpy = vi.fn(async () => okText())
      vi.stubGlobal('fetch', fetchSpy)
      const out = await fetchTool.execute(
        { url: 'http://127.0.0.1/admin' },
        ctx,
      )
      expect(out).toBe('internal-body')
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })

    it('fetches the cloud metadata address', async () => {
      const fetchSpy = vi.fn(async () => okText())
      vi.stubGlobal('fetch', fetchSpy)
      await fetchTool.execute(
        { url: 'http://169.254.169.254/latest/meta-data/' },
        ctx,
      )
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
