import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type {
  Client,
  OpenAIResponse,
  ResponseInput,
} from '../../src/agent/client.ts'
import { runAgent } from '../../src/agent/loop.ts'
import type { ToolDefinition } from '../../src/agent/types.ts'
import { ToolRegistry } from '../../src/tools/registry.ts'
import { createLogger } from '../../src/util/log.ts'
import { cfg } from '../helpers.ts'

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
          const output = calls[turn] ?? []
          turn++
          return { output, output_text: text } as unknown as OpenAIResponse
        },
        abort: () => {},
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
    expect(history.at(-1)).toEqual({ role: 'assistant', content: 'turn 0' })
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
          abort: () => {},
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
