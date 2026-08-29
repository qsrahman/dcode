import { describe, expect, it } from 'vitest'
import ansis from 'ansis'
import { z } from 'zod'
import type {
  Client,
  OpenAIResponse,
  ResponseInput,
} from '../../src/agent/client.ts'
import {
  runAgent,
  renderToolResult,
  renderToolOutput,
} from '../../src/agent/loop.ts'
import type { ToolDefinition } from '../../src/agent/types.ts'
import { ToolRegistry } from '../../src/tools/registry.ts'
import { createLogger } from '../../src/util/log.ts'
import { cfg, messageItem } from '../helpers.ts'

function fakeClientWithCalls(calls: unknown[][]): Client {
  let turn = 0
  return {
    stream() {
      const text = `turn ${turn}`
      return {
        async *[Symbol.asyncIterator]() {
          yield text
        },
        finalResponse: async () => {
          // A message item alongside any function_call items, mirroring how
          // the real API backs output_text — see helpers.ts's messageItem.
          const output = [messageItem(text), ...(calls[turn] ?? [])]
          turn++
          return { output, output_text: text } as unknown as OpenAIResponse
        },
      }
    },
  }
}

const readTool: ToolDefinition = {
  name: 'read_file',
  description: 'reads',
  parameters: z.object({}),
  async execute() {
    return 'file contents'
  },
}

const writeTool: ToolDefinition = {
  name: 'write_file',
  description: 'writes',
  parameters: z.object({ path: z.string() }),
  async execute(args: { path: string }) {
    return `wrote ${args.path}`
  },
}

