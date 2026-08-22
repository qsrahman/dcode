import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { webTools } from '../../src/tools/local/web.ts'
import { runTool } from '../../src/agent/run.ts'
import type { ToolContext } from '../../src/agent/types.ts'
import { cfg } from '../helpers.ts'
import { createLogger } from '../../src/util/log.ts'

const tool = webTools[0]!
const ctx: ToolContext = {
  root: '/tmp',
  config: cfg(),
  logger: createLogger(cfg()),
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

beforeEach(() => {
  process.env.BRAVE_API_KEY = 'test-key'
})
afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.BRAVE_API_KEY
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
    delete process.env.BRAVE_API_KEY
    await expect(tool.execute({ query: 'q' }, ctx)).rejects.toThrow(
      'BRAVE_API_KEY',
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
