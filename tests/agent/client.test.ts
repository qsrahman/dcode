import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cfg } from '../helpers.ts'

const streamCalls: { params: { store?: boolean } }[] = []

// createClient constructs a real `new OpenAI(...)` internally; mock the SDK
// so we can inspect the request params it builds without any network call.
vi.mock('openai', () => {
  class FakeOpenAI {
    responses = {
      stream: (params: { store?: boolean }) => {
        streamCalls.push({ params })
        return {
          async *[Symbol.asyncIterator]() {
            // no deltas
          },
          finalResponse: async () => ({}) as unknown,
        }
      },
    }
  }
  return { default: FakeOpenAI }
})

const { createClient } = await import('../../src/agent/client.ts')

describe('createClient store param', () => {
  beforeEach(() => {
    streamCalls.length = 0
  })

  function streamOnce(config: Parameters<typeof createClient>[0]) {
    createClient(config).stream([{ role: 'user', content: 'hi' }])
    return streamCalls[0]!.params.store
  }

  it('sends store:false against real OpenAI when no baseURL is configured', () => {
    expect(streamOnce(cfg())).toBe(false)
  })

  it('sends store:false when baseURL is explicitly api.openai.com', () => {
    expect(streamOnce(cfg({ baseURL: 'https://api.openai.com/v1' }))).toBe(
      false,
    )
  })

  it('omits store for a non-OpenAI custom baseURL (e.g. Ollama)', () => {
    expect(
      streamOnce(cfg({ baseURL: 'http://localhost:11434/v1' })),
    ).toBeUndefined()
  })

  it('sends store:true when stateful is enabled, regardless of baseURL', () => {
    expect(
      streamOnce(cfg({ stateful: true, baseURL: 'http://localhost:11434/v1' })),
    ).toBe(true)
  })

  it('sends store:true when stateful is enabled against real OpenAI', () => {
    expect(streamOnce(cfg({ stateful: true }))).toBe(true)
  })
})