describe('runAgent', () => {
  it('streams text and stops when there are no tool calls', async () => {
    const client = fakeClientWithCalls([[]])
    const history: ResponseInput = [{ role: 'user', content: 'go' }]
    const text = await runAgent(client, cfg(), history, {
      logger: createLogger(cfg()),
    })
    expect(text).toBe('turn 0')
    // The assistant turn is now the SDK's own `message` output item (via
    // toResponseInputItems), not a hand-reconstructed {role, content} pair.
    const last = history.at(-1) as { type?: string; role?: string }
    expect(last.type).toBe('message')
    expect(last.role).toBe('assistant')
  })

  it('runs tools, feeds results back, and terminates', async () => {
    const client = fakeClientWithCalls([
      [
        {
          type: 'function_call',
          call_id: 'c1',
          name: 'read_file',
          arguments: '{"path":"a.txt"}',
        },
      ],
      [],
    ])
    const history: ResponseInput = [{ role: 'user', content: 'go' }]
    const text = await runAgent(client, cfg(), history, {
      logger: createLogger(cfg()),
      tools: new ToolRegistry([readTool]),
    })
    expect(text).toBe('turn 1')
    const outputs = history.filter(
      (h) => (h as { type?: string }).type === 'function_call_output',
    )
    expect(outputs).toHaveLength(1)
    expect((outputs[0] as { output: string }).output).toBe('file contents')
  })

  it('caps iterations at maxToolIterations', async () => {
    const client: Client = {
      stream() {
        return {
          async *[Symbol.asyncIterator]() {
            yield 'loop'
          },
          finalResponse: async () =>
            ({
              output: [
                {
                  type: 'function_call',
                  call_id: 'c',
                  name: 'read_file',
                  arguments: '{}',
                },
              ],
              output_text: 'loop',
            }) as unknown as OpenAIResponse,
        }
      },
    }
    const history: ResponseInput = [{ role: 'user', content: 'go' }]
    await runAgent(client, cfg({ maxToolIterations: 3 }), history, {
      logger: createLogger(cfg()),
      tools: new ToolRegistry([readTool]),
    })
    const outputs = history.filter(
      (h) => (h as { type?: string }).type === 'function_call_output',
    )
    expect(outputs).toHaveLength(3)
  })

  // Reasoning models require reasoning items to be replayed alongside their
  // corresponding function_call on every stateless (store: false) turn that
  // continues a tool call — a hand-reconstructed history that only kept
  // function_call items would silently drop them.
  it('replays reasoning items alongside function_call items', async () => {
    const client = fakeClientWithCalls([
      [
        { type: 'reasoning', id: 'r1', summary: [] },
        {
          type: 'function_call',
          call_id: 'c1',
          name: 'read_file',
          arguments: '{"path":"a"}',
        },
      ],
      [],
    ])
    const history: ResponseInput = [{ role: 'user', content: 'go' }]
    await runAgent(client, cfg(), history, {
      logger: createLogger(cfg()),
      tools: new ToolRegistry([readTool]),
    })
    const reasoning = history.find(
      (h) => (h as { type?: string }).type === 'reasoning',
    )
    expect(reasoning).toBeDefined()
    // The reasoning item must come before its function_call, matching the
    // order the model actually emitted them in.
    const reasoningIdx = history.findIndex(
      (h) => (h as { type?: string }).type === 'reasoning',
    )
    const callIdx = history.findIndex(
      (h) => (h as { type?: string }).type === 'function_call',
    )
    expect(reasoningIdx).toBeLessThan(callIdx)
  })

  it('runs mutating tools unconditionally', async () => {
    const client = fakeClientWithCalls([
      [
        {
          type: 'function_call',
          call_id: 'c1',
          name: 'write_file',
          arguments: '{"path":"a.txt"}',
        },
      ],
      [],
    ])
    const history: ResponseInput = [{ role: 'user', content: 'go' }]
    await runAgent(client, cfg(), history, {
      logger: createLogger(cfg()),
      tools: new ToolRegistry([writeTool]),
    })
    const outputs = history.filter(
      (h) => (h as { type?: string }).type === 'function_call_output',
    )
    expect((outputs[0] as { output: string }).output).toBe('wrote a.txt')
  })

  it('runs mutating tools sequentially in call order', async () => {
    const order: string[] = []
    const seqTool: ToolDefinition = {
      name: 'write_file',
      description: 'writes',
      parameters: z.object({ path: z.string() }),
      async execute(args: { path: string }) {
        order.push(args.path)
        return `wrote ${args.path}`
      },
    }
    const client = fakeClientWithCalls([
      [
        {
          type: 'function_call',
          call_id: 'c1',
          name: 'write_file',
          arguments: '{"path":"a"}',
        },
        {
          type: 'function_call',
          call_id: 'c2',
          name: 'write_file',
          arguments: '{"path":"b"}',
        },
      ],
      [],
    ])
    const history: ResponseInput = [{ role: 'user', content: 'go' }]
    await runAgent(client, cfg(), history, {
      logger: createLogger(cfg()),
      tools: new ToolRegistry([seqTool]),
    })
    expect(order).toEqual(['a', 'b'])
  })

  it('runs parallel-eligible (read) calls concurrently via Promise.all', async () => {
    let active = 0
    let maxActive = 0
    const makeRead = (name: string): ToolDefinition => ({
      name,
      description: 'reads',
      parameters: z.object({}),
      async execute() {
        active++
        maxActive = Math.max(maxActive, active)
        await new Promise((r) => setTimeout(r, 20))
        active--
        return 'ok'
      },
    })
    const client = fakeClientWithCalls([
      [
        {
          type: 'function_call',
          call_id: 'c1',
          name: 'read_a',
          arguments: '{}',
        },
        {
          type: 'function_call',
          call_id: 'c2',
          name: 'read_b',
          arguments: '{}',
        },
      ],
      [],
    ])
    const history: ResponseInput = [{ role: 'user', content: 'go' }]
    await runAgent(client, cfg(), history, {
      logger: createLogger(cfg()),
      tools: new ToolRegistry([makeRead('read_a'), makeRead('read_b')]),
    })
    // Both reads ran in the same Promise.all batch, so peak concurrency was 2.
    expect(maxActive).toBe(2)
  })

  it('runs mutating (parallel:false) calls sequentially', async () => {
    let active = 0
    let maxActive = 0
    const write: ToolDefinition = {
      name: 'write_file',
      description: 'writes',
      parameters: z.object({ path: z.string() }),
      parallel: false,
      async execute() {
        active++
        maxActive = Math.max(maxActive, active)
        await new Promise((r) => setTimeout(r, 20))
        active--
        return 'ok'
      },
    }
    const client = fakeClientWithCalls([
      [
        {
          type: 'function_call',
          call_id: 'c1',
          name: 'write_file',
          arguments: '{"path":"a"}',
        },
        {
          type: 'function_call',
          call_id: 'c2',
          name: 'write_file',
          arguments: '{"path":"b"}',
        },
      ],
      [],
    ])
    const history: ResponseInput = [{ role: 'user', content: 'go' }]
    await runAgent(client, cfg(), history, {
      logger: createLogger(cfg()),
      tools: new ToolRegistry([write]),
    })
    // Mutating calls run one at a time, so peak concurrency was 1.
    expect(maxActive).toBe(1)
  })

  it('preserves call order in history across read and mutate results', async () => {
    const readTool2: ToolDefinition = {
      name: 'read_file',
      description: 'reads',
      parameters: z.object({ path: z.string() }),
      async execute() {
        return 'ok'
      },
    }
    const writeTool2: ToolDefinition = {
      name: 'write_file',
      description: 'writes',
      parameters: z.object({ path: z.string() }),
      async execute() {
        return 'ok'
      },
    }
    const client = fakeClientWithCalls([
      [
        {
          type: 'function_call',
          call_id: 'c1',
          name: 'write_file',
          arguments: '{"path":"a"}',
        },
        {
          type: 'function_call',
          call_id: 'c2',
          name: 'read_file',
          arguments: '{"path":"b"}',
        },
      ],
      [],
    ])
    const history: ResponseInput = [{ role: 'user', content: 'go' }]
    await runAgent(client, cfg(), history, {
      logger: createLogger(cfg()),
      tools: new ToolRegistry([readTool2, writeTool2]),
    })
    const outputs = history.filter(
      (h) => (h as { type?: string }).type === 'function_call_output',
    ) as { call_id: string; output: string }[]
    expect(outputs.map((o) => o.call_id)).toEqual(['c1', 'c2'])
  })

  it('passes the system prompt via instructions, not as a history item', async () => {
    const calls: { input: ResponseInput; opts: { instructions?: string } }[] =
      []
    const client: Client = {
      stream(input, opts) {
        calls.push({ input, opts: opts ?? {} })
        return {
          async *[Symbol.asyncIterator]() {
            yield 'ok'
          },
          finalResponse: async () =>
            ({ output: [], output_text: 'ok' }) as unknown as OpenAIResponse,
        }
      },
    }
    const history: ResponseInput = [{ role: 'user', content: 'go' }]
    await runAgent(client, cfg(), history, { logger: createLogger(cfg()) })
    expect(calls.length).toBeGreaterThan(0)
    expect(typeof calls[0]!.opts.instructions).toBe('string')
    expect(calls[0]!.opts.instructions).toContain('Working directory')
    // The system prompt is carried via `instructions`, never injected as a
    // `system` role item in the conversation history.
    expect(
      history.some((h) => (h as { role?: string }).role === 'system'),
    ).toBe(false)
  })

  it('on abort, throws but leaves history balanced (every call has an output)', async () => {
    const client = fakeClientWithCalls([
      [
        {
          type: 'function_call',
          call_id: 'c1',
          name: 'read_file',
          arguments: '{}',
        },
        {
          type: 'function_call',
          call_id: 'c2',
          name: 'read_file',
          arguments: '{}',
        },
      ],
      [],
    ])
    const ac = new AbortController()
    ac.abort()
    const history: ResponseInput = [{ role: 'user', content: 'go' }]
    await expect(
      runAgent(client, cfg(), history, {
        logger: createLogger(cfg()),
        tools: new ToolRegistry([readTool]),
        signal: ac.signal,
      }),
    ).rejects.toThrow(/aborted/)
    const calls = history.filter(
      (h) => (h as { type?: string }).type === 'function_call',
    )
    const outputs = history.filter(
      (h) => (h as { type?: string }).type === 'function_call_output',
    )
    expect(calls).toHaveLength(2)
    expect(outputs).toHaveLength(2)
    expect((outputs[0] as { output: string }).output).toBe('aborted')
  })
})

