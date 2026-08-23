import { describe, expect, it } from 'vitest'
import type {
  Client,
  OpenAIResponse,
  ResponseInput,
} from '../../../src/agent/client.ts'
import type { AppConfig } from '../../../src/config/schema.ts'
import { createLogger } from '../../../src/util/log.ts'
import { compactHistory } from '../../../src/agent/context/compact.ts'
import { cfg } from '../../helpers.ts'

function summaryClient(summary: string): Client {
  return {
    stream() {
      return {
        async *[Symbol.asyncIterator]() {
          yield summary
        },
        finalResponse: async () => ({}) as unknown as OpenAIResponse,
        abort: () => {},
      }
    },
  }
}

describe('compactHistory', () => {
  it('summarizes the oldest history and keeps a recent tail', async () => {
    const config = cfg({
      context: {
        auto: true,
        window: 200000,
        reserved: 20000,
        keepTokens: 1,
        prune: true,
      },
    }) as AppConfig
    const history: ResponseInput = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'first request' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'second request' },
    ]
    const out = await compactHistory(
      summaryClient('SUMMARY'),
      config,
      history,
      createLogger(config),
    )
    expect(out).toHaveLength(3)
    expect(out[0]).toEqual({ role: 'system', content: 'sys' })
    expect((out[1] as { role: string }).role).toBe('developer')
    expect((out[1] as { content: string }).content).toBe('SUMMARY')
    // most recent user message retained verbatim
    expect((out[2] as { content: string }).content).toBe('second request')
  })

  it('returns the history unchanged when there is nothing to summarize', async () => {
    const config = cfg({
      context: {
        auto: true,
        window: 200000,
        reserved: 20000,
        keepTokens: 1,
        prune: true,
      },
    }) as AppConfig
    const history: ResponseInput = [{ role: 'system', content: 'sys' }]
    const out = await compactHistory(
      summaryClient('SUMMARY'),
      config,
      history,
      createLogger(config),
    )
    expect(out).toBe(history)
  })
})
