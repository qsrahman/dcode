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
import { TaskStore } from '../../../src/agent/tasks.ts'
import { cfg } from '../../helpers.ts'

function summaryClient(summary: string): {
  client: Client
  calls: () => number
  lastInput: () => ResponseInput
} {
  let n = 0
  let last: ResponseInput = []
  const client: Client = {
    stream(input: ResponseInput) {
      n++
      last = input
      return {
        async *[Symbol.asyncIterator]() {
          yield summary
        },
        finalResponse: async () => ({}) as unknown as OpenAIResponse,
      }
    },
  }
  return { client, calls: () => n, lastInput: () => last }
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
      {
        auto: true,
        window: 100,
        reserved: 20,
        keepTokens: 50,
        prune: true,
        compactAt: 0.85,
      },
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
        compactAt: 0.85,
      },
    }) as Config
    const { client } = summaryClient('SUMMARY')
    const m = new ContextManager(config.context, createLogger(config))
    const history = bigHistory()
    const action = await m.beforeTurn(client, config, history)
    expect(action).toBe('compacted')
    // Summary (first item) + tail (last user message). The system prompt is no
    // longer part of history — it's carried via `instructions`.
    expect((history[0] as { role: string }).role).toBe('user')
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
        compactAt: 0.85,
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
        compactAt: 0.85,
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

  it('includes the task list in the compaction instruction when a store is set', async () => {
    const config = cfg({
      context: {
        auto: true,
        window: 50,
        reserved: 0,
        keepTokens: 1,
        prune: true,
        compactAt: 0.85,
      },
    }) as Config
    const { client, lastInput } = summaryClient('SUMMARY')
    const store = new TaskStore()
    store.create('write tests')
    const m = new ContextManager(config.context, createLogger(config), store)
    const action = await m.beforeTurn(client, config, bigHistory())
    expect(action).toBe('compacted')
    const instruction = (lastInput()[0] as { content: string }).content
    expect(instruction).toContain('Authoritative task list')
    expect(instruction).toContain('[pending] T1 write tests')
  })

  it('compacts proactively at the soft threshold, before the hard limit', async () => {
    const config = cfg({
      context: {
        auto: true,
        window: 10000,
        reserved: 0,
        keepTokens: 10,
        prune: true,
        compactAt: 0.2,
      },
    }) as Config
    const { client } = summaryClient('SUMMARY')
    const m = new ContextManager(config.context, createLogger(config))
    // ~2500 estimated tokens: above the 0.2*10000 = 2000 soft threshold, but well
    // below the 10000 hard limit — the old hard-only trigger would have skipped it.
    const history: ResponseInput = [
      { role: 'user', content: 'x'.repeat(5000) },
      { role: 'user', content: 'x'.repeat(5000) },
    ]
    expect(await m.beforeTurn(client, config, history)).toBe('compacted')
  })
})