describe('tool result rendering', () => {
  it('shows a check for success and a cross for failure', () => {
    expect(ansis.strip(renderToolResult('read_file', true, 0, true))).toBe(
      '› read_file: ✓ done (0.0s)',
    )
    expect(ansis.strip(renderToolResult('grep', false, 1200, true))).toBe(
      '› grep: ✗ failed (1.2s)',
    )
  })

  it('fences the raw output between rules naming the tool', () => {
    const stripped = ansis.strip(renderToolOutput('grep', 'a\nb', true))
    expect(stripped).toContain('── grep output ─')
    expect(stripped).toContain('\na\nb\n')
  })

  it('colors diff lines (additions green, removals red, headers cyan)', () => {
    const out = renderToolOutput('edit_file', '@@ -1 +1 @@\n-old\n+new', true)
    expect(ansis.strip(out)).toContain('@@ -1 +1 @@')
    expect(ansis.strip(out)).toContain('-old')
    expect(ansis.strip(out)).toContain('+new')
    expect(out).toContain(ansis.green('+new'))
    expect(out).toContain(ansis.red('-old'))
  })

  // The bug this guards against: --no-color only worked when NO_COLOR was
  // set or output was piped, because renderToolResult/renderToolOutput used
  // to call ansis.* directly, whose own TTY auto-detection ignores
  // config.color entirely. color:false must produce zero ANSI codes,
  // regardless of ansis's own enabled state.
  it('emits no ANSI codes at all when color is false', () => {
    const result = renderToolResult('read_file', true, 0, false)
    expect(result).toBe(ansis.strip(result))
    expect(result).toBe('› read_file: ✓ done (0.0s)')

    const output = renderToolOutput(
      'edit_file',
      '@@ -1 +1 @@\n-old\n+new',
      false,
    )
    expect(output).toBe(ansis.strip(output))
    expect(output).toContain('@@ -1 +1 @@')
    expect(output).toContain('-old')
    expect(output).toContain('+new')
  })
})
