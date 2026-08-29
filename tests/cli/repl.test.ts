import { afterEach, describe, expect, it, vi } from 'vitest'
import * as readline from 'node:readline/promises'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Config } from '../../src/config/schema.ts'
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

function makeSession(over: Partial<Config> = {}): Session {
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
  it('lower-cases the command name but preserves args case', () => {
    expect(parseCommand('/Key Set OpenAI SK-123')).toEqual({
      name: 'key',
      args: 'Set OpenAI SK-123',
    })
  })
})

describe('trimHistory', () => {
  it('keeps item 0 plus the last max items', () => {
    const h: ResponseInput = [
      { role: 'user', content: '1' },
      { role: 'assistant', content: '1' },
      { role: 'user', content: '2' },
      { role: 'assistant', content: '2' },
    ]
    trimHistory(h, 2)
    // Item 0 is protected (see below), so this keeps 1 + max = 3 items.
    expect(h.length).toBe(3)
    expect(h[0]).toEqual({ role: 'user', content: '1' })
    expect(h[1]).toEqual({ role: 'user', content: '2' })
    expect(h[2]).toEqual({ role: 'assistant', content: '2' })
  })
  it('is a no-op when within the cap', () => {
    const h: ResponseInput = [
      { role: 'user', content: '1' },
      { role: 'assistant', content: '1' },
    ]
    trimHistory(h, 10)
    expect(h.length).toBe(2)
  })
  it('never orphans a tool pair: cuts at a message boundary', () => {
    const h: ResponseInput = [
      { role: 'user', content: 'u1' },
      { type: 'function_call', call_id: 'a', name: 'x', arguments: '{}' },
      { type: 'function_call_output', call_id: 'a', output: 'ok' },
      { role: 'assistant', content: 'a1' },
    ] as unknown as ResponseInput
    trimHistory(h, 2)
    // The naive cut would keep the orphaned output (call 'a' dropped); the fixed
    // version advances past both tool items to the next message.
    for (const item of h) {
      expect((item as { type?: string }).type).not.toBe('function_call_output')
      expect((item as { type?: string }).type).not.toBe('function_call')
    }
  })

  // Regression: a naive front-cut is blind to what's at index 0. After a
  // compaction (auto or /compact), history is `[summary, ...tail]` — the
  // summary is the model's only record of everything before it. Trimming
  // from index 0 like every other item, once the session runs long enough
  // to hit the item-count cap again, would silently erase it.
  it('never discards item 0, even when it is a compaction summary', () => {
    const h: ResponseInput = [
      { role: 'user', content: 'SUMMARY of everything before this point' },
      ...Array.from({ length: 10 }, (_, i) => ({
        role: 'user' as const,
        content: `msg ${i}`,
      })),
    ]
    trimHistory(h, 3)
    expect(h[0]).toEqual({
      role: 'user',
      content: 'SUMMARY of everything before this point',
    })
    // Everything else is still capped to roughly `max`, just measured from
    // index 1 instead of index 0.
    expect(h.length).toBeLessThanOrEqual(4)
  })

  it('is still a no-op when only item 0 exists', () => {
    const h: ResponseInput = [{ role: 'user', content: 'only' }]
    trimHistory(h, 0)
    expect(h).toEqual([{ role: 'user', content: 'only' }])
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
    expect(s.history.length).toBe(0)
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

describe('handleLine new commands', () => {
  it('/tasks lists in-session tasks', async () => {
    const s = makeSession()
    s.tasks.create('write tests')
    s.tasks.create('update docs', ['T1'])
    const { sink, out } = makeSink()
    expect(await handleLine(s, '/tasks', { sink })).toBe('ok')
    const text = out.join('')
    expect(text).toContain('T1 [pending] write tests')
    expect(text).toContain('(blocked by T1)')
  })
  it('/tasks reports when empty', async () => {
    const s = makeSession()
    const { sink, out } = makeSink()
    await handleLine(s, '/tasks', { sink })
    expect(out.join('')).toBe('no tasks\n')
  })
  it('/todo lists in-session tasks (alias of /tasks)', async () => {
    const s = makeSession()
    s.tasks.create('write tests')
    const { sink, out } = makeSink()
    expect(await handleLine(s, '/todo', { sink })).toBe('ok')
    expect(out.join('')).toContain('T1 [pending] write tests')
  })
  it('/config prints effective configuration', async () => {
    const s = makeSession()
    const { sink, out } = makeSink()
    await handleLine(s, '/config', { sink })
    const text = out.join('')
    expect(text).toContain(`model:        ${s.config.model}`)
    expect(text).toContain('context:')
  })
  it('/undo removes the last exchange', async () => {
    const s = makeSession()
    s.history.push({ role: 'user', content: 'first' })
    s.history.push({ role: 'assistant', content: 'a1' })
    s.history.push({ role: 'user', content: 'second' })
    s.history.push({ role: 'assistant', content: 'a2' })
    const { sink } = makeSink()
    expect(await handleLine(s, '/undo', { sink })).toBe('ok')
    expect(s.history.map((h) => (h as { content?: string }).content)).toEqual([
      'first',
      'a1',
    ])
  })
  it('/undo is a no-op on empty history', async () => {
    const s = makeSession()
    const { sink, out } = makeSink()
    await handleLine(s, '/undo', { sink })
    expect(out.join('')).toBe('nothing to undo\n')
    expect(s.history.length).toBe(0)
  })
  it('/verbose toggles and accepts on/off', async () => {
    const s = makeSession()
    s.config.verbose = false
    const { sink, out } = makeSink()
    await handleLine(s, '/verbose', { sink })
    expect(s.config.verbose).toBe(true)
    expect(out.join('')).toContain('verbose: on')
    await handleLine(s, '/verbose off', { sink })
    expect(s.config.verbose).toBe(false)
    expect(out.join('')).toContain('verbose: off')
  })
})

describe('handleLine prompt turn', () => {
  it('runs a turn, records history, and writes output', async () => {
    const s = makeSession()
    s.client = fakeClient('hi there')
    const { sink, out } = makeSink()
    expect(await handleLine(s, 'hello', { sink })).toBe('ok')
    // The assistant turn is now the SDK's own `message` output item (via
    // toResponseInputItems), not a hand-reconstructed {role, content} pair.
    const last = s.history.at(-1) as { type?: string; role?: string }
    expect(last.type).toBe('message')
    expect(last.role).toBe('assistant')
    expect(out.join('')).toBe('\nhi there\n\n')
  })
})

// Lines are delivered via rl.emit(), never auto-fired from prompt(), so tests
// can type "ahead" while a turn is busy. Instances are reachable through
// __instances (exported from the mocked module to dodge hoisting/TDZ issues).
vi.mock('node:readline/promises', () => {
  const instances: unknown[] = []
  class FakeInterface {
    private listeners: Record<string, ((...a: unknown[]) => void)[]> = {}
    private queue: string[] = []
    private waiters: Array<() => void> = []
    closed = false
    setPrompt() {}
    on(event: string, cb: (...a: unknown[]) => void) {
      ;(this.listeners[event] ??= []).push(cb)
      return this
    }
    emit(line: string) {
      if (line === 'SIGINT') {
        this.listeners['SIGINT']?.forEach((cb) => cb())
        return
      }
      this.queue.push(line)
      this.waiters.shift()?.()
      this.listeners['line']?.forEach((cb) => cb(line))
    }
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (this.closed && this.queue.length === 0) break
        if (this.queue.length > 0) {
          yield this.queue.shift()!
          continue
        }
        await new Promise<void>((resolve) => this.waiters.push(resolve))
      }
    }
    prompt() {}
    close() {
      this.closed = true
      this.listeners['close']?.forEach((cb) => cb())
      this.waiters.shift()?.()
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

describe('REPL commands /save and /limit', () => {
  let dir: string | undefined
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = undefined
  })

  it('/limit sets maxToolIterations at runtime', async () => {
    const s = makeSession()
    const { sink, out } = makeSink()
    expect(await handleLine(s, '/limit 5', { sink })).toBe('ok')
    expect(s.config.maxToolIterations).toBe(5)
    expect(out.join('')).toContain('maxToolIterations set to 5')
  })

  it('/limit rejects non-positive input', async () => {
    const s = makeSession()
    const { sink, out } = makeSink()
    await handleLine(s, '/limit abc', { sink })
    await handleLine(s, '/limit 0', { sink })
    expect(out.join('')).toContain('usage: /limit')
  })

  it('/model rebuilds the client so the new model takes effect', async () => {
    const s = makeSession()
    const before = s.client
    const { sink } = makeSink()
    await handleLine(s, '/model gpt-4o', { sink })
    expect(s.config.model).toBe('gpt-4o')
    expect(s.client).not.toBe(before)
  })

  it('/save writes a JSON transcript and refuses to overwrite', async () => {
    dir = mkdtempSync(join(tmpdir(), 'dcode-save-'))
    const s = makeSession({ root: dir })
    s.history.push({ role: 'user', content: 'hi' })
    const { sink, out } = makeSink()
    expect(await handleLine(s, '/save', { sink })).toBe('ok')
    const target = join(dir, 'dcode-transcript.json')
    expect(existsSync(target)).toBe(true)
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual(s.history)
    await handleLine(s, '/save', { sink })
    expect(out.join('')).toContain('refusing to overwrite')
  })

  it('/save writes Markdown when the path ends in .md', async () => {
    dir = mkdtempSync(join(tmpdir(), 'dcode-save-'))
    const s = makeSession({ root: dir })
    s.history.push({ role: 'user', content: 'hi' })
    const { sink } = makeSink()
    await handleLine(s, '/save notes.md', { sink })
    const md = readFileSync(join(dir, 'notes.md'), 'utf8')
    expect(md).toContain('## user')
    expect(md).toContain('hi')
  })

  it('/save creates parent directories for a nested path', async () => {
    dir = mkdtempSync(join(tmpdir(), 'dcode-save-'))
    const s = makeSession({ root: dir })
    s.history.push({ role: 'user', content: 'hi' })
    const { sink } = makeSink()
    await handleLine(s, '/save sub/notes.json', { sink })
    expect(existsSync(join(dir, 'sub', 'notes.json'))).toBe(true)
  })

  it('a throwing command handler does not crash the REPL', async () => {
    dir = mkdtempSync(join(tmpdir(), 'dcode-save-'))
    const s = makeSession({ root: dir })
    // Plant a file where the parent dir should go so mkdirSync fails, exercising
    // the dispatch error guard in handleLine.
    writeFileSync(join(dir, 'blocker'), 'x')
    const { sink } = makeSink()
    await expect(
      handleLine(s, '/save blocker/notes.json', { sink }),
    ).resolves.toBe('ok')
  })
})

afterEach(() => vi.restoreAllMocks())
