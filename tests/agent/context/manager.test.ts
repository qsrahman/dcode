import { describe, expect, it } from 'vitest'
import OpenAI from 'openai'
import type {
  Client,
  OpenAIResponse,
  ResponseInput,
} from '../../../src/agent/client.ts'
import { isContextOverflowError } from '../../../src/agent/client.ts'
import type { Config } from '../../../src/config/schema.ts'
import { createLogger } from '../../../src/util/log.ts'
import { ContextManager } from '../../../src/agent/context/manager.ts'
import { cfg } from '../../helpers.ts'

function summaryClient(summary: string): {
  client: Client
  calls: () => number
} {
  let n = 0
  const client: Client = {
    stream() {
      n++
      return {
        async *[Symbol.asyncIterator]() {
          yield summary
        },
        finalResponse: async () => ({}) as unknown as OpenAIResponse,
        abort: () => {},
      }
    },
  }
  return { client, calls: () => n }
}

function bigHistory(): ResponseInput {
  return [
    { role: 'user', content: 'first request' },
    { role: 'assistant', content: 'first response' },
    { role: 'user', content: 'x'.repeat(1000) },
  ]
}

describe('isContextOverflowError', () => {
  it('detects OpenAI 413 / context_length errors', () => {
    const err = new OpenAI.APIError(
      413,
      { message: 'maximum context length exceeded' },
      'maximum context length exceeded',
      undefined,
    )
    expect(isContextOverflowError(err)).toBe(true)
  })
  it('ignores ordinary errors', () => {
    expect(isContextOverflowError(new Error('boom'))).toBe(false)
  })
})

describe('ContextManager', () => {
  it('reports usable budget and calibrates against real usage', () => {
    const m = new ContextManager(
      { auto: true, window: 100, reserved: 20, keepTokens: 50, prune: true },
      createLogger(cfg()),
    )
    expect(m.usable()).toBe(80)
    const history = bigHistory()
    m.observe({ input_tokens: 4 }, history)
    // real usage (4) recalibrates the heuristic estimate down to ~4
    expect(m.predict(history)).toBe(4)
  })

  it('compacts when over budget and prune is insufficient', async () => {
    const config = cfg({
      context: {
        auto: true,
        window: 50,
        reserved: 0,
        keepTokens: 49,
        prune: true,
      },
    }) as Config
    const { client } = summaryClient('SUMMARY')
    const m = new ContextManager(config.context, createLogger(config))
    const history = bigHistory()
    const action = await m.beforeTurn(client, config, history)
    expect(action).toBe('compacted')
    // Summary (first item) + tail (last user message). The system prompt is no
    // longer part of history — it's carried via `instructions`.
    expect((history[0] as { role: string }).role).toBe('developer')
    expect((history[0] as { content: string }).content).toBe('SUMMARY')
    expect((history[1] as { content: string }).content).toBe('x'.repeat(1000))
  })

  it('trips the circuit breaker after repeated failed compactions', async () => {
    const config = cfg({
      context: {
        auto: true,
        window: 10,
        reserved: 0,
        keepTokens: 1,
        prune: true,
      },
    }) as Config
    // huge "summary" so the window is never recovered
    const { client, calls } = summaryClient('y'.repeat(1000))
    const m = new ContextManager(config.context, createLogger(config))
    const actions: string[] = []
    for (let i = 0; i < 4; i++) {
      actions.push(await m.beforeTurn(client, config, bigHistory()))
    }
    expect(actions).toEqual(['compacted', 'compacted', 'compacted', 'none'])
    expect(calls()).toBe(3)
  })

  it('onOverflow compacts then gives up once the breaker is tripped', async () => {
    const config = cfg({
      context: {
        auto: true,
        window: 10,
        reserved: 0,
        keepTokens: 1,
        prune: true,
      },
    }) as Config
    const { client, calls } = summaryClient('y'.repeat(1000))
    const m = new ContextManager(config.context, createLogger(config))
    const history = bigHistory()
    expect(await m.onOverflow(client, config, history)).toBe(true)
    expect(await m.onOverflow(client, config, history)).toBe(true)
    expect(await m.onOverflow(client, config, history)).toBe(true)
    expect(await m.onOverflow(client, config, history)).toBe(false)
    expect(calls()).toBe(3)
  })
})
