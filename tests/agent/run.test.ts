import { describe, expect, it } from 'vitest'
import { stripVTControlCharacters } from 'node:util'
import { runTurn } from '../../src/agent/run.ts'
import { runOneShot } from '../../src/agent/loop.ts'
import { createLogger } from '../../src/util/log.ts'
import type { Client, OpenAIResponse } from '../../src/agent/client.ts'
import { cfg, fakeClient, messageItem, makeSink } from '../helpers.ts'

describe('runOneShot', () => {
  it('streams deltas then a trailing newline and returns the joined text', async () => {
    const config = cfg()
    const sink: string[] = []
    const text = await runOneShot(
      fakeClient('hello world', true),
      config,
      'hi',
      {
        sink: {
          write: (t) => {
            sink.push(t)
          },
        },
        logger: createLogger(config),
      },
    )
    expect(text).toBe('hello world')
    // The streamed output is rendered as markdown (stripVTControlCharacters since plain
    // text has no styling to apply, but MarkdownStreamRenderer still wraps
    // it in marked-terminal's own reset codes).
    expect(stripVTControlCharacters(sink.join(''))).toBe('hello world\n')
  })
})

describe('runTurn', () => {
  // The real OpenAI SDK's EventStream expects the stream to be fully
  // consumed before finalResponse() is called (it otherwise has to wait for
  // completion itself) — the documented, standard usage pattern. This can't
  // be verified against the real SDK without a network call, but it can pin
  // down that *our own code* honors that ordering: a fake Client whose
  // finalResponse() throws unless the async iterator was fully drained
  // first catches a regression where runTurn called it too early (e.g. a
  // reordering, or an early return that skips the `for await`).
  it('fully drains the delta stream before calling finalResponse', async () => {
    let drained = false
    const client: Client = {
      stream() {
        return {
          async *[Symbol.asyncIterator]() {
            yield 'part one '
            yield 'part two'
            drained = true
          },
          finalResponse: async () => {
            if (!drained) {
              throw new Error(
                'finalResponse() called before the stream was fully drained',
              )
            }
            return {
              output_text: 'part one part two',
              output: [messageItem('part one part two')],
            } as unknown as OpenAIResponse
          },
        }
      },
    }
    const { sink } = makeSink()
    const config = cfg()
    const result = await runTurn(client, config, [], {
      sink,
      logger: createLogger(config),
    })
    expect(result.text).toBe('part one part two')
  })
})
