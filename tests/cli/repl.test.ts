import { afterEach, describe, expect, it, vi } from 'vitest'
import * as readline from 'node:readline'
import type { AppConfig } from '../../src/config/schema.ts'
import {
  createSession,
  handleLine,
  trimHistory,
  startRepl,
} from '../../src/cli/repl.ts'
import { parseCommand, type Session } from '../../src/cli/commands.ts'
import { createLogger } from '../../src/util/log.ts'
import type { ResponseInput } from '../../src/agent/client.ts'
import { cfg, fakeClient, makeSink } from '../helpers.ts'
import { getVersion } from '../../src/version.ts'

function makeSession(over: Partial<AppConfig> = {}): Session {
  const config = cfg(over)
  return createSession(config, createLogger(config))
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
  it('never orphans a tool pair: cuts at a message boundary', () => {
    const h: ResponseInput = [
      { role: 'system', content: 's' },
      { role: 'user', content: 'u1' },
      { type: 'function_call', call_id: 'a', name: 'x', arguments: '{}' },
      { type: 'function_call_output', call_id: 'a', output: 'ok' },
      { role: 'assistant', content: 'a1' },
    ] as unknown as ResponseInput
    trimHistory(h, 2)
    expect(h[0]).toEqual({ role: 'system', content: 's' })
    // The naive cut would keep the orphaned output (call 'a' dropped); the fixed
    // version advances past both tool items to the next message.
    for (const item of h.slice(1)) {
      expect((item as { type?: string }).type).not.toBe('function_call_output')
      expect((item as { type?: string }).type).not.toBe('function_call')
    }
  })
})

describe('handleLine commands', () => {
  it('/version writes the version', async () => {
    const s = makeSession()
    const { sink, out } = makeSink()
    expect(await handleLine(s, '/version', { sink })).toBe('ok')
    expect(out.join('')).toContain(`dcode v${getVersion()}`)
  })
  it('/help writes the command list', async () => {
    const s = makeSession()
    const { sink, out } = makeSink()
    await handleLine(s, '/help', { sink })
    expect(out.join('')).toContain('Commands')
  })
  it('/model sets the session model', async () => {
    const s = makeSession()
    const { sink, out } = makeSink()
    expect(await handleLine(s, '/model gpt-x', { sink })).toBe('ok')
    expect(s.config.model).toBe('gpt-x')
    expect(out.join('')).toBe('model set to gpt-x\n')
  })
  it('/model with no args prints the current model', async () => {
    const s = makeSession()
    const { sink, out } = makeSink()
    await handleLine(s, '/model', { sink })
    expect(out.join('')).toContain('model: gpt-5')
  })
  it('/reset drops the conversation', async () => {
    const s = makeSession()
    s.history.push({ role: 'user', content: 'x' })
    const { sink, out } = makeSink()
    expect(await handleLine(s, '/reset', { sink })).toBe('ok')
    expect(s.history.length).toBe(1)
    expect(out.join('')).toBe('session reset\n')
  })
  it('unknown command is reported', async () => {
    const s = makeSession()
    const { sink, out } = makeSink()
    await handleLine(s, '/nope', { sink })
    expect(out.join('')).toContain('unknown command')
  })
  it('empty input is a no-op', async () => {
    const s = makeSession()
    const { sink } = makeSink()
    const before = s.history.length
    expect(await handleLine(s, '   ', { sink })).toBe('ok')
    expect(s.history.length).toBe(before)
  })
  it('/exit returns the exit signal', async () => {
    const s = makeSession()
    const { sink } = makeSink()
    expect(await handleLine(s, '/exit', { sink })).toBe('exit')
  })
})

describe('handleLine prompt turn', () => {
  it('runs a turn, records history, and writes output', async () => {
    const s = makeSession()
    s.client = fakeClient('hi there')
    const { sink, out } = makeSink()
    expect(await handleLine(s, 'hello', { sink })).toBe('ok')
    expect(s.history.at(-1)).toEqual({ role: 'assistant', content: 'hi there' })
    expect(out.join('')).toBe('\nhi there\n\n')
  })
})

