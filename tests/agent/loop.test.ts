import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type {
  Client,
  OpenAIResponse,
  ResponseInput,
} from '../../src/agent/client.ts'
import { runAgent } from '../../src/agent/loop.ts'
import type { Tool } from '../../src/agent/types.ts'
import { createLogger } from '../../src/util/log.ts'
import { cfg } from '../helpers.ts'

function fakeClientWithCalls(calls: unknown[][]): Client {
  let turn = 0
  return {
    stream() {
      return {
        async *[Symbol.asyncIterator]() {
          yield `turn ${turn}`
        },
        finalResponse: async () => {
          const output = calls[turn] ?? []
          turn++
          return { output } as unknown as OpenAIResponse
        },
      }
    },
  }
}

const readTool: Tool = {
  name: 'read_file',
  description: 'reads',
  parameters: z.object({}),
  async execute() {
    return 'file contents'
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
      tools: [readTool],
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
            }) as unknown as OpenAIResponse,
        }
      },
    }
    const history: ResponseInput = [{ role: 'user', content: 'go' }]
    await runAgent(client, cfg({ maxToolIterations: 3 }), history, {
      logger: createLogger(cfg()),
      tools: [readTool],
    })
    const outputs = history.filter(
      (h) => (h as { type?: string }).type === 'function_call_output',
    )
    expect(outputs).toHaveLength(3)
  })
})
