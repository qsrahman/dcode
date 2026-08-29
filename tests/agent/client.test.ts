import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cfg } from '../helpers.ts'

interface CapturedCall {
  params: Record<string, unknown>
  opts: Record<string, unknown>
}

const streamCalls: CapturedCall[] = []
// Events the fake SDK stream will emit for the *next* stream() call; reset
// per test so each test controls exactly what the async iterator yields.
let nextEvents: { type: string; delta?: string }[] = []
let finalResponseValue: unknown = {}

// createClient constructs a real `new OpenAI(...)` internally and calls
// `client.responses.stream(params, opts)`; mock the SDK so we can inspect
// both the request it builds and the streaming contract (event filtering,
// finalResponse) without any network call.
vi.mock('openai', () => {
  class FakeOpenAI {
    responses = {
      stream: (
        params: Record<string, unknown>,
        opts: Record<string, unknown>,
      ) => {
        streamCalls.push({ params, opts })
        const events = nextEvents
        return {
          async *[Symbol.asyncIterator]() {
            for (const e of events) yield e
          },
          finalResponse: async () => finalResponseValue,
        }
      },
    }
  }
  return { default: FakeOpenAI }
})

const { createClient } = await import('../../src/agent/client.ts')

describe('createClient', () => {
  beforeEach(() => {
    streamCalls.length = 0
    nextEvents = []
    finalResponseValue = {}
  })

  function streamOnce(
    config: Parameters<typeof createClient>[0],
    opts?: Parameters<ReturnType<typeof createClient>['stream']>[1],
  ) {
    return createClient(config).stream([{ role: 'user', content: 'hi' }], opts)
  }

  describe('store param', () => {
    // store is always exactly config.stateful, unconditionally — no
    // branching on the configured endpoint. See the comment in client.ts
    // for why an earlier endpoint-guessing branch was removed.
    it('sends store:false (the default) when no baseURL is configured', () => {
      streamOnce(cfg())
      expect(streamCalls[0]!.params.store).toBe(false)
    })

    it('sends store:false against a custom baseURL too (e.g. Ollama)', () => {
      streamOnce(cfg({ baseURL: 'http://localhost:11434/v1' }))
      expect(streamCalls[0]!.params.store).toBe(false)
    })

    it('sends store:true when stateful is enabled, regardless of baseURL', () => {
      streamOnce(cfg({ stateful: true, baseURL: 'http://localhost:11434/v1' }))
      expect(streamCalls[0]!.params.store).toBe(true)
    })

    it('sends store:true when stateful is enabled against real OpenAI', () => {
      streamOnce(cfg({ stateful: true }))
      expect(streamCalls[0]!.params.store).toBe(true)
    })
  })

  describe('max_output_tokens', () => {
    it('defaults to config.maxTokens', () => {
      streamOnce(cfg({ maxTokens: 1234 }))
      expect(streamCalls[0]!.params.max_output_tokens).toBe(1234)
    })

    it('is overridden by opts.maxOutputTokens', () => {
      streamOnce(cfg({ maxTokens: 1234 }), { maxOutputTokens: 99 })
      expect(streamCalls[0]!.params.max_output_tokens).toBe(99)
    })
  })

  describe('tools and instructions', () => {
    it('omits tools/instructions entirely when not provided', () => {
      streamOnce(cfg())
      expect(streamCalls[0]!.params).not.toHaveProperty('tools')
      expect(streamCalls[0]!.params).not.toHaveProperty('instructions')
    })

    it('forwards tools and instructions when provided', () => {
      const tools = [{ type: 'function', name: 'x' }] as never
      streamOnce(cfg(), { tools, instructions: 'be helpful' })
      expect(streamCalls[0]!.params.tools).toBe(tools)
      expect(streamCalls[0]!.params.instructions).toBe('be helpful')
    })
  })

  describe('abort signal', () => {
    it('forwards opts.signal to responses.stream as a request option', () => {
      const ac = new AbortController()
      streamOnce(cfg(), { signal: ac.signal })
      expect(streamCalls[0]!.opts.signal).toBe(ac.signal)
    })

    it('passes signal: undefined when no signal is given', () => {
      streamOnce(cfg())
      expect(streamCalls[0]!.opts.signal).toBeUndefined()
    })
  })

  describe('event stream filtering', () => {
    it('yields only response.output_text.delta events, ignoring others', async () => {
      nextEvents = [
        { type: 'response.created' },
        { type: 'response.output_text.delta', delta: 'Hel' },
        { type: 'response.reasoning_summary_text.delta', delta: 'ignored' },
        { type: 'response.output_text.delta', delta: 'lo' },
        { type: 'response.completed' },
      ]
      const stream = streamOnce(cfg())
      const chunks: string[] = []
      for await (const delta of stream) chunks.push(delta)
      expect(chunks).toEqual(['Hel', 'lo'])
    })

    it('delegates finalResponse to the SDK stream', async () => {
      finalResponseValue = { output_text: 'done', output: [] }
      const stream = streamOnce(cfg())
      // Drain first, matching runTurn's own usage pattern.
      for await (const _ of stream) {
        // no-op
      }
      await expect(stream.finalResponse()).resolves.toEqual({
        output_text: 'done',
        output: [],
      })
    })
  })
})
