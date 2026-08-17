import { describe, expect, it } from 'vitest'
import { runOneShot } from '../../src/agent/run.ts'
import { appConfigSchema, type AppConfig } from '../../src/config/schema.ts'
import type { Client } from '../../src/agent/client.ts'

function cfg(over: Partial<AppConfig> = {}): AppConfig {
  return appConfigSchema.parse(over)
}

function fakeClient(text: string, split = false): Client {
  return {
    async *stream() {
      if (split) {
        yield text.slice(0, 5)
        yield text.slice(5)
      } else {
        yield text
      }
    },
  }
}

describe('runOneShot', () => {
  it('streams deltas then a trailing newline and returns the joined text', async () => {
    const sink: string[] = []
    const text = await runOneShot(
      fakeClient('hello world', true),
      cfg(),
      'hi',
      {
        write: (t) => {
          sink.push(t)
        },
      },
    )
    expect(text).toBe('hello world')
    expect(sink.join('')).toBe('hello world\n')
  })
})
