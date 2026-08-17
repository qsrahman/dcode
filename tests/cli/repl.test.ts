import { afterEach, describe, expect, it, vi } from 'vitest'
import { appConfigSchema, type AppConfig } from '../../src/config/schema.ts'
import {
  createSession,
  handleLine,
  parseCommand,
  trimHistory,
  startRepl,
  type ReplSession,
} from '../../src/cli/repl.ts'
import { createLogger } from '../../src/util/log.ts'
import type { Client, ResponseInput } from '../../src/agent/client.ts'

function makeSink() {
  const out: string[] = []
  return { sink: { write: (t: string) => void out.push(t) }, out }
}

function makeSession(over: Partial<AppConfig> = {}): ReplSession {
  const config = appConfigSchema.parse(over)
  return createSession(config, createLogger(config))
}

// Mirrors tests/agent/run.test.ts; assignable to Client.
function fakeClient(text: string): Client {
  return {
    async complete() {
      return text
    },
    async *stream() {
      yield text
    },
  }
}

describe('parseCommand', () => {
  it('returns null for plain input', () => {
    expect(parseCommand('hello world')).toBeNull()
  })
  it('parses name and args', () => {
    expect(parseCommand('/model gpt-4')).toEqual({
      name: 'model',
      args: 'gpt-4',
    })
  })
  it('parses a command with no args', () => {
    expect(parseCommand('/help')).toEqual({ name: 'help', args: '' })
  })
})

describe('trimHistory', () => {
  it('keeps the system message plus the last max items', () => {
    const h: ResponseInput = [
      { role: 'system', content: 's' },
      { role: 'user', content: '1' },
      { role: 'assistant', content: '1' },
      { role: 'user', content: '2' },
      { role: 'assistant', content: '2' },
    ]
    trimHistory(h, 2)
    expect(h.length).toBe(3)
    expect(h[0]).toEqual({ role: 'system', content: 's' })
  })
  it('is a no-op when within the cap', () => {
    const h: ResponseInput = [
      { role: 'system', content: 's' },
      { role: 'user', content: '1' },
    ]
    trimHistory(h, 10)
    expect(h.length).toBe(2)
  })
})

describe('handleLine commands', () => {
  it('/version writes the version', async () => {
    const s = makeSession()
    const { sink, out } = makeSink()
    expect(await handleLine(s, '/version', sink)).toBe('ok')
    expect(out.join('')).toContain('dcode v0.1.0')
  })
  it('/help writes the command list', async () => {
    const s = makeSession()
    const { sink, out } = makeSink()
    await handleLine(s, '/help', sink)
    expect(out.join('')).toContain('Slash commands')
  })
  it('/model sets the session model', async () => {
    const s = makeSession()
    const { sink, out } = makeSink()
    expect(await handleLine(s, '/model gpt-x', sink)).toBe('ok')
    expect(s.config.model).toBe('gpt-x')
    expect(out.join('')).toBe('model set to gpt-x\n')
  })
  it('/model with no args prints the current model', async () => {
    const s = makeSession()
    const { sink, out } = makeSink()
    await handleLine(s, '/model', sink)
    expect(out.join('')).toContain('model: gpt-5')
  })
  it('/reset drops the conversation', async () => {
    const s = makeSession()
    s.history.push({ role: 'user', content: 'x' })
    const { sink, out } = makeSink()
    expect(await handleLine(s, '/reset', sink)).toBe('ok')
    expect(s.history.length).toBe(1)
    expect(out.join('')).toBe('session reset\n')
  })
  it('unknown command is reported', async () => {
    const s = makeSession()
    const { sink, out } = makeSink()
    await handleLine(s, '/nope', sink)
    expect(out.join('')).toContain('unknown command')
  })
  it('empty input is a no-op', async () => {
    const s = makeSession()
    const { sink } = makeSink()
    const before = s.history.length
    expect(await handleLine(s, '   ', sink)).toBe('ok')
    expect(s.history.length).toBe(before)
  })
  it('/exit returns the exit signal', async () => {
    const s = makeSession()
    const { sink } = makeSink()
    expect(await handleLine(s, '/exit', sink)).toBe('exit')
  })
})

describe('handleLine prompt turn', () => {
  it('runs a turn, records history, and writes output', async () => {
    const s = makeSession()
    s.client = fakeClient('hi there')
    const { sink, out } = makeSink()
    expect(await handleLine(s, 'hello', sink)).toBe('ok')
    expect(s.history.at(-1)).toEqual({ role: 'assistant', content: 'hi there' })
    expect(out.join('')).toBe('hi there\n')
  })
})

vi.mock('node:readline', () => ({
  createInterface: () => {
    const lines = ['/version', 'hello world', '/exit']
    return {
      [Symbol.asyncIterator]() {
        let i = 0
        return {
          async next() {
            if (i < lines.length) return { value: lines[i++], done: false }
            return { value: undefined, done: true }
          },
        }
      },
      prompt() {},
      close() {},
      on() {
        return this
      },
    }
  },
}))

vi.mock('../../src/agent/client.ts', () => ({
  createClient: () => ({
    async *stream() {
      yield 'streamed'
    },
    async complete() {
      return 'streamed'
    },
  }),
}))

describe('startRepl (smoke, mocked boundaries)', () => {
  it('drives a line sequence and exits on /exit', async () => {
    const write = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true)
    const config = appConfigSchema.parse({})
    await startRepl(config, createLogger(config))
    const out = write.mock.calls.map((c) => c[0]).join('')
    expect(out).toContain('dcode v0.1.0')
    expect(out).toContain('streamed')
    write.mockRestore()
  })
})

afterEach(() => vi.restoreAllMocks())
