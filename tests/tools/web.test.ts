import { afterEach, describe, expect, it, vi } from 'vitest'
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
})