// Lines are delivered via rl.emit(), never auto-fired from prompt(), so tests
// can type "ahead" while a turn is busy. Instances are reachable through
// __instances (exported from the mocked module to dodge hoisting/TDZ issues).
vi.mock('node:readline', () => {
  const instances: unknown[] = []
  class FakeInterface {
    private listeners: Record<string, ((...a: unknown[]) => void)[]> = {}
    closed = false
    on(event: string, cb: (...a: unknown[]) => void) {
      ;(this.listeners[event] ??= []).push(cb)
      return this
    }
    emit(line: string) {
      this.listeners['line']?.forEach((cb) => cb(line))
    }
    prompt() {}
    close() {
      this.closed = true
      this.listeners['close']?.forEach((cb) => cb())
    }
  }
  return {
    __instances: instances,
    createInterface: () => {
      const it = new FakeInterface()
      instances.push(it)
      return it as never
    },
  }
})

function lastFake(): { emit(line: string): void; closed: boolean } {
  const insts = (
    readline as unknown as {
      __instances: { emit(l: string): void; closed: boolean }[]
    }
  ).__instances
  return insts.at(-1)!
}

vi.mock('../../src/agent/client.ts', () => ({
  createClient: () => ({
    // Echo the newest user message so each turn's output is distinguishable —
    // needed to assert the order in which queued input is drained.
    stream: (input: { role?: string; content?: unknown }[]) => {
      const last = [...(input ?? [])].reverse().find((i) => i.role === 'user')
      const text = typeof last?.content === 'string' ? last.content : ''
      return {
        async *[Symbol.asyncIterator]() {
          yield `echo:${text}`
        },
        finalResponse: async () =>
          ({ output: [], output_text: `echo:${text}` }) as never,
      }
    },
  }),
}))

describe('startRepl (smoke, mocked boundaries)', () => {
  function captured(): string {
    return (writeSpy.mock.calls as unknown as unknown[][])
      .map((c) => String(c[0]))
      .join('')
  }
  let writeSpy: ReturnType<typeof vi.spyOn>

  function start(): Promise<void> {
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const config = cfg()
    return startRepl(config, createLogger(config))
  }

  it('drives a line sequence and exits on /exit', async () => {
    const done = start()
    const rl = lastFake()
    rl.emit('/version')
    rl.emit('say hi')
    rl.emit('/exit')
    await done
    const out = captured()
    expect(out).toContain(`dcode v${getVersion()}`)
    expect(out).toContain('echo:say hi')
  })

  it('buffers lines typed while busy and drains them in order', async () => {
    const done = start()
    const rl = lastFake()
    rl.emit('first')
    // Arrives synchronously while the first turn is still running.
    rl.emit('second')
    await vi.waitFor(() => expect(captured()).toContain('echo:second'))
    rl.emit('/exit')
    await done
    const out = captured()
    expect(out).toContain('echo:first')
    // Both turns ran; dropping the busy line would lose 'echo:second'.
    expect(out.indexOf('echo:first')).toBeLessThan(out.indexOf('echo:second'))
  })

  it('processes a /exit typed while busy and closes the REPL', async () => {
    const done = start()
    const rl = lastFake()
    rl.emit('working')
    rl.emit('/exit')
    await done
    expect(rl.closed).toBe(true)
    expect(captured()).toContain('echo:working')
  })

  it('prints the hint once at startup, not after every turn', async () => {
    const done = start()
    const rl = lastFake()
    rl.emit('one')
    rl.emit('two')
    await vi.waitFor(() => expect(captured()).toContain('echo:two'))
    expect(captured().split('Ask anything').length - 1).toBe(1)
    rl.emit('/exit')
    await done
  })
})

afterEach(() => vi.restoreAllMocks())
