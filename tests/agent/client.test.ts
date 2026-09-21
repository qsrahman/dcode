import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cfg } from '../helpers.ts'

interface CapturedCall {
  params: Record<string, unknown>
  opts: Record<string, unknown>
}

const streamCalls: CapturedCall[] = []
// Events the fake SDK stream will emit for the *next* stream() call; reset
// per test so each test controls exactly what the async iterator yields.
let nextEvents: { type: string; delta?: string; item?: unknown }[] = []
let finalResponseValue: unknown = {}
const constructed: {
  apiKey?: string
  baseURL?: string
  maxRetries?: number
}[] = []
let nextStreamError: Error | undefined
let nextFinalError: Error | undefined

// createClient constructs a real `new OpenAI(...)` internally and calls
// `client.responses.stream(params, opts)`; mock the SDK so we can inspect
// both the request it builds and the streaming contract (event filtering,
// finalResponse) without any network call.
vi.mock('openai', () => {
  class FakeOpenAI {
    constructor(opts: {
      apiKey?: string
      baseURL?: string
      maxRetries?: number
    }) {
      constructed.push(opts)
    }
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
            if (nextStreamError) throw nextStreamError
          },
          finalResponse: async () => {
            if (nextFinalError) throw nextFinalError
            return finalResponseValue
          },
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
    constructed.length = 0
    nextEvents = []
    finalResponseValue = {}
    nextStreamError = undefined
    nextFinalError = undefined
  })

  function streamOnce(
    config: Parameters<typeof createClient>[0],
    opts?: Parameters<ReturnType<typeof createClient>['stream']>[1],
  ) {
    return createClient(config).stream([{ role: 'user', content: 'hi' }], opts)
  }

  // `/key` mutates the shared config mid-session; the SDK instance fixes these
  // in at construction, so the client has to notice and rebuild it.
  describe('SDK instance follows the shared config', () => {
    it('constructs once and reuses the instance while settings are unchanged', () => {
      const client = createClient(cfg({ apiKey: 'a' }))
      client.stream([{ role: 'user', content: 'hi' }])
      client.stream([{ role: 'user', content: 'hi' }])
      expect(constructed).toHaveLength(1)
    })

    it('constructs eagerly, so a missing key fails at startup not first prompt', () => {
      createClient(cfg({ apiKey: 'a' }))
      expect(constructed).toHaveLength(1)
    })

    it.each([
      ['apiKey', { apiKey: 'b' }],
      ['baseURL', { baseURL: 'http://localhost:11434/v1' }],
      ['maxRetries', { maxRetries: 7 }],
    ])(
      'rebuilds the instance when %s changes on the config',
      (_name, change) => {
        const config = cfg({ apiKey: 'a' })
        const client = createClient(config)
        client.stream([{ role: 'user', content: 'hi' }])
        Object.assign(config, change)
        client.stream([{ role: 'user', content: 'hi' }])
        expect(constructed).toHaveLength(2)
        expect(constructed[1]).toMatchObject(change)
      },
    )

    it('a Client created earlier sees a key removed and re-added', () => {
      const config = cfg({ apiKey: 'a' })
      const client = createClient(config)
      delete config.apiKey
      config.apiKey = 'c'
      client.stream([{ role: 'user', content: 'hi' }])
      expect(constructed.at(-1)?.apiKey).toBe('c')
    })
  })

  describe('reasoning and verbosity params', () => {
    it('omits both by default so endpoints that reject them are unaffected', () => {
      streamOnce(cfg(), {})
      expect(streamCalls[0]!.params).not.toHaveProperty('reasoning')
      expect(streamCalls[0]!.params).not.toHaveProperty('text')
    })

    it('sends reasoning.effort and text.verbosity when requested', () => {
      streamOnce(cfg(), { reasoningEffort: 'low', verbosity: 'high' })
      expect(streamCalls[0]!.params.reasoning).toEqual({ effort: 'low' })
      expect(streamCalls[0]!.params.text).toEqual({ verbosity: 'high' })
    })
  })

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

    it('reports reasoning and tool-call starts through onActivity without yielding them', async () => {
      nextEvents = [
        { type: 'response.output_item.added', item: { type: 'reasoning' } },
        {
          type: 'response.output_item.added',
          item: { type: 'function_call', name: 'read_file' },
        },
        { type: 'response.output_item.added', item: { type: 'message' } },
        { type: 'response.output_text.delta', delta: 'hi' },
      ]
      const seen: unknown[] = []
      const stream = streamOnce(cfg(), { onActivity: (a) => seen.push(a) })
      const chunks: string[] = []
      for await (const delta of stream) chunks.push(delta)
      expect(chunks).toEqual(['hi'])
      expect(seen).toEqual([
        { kind: 'reasoning' },
        { kind: 'tool_call', name: 'read_file' },
      ])
    })

    it('works without an onActivity callback', async () => {
      nextEvents = [
        { type: 'response.output_item.added', item: { type: 'reasoning' } },
      ]
      for await (const _ of streamOnce(cfg())) {
        // no-op
      }
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
  describe('non-conformant endpoint errors', () => {
    it('explains SDK stream-shape errors and keeps the original as the cause', async () => {
      const original = new Error('missing content at index 0')
      nextStreamError = original
      const stream = streamOnce(
        cfg({ baseURL: 'http://localhost:11434/v1', model: 'some-model' }),
      )
      const err = await (async () => {
        try {
          for await (const _ of stream) {
            // drain
          }
        } catch (e) {
          return e as Error
        }
      })()
      expect(err?.message).toContain('missing content at index 0')
      expect(err?.message).toContain('http://localhost:11434/v1')
      expect(err?.message).toContain('some-model')
      expect(err?.message).toContain('Try a different model or endpoint')
      expect(err?.cause).toBe(original)
    })

    it('explains the same errors when they surface from finalResponse', async () => {
      nextFinalError = new Error('stream ended without producing a Response')
      const stream = streamOnce(cfg())
      for await (const _ of stream) {
        // drain
      }
      await expect(stream.finalResponse()).rejects.toThrow(
        /stream ended without producing a Response.*Try a different model/s,
      )
    })

    it('passes unrelated errors through untouched', async () => {
      const original = new Error('Connection error.')
      nextStreamError = original
      const stream = streamOnce(cfg())
      await expect(
        (async () => {
          for await (const _ of stream) {
            // drain
          }
        })(),
      ).rejects.toBe(original)
    })
  })
})
