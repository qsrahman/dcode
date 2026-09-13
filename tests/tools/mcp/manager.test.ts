import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLogger } from '../../../src/util/log.ts'
import { cfg } from '../../helpers.ts'
import type { McpServerConfig } from '../../../src/config/schema.ts'

// connectMcpServers constructs real MCP SDK Client/transport objects and
// spawns/dials real connections — mock the SDK's client-side surface (like
// tests/agent/client.test.ts mocks the OpenAI SDK) so these tests exercise
// dcode's own orchestration (name-qualifying, error isolation, content
// flattening, shutdown) without a real subprocess or network call.

interface FakeTool {
  name: string
  description?: string
  inputSchema: unknown
}

// Keyed by the fake transport's identifying value (command for stdio, url for
// http) rather than by server name — manager.ts never hands the server name
// to the SDK objects themselves, only to logging, so tests key the fakes the
// same way the real objects would be distinguished.
let connectShouldFail: Record<string, boolean>
let listToolsShouldFail: Record<string, boolean>
let toolsFor: Record<string, FakeTool[]>
let callToolResult: { content: unknown[]; isError?: boolean }
let callToolCalls: {
  key: string
  name: string
  args: unknown
  signal: unknown
}[]
let closedKeys: string[]
let connectedSignals: unknown[]
let connectedTransports: {
  params?: Record<string, unknown>
  url?: URL
  opts?: Record<string, unknown>
}[]

function keyFor(transport: {
  params?: Record<string, unknown>
  url?: URL
}): string {
  const command = transport.params?.command
  return (
    (typeof command === 'string' ? command : undefined) ??
    transport.url?.toString() ??
    'unknown'
  )
}

class FakeStdioClientTransport {
  stderr = null
  params: Record<string, unknown>
  constructor(params: Record<string, unknown>) {
    this.params = params
  }
}

class FakeStreamableHTTPClientTransport {
  url: URL
  opts: Record<string, unknown>
  constructor(url: URL, opts: Record<string, unknown>) {
    this.url = url
    this.opts = opts
  }
}

interface FakeTransport {
  params?: Record<string, unknown>
  url?: URL
  opts?: Record<string, unknown>
}

class FakeClient {
  transport?: FakeTransport
  info: unknown
  opts: unknown
  constructor(info: unknown, opts: unknown) {
    this.info = info
    this.opts = opts
  }
  async connect(
    transport: FakeTransport,
    connectOpts: { signal?: unknown },
  ): Promise<void> {
    this.transport = transport
    connectedSignals.push(connectOpts.signal)
    connectedTransports.push(transport)
    if (connectShouldFail[keyFor(transport)]) {
      throw new Error(`connect failed: ${keyFor(transport)}`)
    }
  }
  async listTools(): Promise<{ tools: FakeTool[] }> {
    const key = keyFor(this.transport!)
    if (listToolsShouldFail[key]) throw new Error(`listTools failed: ${key}`)
    return { tools: toolsFor[key] ?? [] }
  }
  async callTool(
    params: { name: string; arguments: unknown },
    _resultSchema: unknown,
    opts: { signal?: unknown },
  ): Promise<{ content: unknown[]; isError?: boolean }> {
    callToolCalls.push({
      key: keyFor(this.transport!),
      name: params.name,
      args: params.arguments,
      signal: opts?.signal,
    })
    return callToolResult
  }
  async close(): Promise<void> {
    closedKeys.push(keyFor(this.transport!))
  }
}

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: FakeClient,
}))
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: FakeStdioClientTransport,
}))
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: FakeStreamableHTTPClientTransport,
}))

const { connectMcpServers } = await import('../../../src/tools/mcp/manager.ts')

function stdio(command: string, env?: Record<string, string>): McpServerConfig {
  return { type: 'stdio', command, args: [], env }
}

function http(url: string, headers?: Record<string, string>): McpServerConfig {
  return { type: 'http', url, headers }
}

const logger = createLogger(cfg())

beforeEach(() => {
  connectShouldFail = {}
  listToolsShouldFail = {}
  toolsFor = {}
  callToolResult = { content: [{ type: 'text', text: 'ok' }] }
  callToolCalls = []
  closedKeys = []
  connectedSignals = []
  connectedTransports = []
})

