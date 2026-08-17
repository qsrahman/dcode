import { describe, expect, it } from 'vitest'
import { runOneShot } from '../../src/agent/loop.ts'
import { createLogger } from '../../src/util/log.ts'
import { cfg, fakeClient } from '../helpers.ts'

describe('runOneShot', () => {
  it('streams deltas then a trailing newline and returns the joined text', async () => {
    const config = cfg()
    const sink: string[] = []
    const text = await runOneShot(
      fakeClient('hello world', true),
      config,
      'hi',
      {
        write: (t) => {
          sink.push(t)
        },
      },
      createLogger(config),
    )
    expect(text).toBe('hello world')
    expect(sink.join('')).toBe('hello world\n')
  })
})
