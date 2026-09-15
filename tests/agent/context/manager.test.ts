import { describe, expect, it } from 'vitest'
import OpenAI from 'openai'
import type {
  Client,
  OpenAIResponse,
  ResponseInput,
} from '../../../src/agent/client.ts'
import { isContextOverflowError } from '../../../src/agent/client.ts'
import { createLogger } from '../../../src/util/log.ts'
import { ContextManager } from '../../../src/agent/context/manager.ts'
import { TaskStore } from '../../../src/agent/todo-store.ts'
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

  // The status/code/message-regex checks are three independent branches —
  // each covered here in isolation (a plain 413 with neither a matching
  // code nor message is covered by the test above).
  it('detects via error.code alone, without a 413 status', () => {
    const err = new OpenAI.APIError(
      400,
      { code: 'context_length_exceeded', message: 'nope' },
      'nope',
      undefined,
    )
    expect(isContextOverflowError(err)).toBe(true)
  })

  it('detects via a message-regex match alone, without 413 or a matching code', () => {
    const err = new OpenAI.APIError(
      400,
      { message: 'token limit reached for this request' },
      'token limit reached for this request',
      undefined,
    )
    expect(isContextOverflowError(err)).toBe(true)
  })

  it('is false for an APIError that matches none of the three signals', () => {
    const err = new OpenAI.APIError(
      429,
      { code: 'rate_limit_exceeded', message: 'slow down' },
      'slow down',
      undefined,
    )
    expect(isContextOverflowError(err)).toBe(false)
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
    const config = {
      ...cfg(),
      context: {
        auto: true,
        window: 50,
        reserved: 0,
        keepTokens: 49,
        prune: true,
        compactAt: 0.85,
      },
    }
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
    const config = {
      ...cfg(),
      context: {
        auto: true,
        window: 10,
        reserved: 0,
        keepTokens: 1,
        prune: true,
        compactAt: 0.85,
      },
    }
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
    const config = {
      ...cfg(),
      context: {
        auto: true,
        window: 10,
        reserved: 0,
        keepTokens: 1,
        prune: true,
        compactAt: 0.85,
      },
    }
    const { client, calls } = summaryClient('y'.repeat(1000))
    const m = new ContextManager(config.context, createLogger(config))
    const history = bigHistory()
    expect(await m.onOverflow(client, config, history)).toBe(true)
    expect(await m.onOverflow(client, config, history)).toBe(true)
    expect(await m.onOverflow(client, config, history)).toBe(true)
    expect(await m.onOverflow(client, config, history)).toBe(false)
    expect(calls()).toBe(3)
  })

  // Regression: onOverflow used to go straight to compaction — a full,
  // paid extra model call — even when a free, local prune would have
  // recovered enough space on its own. Matters most right after beforeTurn
  // already compacted this same turn proactively, only for the request to
  // still overflow.
  it('onOverflow prunes before compacting, skipping an unnecessary paid model call', async () => {
    const config = {
      ...cfg(),
      context: {
        auto: true,
        window: 10000,
        reserved: 0,
        keepTokens: 100,
        prune: true,
        compactAt: 0.85,
      },
    }
    const { client, calls } = summaryClient('SUMMARY')
    const m = new ContextManager(config.context, createLogger(config))
    // Three separate tool-call turns; default protectTurns (2) protects the
    // last two, leaving the first (large) output prunable.
    const history: ResponseInput = [
      { role: 'user', content: 'q1' },
      { type: 'function_call', call_id: 'c1', name: 'read', arguments: '{}' },
      {
        type: 'function_call_output',
        call_id: 'c1',
        output: 'y'.repeat(2000),
      },
      { role: 'user', content: 'q2' },
      { type: 'function_call', call_id: 'c2', name: 'read', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c2', output: 'z'.repeat(50) },
      { role: 'user', content: 'q3' },
      { type: 'function_call', call_id: 'c3', name: 'read', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c3', output: 'w'.repeat(50) },
    ]
    const recovered = await m.onOverflow(client, config, history)
    expect(recovered).toBe(true)
    expect(calls()).toBe(0) // no compaction call — pruning alone was enough
    const c1Output = history.find(
      (i) =>
        (i as { type?: string; call_id?: string }).type ===
          'function_call_output' &&
        (i as { call_id?: string }).call_id === 'c1',
    ) as { output: string }
    expect(c1Output.output).toMatch(/\[output truncated\]/)
  })

  it('manual /compact does not count toward the automatic circuit breaker', async () => {
    const config = {
      ...cfg(),
      context: {
        auto: true,
        window: 10,
        reserved: 0,
        keepTokens: 1,
        prune: true,
        compactAt: 0.85,
      },
    }
    // huge "summary" so the window is never recovered
    const { client } = summaryClient('y'.repeat(1000))
    const m = new ContextManager(config.context, createLogger(config))
    const history = bigHistory()
    // Three manual compactions (e.g. the user repeatedly running /compact)
    // must not trip the breaker that guards *automatic* compaction.
    await m.manual(client, config, history)
    await m.manual(client, config, history)
    await m.manual(client, config, history)
    expect(await m.beforeTurn(client, config, bigHistory())).toBe('compacted')
  })

  it('beforeTurn reports none, not compacted, when there is nothing to summarize', async () => {
    // keepTokens covers the whole (small) history, but compactAt is low
    // enough that predict() still crosses the soft threshold — beforeTurn
    // attempts compaction, but compactHistory has nothing to summarize.
    const config = {
      ...cfg(),
      context: {
        auto: true,
        window: 1000,
        reserved: 0,
        keepTokens: 500,
        prune: true,
        compactAt: 0.01,
      },
    }
    const { client, calls } = summaryClient('SUMMARY')
    const m = new ContextManager(config.context, createLogger(config))
    const action = await m.beforeTurn(client, config, bigHistory())
    expect(action).toBe('none')
    expect(calls()).toBe(0) // no wasted summarization call
  })

  it('a no-op compaction does not count toward the circuit breaker', async () => {
    const config = {
      ...cfg(),
      context: {
        auto: true,
        window: 1000,
        reserved: 0,
        keepTokens: 500,
        prune: true,
        compactAt: 0.01,
      },
    }
    const { client } = summaryClient('SUMMARY')
    const m = new ContextManager(config.context, createLogger(config))
    const actions: string[] = []
    for (let i = 0; i < 5; i++) {
      actions.push(await m.beforeTurn(client, config, bigHistory()))
    }
    // Every call is a no-op (never 'compacted'), and none of them trip the
    // breaker — a later real compaction must still be able to proceed.
    expect(actions).toEqual(['none', 'none', 'none', 'none', 'none'])
  })

  it('onOverflow returns false, not true, when compaction is a no-op', async () => {
    const config = {
      ...cfg(),
      context: {
        auto: true,
        window: 1000,
        reserved: 0,
        keepTokens: 500,
        prune: true,
        compactAt: 0.01,
      },
    }
    const { client } = summaryClient('SUMMARY')
    const m = new ContextManager(config.context, createLogger(config))
    const history = bigHistory()
    // Retrying after a no-op compaction would just overflow identically, so
    // this must not tell the loop to retry.
    expect(await m.onOverflow(client, config, history)).toBe(false)
    expect(await m.onOverflow(client, config, history)).toBe(false)
  })

  it('includes the task list in the compaction instruction when a store is set', async () => {
    const config = {
      ...cfg(),
      context: {
        auto: true,
        window: 50,
        reserved: 0,
        keepTokens: 1,
        prune: true,
        compactAt: 0.85,
      },
    }
    const { client, lastInput } = summaryClient('SUMMARY')
    const store = new TaskStore()
    store.replace([
      { content: 'write tests', status: 'pending', priority: 'medium' },
    ])
    const m = new ContextManager(config.context, createLogger(config), store)
    const action = await m.beforeTurn(client, config, bigHistory())
    expect(action).toBe('compacted')
    const instruction = (lastInput()[0] as { content: string }).content
    expect(instruction).toContain('Authoritative task list')
    expect(instruction).toContain('[pending] [medium] write tests')
  })

  it('compacts proactively at the soft threshold, before the hard limit', async () => {
    const config = {
      ...cfg(),
      context: {
        auto: true,
        window: 10000,
        reserved: 0,
        keepTokens: 10,
        prune: true,
        compactAt: 0.2,
      },
    }
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