describe('connectMcpServers', () => {
  it("wraps a connected server's tools under a qualified name", async () => {
    toolsFor['srv'] = [
      {
        name: 'search',
        description: 'find stuff',
        inputSchema: { type: 'object' },
      },
    ]
    const mgr = await connectMcpServers({ srv: stdio('srv') }, logger)
    expect(mgr.tools).toHaveLength(1)
    expect(mgr.tools[0]!.name).toBe('mcp__srv__search')
    expect(mgr.tools[0]!.description).toBe('find stuff')
    expect(mgr.tools[0]!.jsonSchema).toEqual({ type: 'object' })
    expect(mgr.servers).toEqual([
      { name: 'srv', status: 'connected', toolCount: 1 },
    ])
  })

  it('falls back to a generated description when the server omits one', async () => {
    toolsFor['srv'] = [{ name: 'search', inputSchema: {} }]
    const mgr = await connectMcpServers({ srv: stdio('srv') }, logger)
    expect(mgr.tools[0]!.description).toContain('search')
    expect(mgr.tools[0]!.description).toContain('srv')
  })

  it('connects multiple servers in parallel and merges their tools', async () => {
    toolsFor['a'] = [{ name: 'x', inputSchema: {} }]
    toolsFor['b'] = [{ name: 'y', inputSchema: {} }]
    const mgr = await connectMcpServers(
      { a: stdio('a'), b: stdio('b') },
      logger,
    )
    const names = mgr.tools.map((t) => t.name).sort()
    expect(names).toEqual(['mcp__a__x', 'mcp__b__y'])
  })

  it('skips a server that fails to connect, logs a warning, and keeps the rest', async () => {
    connectShouldFail['bad'] = true
    toolsFor['good'] = [{ name: 'z', inputSchema: {} }]
    const warn = vi.fn()
    const mgr = await connectMcpServers(
      { bad: stdio('bad'), good: stdio('good') },
      { ...logger, warn },
    )
    expect(mgr.tools.map((t) => t.name)).toEqual(['mcp__good__z'])
    expect(mgr.servers.find((s) => s.name === 'bad')).toMatchObject({
      status: 'failed',
    })
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('failed to connect'),
      'bad',
      expect.stringContaining('connect failed'),
    )
  })

  it('skips a server whose listTools fails after connecting', async () => {
    listToolsShouldFail['flaky'] = true
    const mgr = await connectMcpServers({ flaky: stdio('flaky') }, logger)
    expect(mgr.tools).toHaveLength(0)
    expect(mgr.servers[0]).toMatchObject({ name: 'flaky', status: 'failed' })
    // The client still connected (and so still needs closing) even though
    // listing its tools failed — close() must not be skipped for it.
    await mgr.close()
    expect(closedKeys).toContain('flaky')
  })

  it('numbers a name collision instead of silently dropping the second tool', async () => {
    // Two distinct servers exposing a same-named tool sanitize to distinct
    // qualified names by construction (the server name is folded in), but a
    // pathological case (e.g. server names that sanitize to the same string)
    // must still keep both tools reachable rather than one silently
    // overwriting the other in the registry.
    toolsFor['a.b'] = [{ name: 't', inputSchema: {} }]
    toolsFor['a_b'] = [{ name: 't', inputSchema: {} }]
    const mgr = await connectMcpServers(
      { 'a.b': stdio('a.b'), a_b: stdio('a_b') },
      logger,
    )
    const names = mgr.tools.map((t) => t.name)
    expect(new Set(names).size).toBe(2)
    expect(names).toContain('mcp__a_b__t')
    expect(names.some((n) => n === 'mcp__a_b__t_2')).toBe(true)
  })

  describe('${VAR} env placeholders in headers/env', () => {
    afterEach(() => vi.unstubAllEnvs())

    it('expands a header value that is exactly ${VAR} from process.env', async () => {
      vi.stubEnv('CONTEXT7_API_KEY', 'secret-value')
      toolsFor['https://example.com/mcp'] = []
      await connectMcpServers(
        {
          context7: http('https://example.com/mcp', {
            CONTEXT7_API_KEY: '${CONTEXT7_API_KEY}',
          }),
        },
        logger,
      )
      const transport = connectedTransports[0]!
      expect(transport.opts?.requestInit).toEqual({
        headers: { CONTEXT7_API_KEY: 'secret-value' },
      })
    })

    it('expands a stdio env value the same way, on top of the filtered ambient env', async () => {
      vi.stubEnv('MY_SECRET', 'shh')
      toolsFor['srv'] = []
      await connectMcpServers(
        { srv: stdio('srv', { MY_SECRET: '${MY_SECRET}' }) },
        logger,
      )
      const transport = connectedTransports[0]!
      expect(transport.params?.env).toMatchObject({ MY_SECRET: 'shh' })
    })

    it('leaves a plain (non-placeholder) value untouched', async () => {
      toolsFor['https://example.com/mcp'] = []
      await connectMcpServers(
        {
          context7: http('https://example.com/mcp', {
            Authorization: 'Bearer literal-token',
          }),
        },
        logger,
      )
      const transport = connectedTransports[0]!
      expect(transport.opts?.requestInit).toEqual({
        headers: { Authorization: 'Bearer literal-token' },
      })
    })

    it('fails that one server (not the whole batch) when the referenced variable is unset', async () => {
      toolsFor['ok-server'] = [{ name: 'x', inputSchema: {} }]
      const mgr = await connectMcpServers(
        {
          missing: http('https://example.com/mcp', {
            CONTEXT7_API_KEY: '${DEFINITELY_NOT_SET_XYZ}',
          }),
          ok: stdio('ok-server'),
        },
        logger,
      )
      expect(mgr.tools.map((t) => t.name)).toEqual(['mcp__ok__x'])
      const failed = mgr.servers.find((s) => s.name === 'missing')
      expect(failed?.status).toBe('failed')
      expect(failed?.error).toContain('DEFINITELY_NOT_SET_XYZ')
      expect(failed?.error).toContain('not set')
    })
  })

  describe('a wrapped tool', () => {
    it('forwards call args and ctx.signal to callTool', async () => {
      toolsFor['srv'] = [{ name: 'search', inputSchema: {} }]
      const mgr = await connectMcpServers({ srv: stdio('srv') }, logger)
      const ac = new AbortController()
      const result = await mgr.tools[0]!.execute(
        { q: 'hello' },
        { root: '/tmp', config: cfg(), logger, signal: ac.signal },
      )
      expect(result).toBe('ok')
      expect(callToolCalls[0]).toMatchObject({
        key: 'srv',
        name: 'search',
        args: { q: 'hello' },
        signal: ac.signal,
      })
    })

    it('joins multiple text content parts and describes non-text parts', async () => {
      callToolResult = {
        content: [
          { type: 'text', text: 'first' },
          { type: 'text', text: 'second' },
          { type: 'image', mimeType: 'image/png' },
        ],
      }
      toolsFor['srv'] = [{ name: 'render', inputSchema: {} }]
      const mgr = await connectMcpServers({ srv: stdio('srv') }, logger)
      const result = await mgr.tools[0]!.execute(
        {},
        { root: '/tmp', config: cfg(), logger },
      )
      expect(result).toContain('first')
      expect(result).toContain('second')
      expect(result).toContain('image/png')
      expect(result).toContain('not shown')
    })

    it('throws when the MCP result reports isError, taking the ok:false path', async () => {
      callToolResult = {
        content: [{ type: 'text', text: 'bad args' }],
        isError: true,
      }
      toolsFor['srv'] = [{ name: 'search', inputSchema: {} }]
      const mgr = await connectMcpServers({ srv: stdio('srv') }, logger)
      await expect(
        mgr.tools[0]!.execute({}, { root: '/tmp', config: cfg(), logger }),
      ).rejects.toThrow('bad args')
    })
  })

  it('close() closes every connected client', async () => {
    toolsFor['a'] = []
    toolsFor['b'] = []
    const mgr = await connectMcpServers(
      { a: stdio('a'), b: stdio('b') },
      logger,
    )
    await mgr.close()
    expect(closedKeys.sort()).toEqual(['a', 'b'])
  })

  it('close() never throws even if a client fails to close', async () => {
    toolsFor['srv'] = []
    const mgr = await connectMcpServers({ srv: stdio('srv') }, logger)
    const client = (await import('@modelcontextprotocol/sdk/client/index.js'))
      .Client as unknown as { prototype: FakeClient }
    const original = client.prototype.close
    client.prototype.close = async () => {
      throw new Error('close failed')
    }
    try {
      await expect(mgr.close()).resolves.toBeUndefined()
    } finally {
      client.prototype.close = original
    }
  })

  it('returns no tools and no servers when nothing is configured', async () => {
    const mgr = await connectMcpServers({}, logger)
    expect(mgr.tools).toEqual([])
    expect(mgr.servers).toEqual([])
  })
})
