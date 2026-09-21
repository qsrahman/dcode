import { afterEach, describe, expect, it, vi } from 'vitest'
import { stripVTControlCharacters } from 'node:util'
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
import type { Client } from '../../src/agent/client.ts'
import { CONTINUE_PROMPT } from '../../src/agent/types.ts'
import {
  createSession,
  formatStatusLine,
  handleLine,
  startRepl,
} from '../../src/cli/repl.ts'
import { parseCommand, type Session } from '../../src/cli/commands.ts'
import { createLogger } from '../../src/util/log.ts'
import { cfg, fakeClient, makeSink } from '../helpers.ts'
import { getVersion } from '../../src/util/version.ts'

function makeSession(over: Partial<Config> = {}): Promise<Session> {
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

describe('handleLine commands', () => {
  it('/version writes the version', async () => {
    const s = await makeSession()
    const { sink, out } = makeSink()
    expect(await handleLine(s, '/version', { sink })).toBe('ok')
    expect(out.join('')).toContain(`dcode v${getVersion()}`)
  })
  it('/help writes the command list', async () => {
    const s = await makeSession()
    const { sink, out } = makeSink()
    await handleLine(s, '/help', { sink })
    expect(out.join('')).toContain('Commands')
  })
  it('/model sets the session model', async () => {
    const s = await makeSession()
    const { sink, out } = makeSink()
    expect(await handleLine(s, '/model gpt-x', { sink })).toBe('ok')
    expect(s.config.model).toBe('gpt-x')
    expect(out.join('')).toBe('model set to gpt-x\n')
  })
  it('/model with no args prints the current model', async () => {
    const s = await makeSession()
    const { sink, out } = makeSink()
    await handleLine(s, '/model', { sink })
    expect(out.join('')).toContain('model: gpt-5')
  })
  it('/reset without confirm refuses and leaves history untouched', async () => {
    const s = await makeSession()
    s.history.push({ role: 'user', content: 'x' })
    const { sink, out } = makeSink()
    expect(await handleLine(s, '/reset', { sink })).toBe('ok')
    expect(s.history.length).toBe(1)
    expect(out.join('')).toContain('cannot be undone')
    expect(out.join('')).toContain('/reset confirm')
  })
  it('/reset confirm drops the conversation', async () => {
    const s = await makeSession()
    s.history.push({ role: 'user', content: 'x' })
    const { sink, out } = makeSink()
    expect(await handleLine(s, '/reset confirm', { sink })).toBe('ok')
    expect(s.history.length).toBe(0)
    expect(out.join('')).toBe('session reset\n')
  })
  it('unknown command is reported', async () => {
    const s = await makeSession()
    const { sink, out } = makeSink()
    await handleLine(s, '/nope', { sink })
    expect(out.join('')).toContain('unknown command')
  })
  it('empty input is a no-op', async () => {
    const s = await makeSession()
    const { sink } = makeSink()
    const before = s.history.length
    expect(await handleLine(s, '   ', { sink })).toBe('ok')
    expect(s.history.length).toBe(before)
  })
  it('/exit returns the exit signal', async () => {
    const s = await makeSession()
    const { sink } = makeSink()
    expect(await handleLine(s, '/exit', { sink })).toBe('exit')
  })
})

describe('handleLine new commands', () => {
  it('/tasks lists in-session tasks', async () => {
    const s = await makeSession()
    s.tasks.replace([
      { content: 'write tests', status: 'pending', priority: 'medium' },
      { content: 'update docs', status: 'pending', priority: 'low' },
    ])
    const { sink, out } = makeSink()
    expect(await handleLine(s, '/tasks', { sink })).toBe('ok')
    const text = out.join('')
    expect(text).toContain('[pending] [medium] write tests')
    expect(text).toContain('[pending] [low] update docs')
  })
  it('/tasks reports when empty', async () => {
    const s = await makeSession()
    const { sink, out } = makeSink()
    await handleLine(s, '/tasks', { sink })
    expect(out.join('')).toBe('no tasks\n')
  })
  it('/todo lists in-session tasks (alias of /tasks)', async () => {
    const s = await makeSession()
    s.tasks.replace([
      { content: 'write tests', status: 'pending', priority: 'high' },
    ])
    const { sink, out } = makeSink()
    expect(await handleLine(s, '/todo', { sink })).toBe('ok')
    expect(out.join('')).toContain('[pending] [high] write tests')
  })
  it('/config prints effective configuration', async () => {
    const s = await makeSession()
    const { sink, out } = makeSink()
    await handleLine(s, '/config', { sink })
    const text = out.join('')
    expect(text).toContain(`model:        ${s.config.model}`)
    expect(text).toContain('context:')
    expect(text).toContain('mcpServers:   0 configured')
    expect(text).toContain('reasoning:    (provider default)')
  })
  it('/config shows a configured reasoning effort and verbosity', async () => {
    const s = await makeSession({ reasoningEffort: 'high', verbosity: 'low' })
    const { sink, out } = makeSink()
    await handleLine(s, '/config', { sink })
    expect(out.join('')).toContain('reasoning:    high')
    expect(out.join('')).toContain('verbosity:    low')
  })
  it('/mcp reports no servers configured by default', async () => {
    const s = await makeSession()
    const { sink, out } = makeSink()
    expect(await handleLine(s, '/mcp', { sink })).toBe('ok')
    expect(out.join('')).toBe('no MCP servers configured\n')
  })
  it('/mcp lists connected, disabled, and failed servers with their status', async () => {
    const s = await makeSession()
    s.mcp = {
      tools: [],
      servers: [
        { name: 'good', status: 'connected', toolCount: 3 },
        { name: 'bad', status: 'failed', toolCount: 0, error: 'ECONNREFUSED' },
        { name: 'off', status: 'disabled', toolCount: 0 },
      ],
      close: async () => {},
    }
    const { sink, out } = makeSink()
    await handleLine(s, '/mcp', { sink })
    const text = out.join('')
    expect(text).toContain('good')
    expect(text).toContain('connected (3 tools)')
    expect(text).toContain('bad')
    expect(text).toContain('failed — ECONNREFUSED')
    expect(text).toContain('off')
    expect(text).toContain('disabled (set enabled: true to connect)')
  })
  it('/config reports how many configured servers are enabled', async () => {
    // Set config.mcpServers directly on an already-created session rather
    // than through makeSession (which would connect it for real via
    // createSession) — /config only reads session.config, so there's
    // nothing here that needs an actual connection attempt.
    const s = await makeSession()
    s.config.mcpServers = {
      on: { type: 'local', enabled: true, command: 'node', args: [] },
      off: { type: 'local', enabled: false, command: 'node', args: [] },
    }
    const { sink, out } = makeSink()
    await handleLine(s, '/config', { sink })
    expect(out.join('')).toContain('mcpServers:   2 configured, 1 enabled')
  })
  it('/undo removes the last exchange', async () => {
    const s = await makeSession()
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
    const s = await makeSession()
    const { sink, out } = makeSink()
    await handleLine(s, '/undo', { sink })
    expect(out.join('')).toBe('nothing to undo\n')
    expect(s.history.length).toBe(0)
  })
})

describe('handleLine prompt turn', () => {
  it('runs a turn, records history, and writes output', async () => {
    const s = await makeSession()
    s.client = fakeClient('hi there')
    const { sink, out } = makeSink()
    expect(await handleLine(s, 'hello', { sink })).toBe('ok')
    // The assistant turn is now the SDK's own `message` output item (via
    // toResponseInputItems), not a hand-reconstructed {role, content} pair.
    const last = s.history.at(-1) as { type?: string; role?: string }
    expect(last.type).toBe('message')
    expect(last.role).toBe('assistant')
    expect(stripVTControlCharacters(out.join(''))).toBe('\nhi there\n\n')
  })

  it("records the last turn's usage", async () => {
    const s = await makeSession()
    s.client = fakeClient('hi there', false, undefined, {
      input: 12,
      output: 34,
    })
    const { sink } = makeSink()
    await handleLine(s, 'hello', { sink })
    expect(s.lastUsage).toEqual({ input: 12, output: 34 })
  })

  // Some OpenAI-compatible endpoints omit `usage` entirely — lastUsage
  // should stay unset rather than record a misleading {undefined, undefined}.
  it('leaves lastUsage unset when the provider reports no usage', async () => {
    const s = await makeSession()
    s.client = fakeClient('hi there')
    const { sink } = makeSink()
    await handleLine(s, 'hello', { sink })
    expect(s.lastUsage).toBeUndefined()
  })

  it('asPrompt sends slash-prefixed text as a prompt, not a command', async () => {
    const s = await makeSession()
    s.client = fakeClient('ok')
    const { sink, out } = makeSink()
    // Leading '/' would normally parse as a command; asPrompt (set for /edit
    // buffers) must treat the whole thing as a user turn instead.
    expect(
      await handleLine(s, '/usr/bin quirk', { sink, asPrompt: true }),
    ).toBe('ok')
    const first = s.history[0] as { role?: string; content?: string }
    expect(first.role).toBe('user')
    expect(first.content).toBe('/usr/bin quirk')
    expect(out.join('')).not.toContain('unknown command')
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

vi.mock('../../src/agent/client.ts', async (importOriginal) => ({
  // Real isContextOverflowError etc. — only createClient is faked.
  ...(await importOriginal<typeof import('../../src/agent/client.ts')>()),
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

  // Returns the still-pending `done` promise wrapped in an object rather than
  // returned directly — an async function auto-flattens a returned promise
  // (Promise<Promise<void>> collapses to Promise<void>), which here would
  // make awaiting start() itself block until the whole REPL session ends,
  // instead of just until the readline interface is ready.
  //
  // That wait is necessary now (and wasn't before): startRepl awaits
  // createSession, which connects any configured MCP servers (see
  // tools/mcp/manager.ts) before creating the interface — so, unlike before,
  // the FakeInterface is no longer guaranteed to exist the instant start()
  // is called, even with no servers configured.
  async function start(): Promise<{ done: Promise<void> }> {
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const config = cfg()
    const before = readlineInstanceCount()
    const done = startRepl(config, createLogger(config))
    await vi.waitFor(() => {
      if (readlineInstanceCount() <= before) throw new Error('not ready')
    })
    return { done }
  }

  function readlineInstanceCount(): number {
    return (readline as unknown as { __instances: unknown[] }).__instances
      .length
  }

  it('drives a line sequence and exits on /exit', async () => {
    const { done } = await start()
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
    const { done } = await start()
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
    const { done } = await start()
    const rl = lastFake()
    rl.emit('working')
    rl.emit('/exit')
    await done
    expect(rl.closed).toBe(true)
    expect(captured()).toContain('echo:working')
  })

  // Regression: a single idle Ctrl-C used to be a completely silent no-op —
  // no feedback, no exit — which reads as "the terminal is frozen" rather
  // than "there's nothing to interrupt right now."
  it('a single idle SIGINT does not exit', async () => {
    const { done } = await start()
    const rl = lastFake()
    rl.emit('SIGINT')
    expect(rl.closed).toBe(false)
    rl.emit('/exit')
    await done
  })

  it('two idle SIGINTs in quick succession exit the REPL, matching the bash/Python convention', async () => {
    const { done } = await start()
    const rl = lastFake()
    rl.emit('SIGINT')
    rl.emit('SIGINT')
    await done
    expect(rl.closed).toBe(true)
  })

  it('prints the hint once at startup, not after every turn', async () => {
    const { done } = await start()
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
  // /save writes under the session root, which is now always process.cwd()
  // (the `root` config field was removed) — so these tests chdir into a temp
  // dir instead of passing `root`, and restore the cwd afterward.
  const origCwd = process.cwd()
  afterEach(() => {
    process.chdir(origCwd)
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = undefined
  })

  it('/limit sets maxToolIterations at runtime', async () => {
    const s = await makeSession()
    const { sink, out } = makeSink()
    expect(await handleLine(s, '/limit 5', { sink })).toBe('ok')
    expect(s.config.maxToolIterations).toBe(5)
    expect(out.join('')).toContain('maxToolIterations set to 5')
  })

  it('/limit rejects non-positive input', async () => {
    const s = await makeSession()
    const { sink, out } = makeSink()
    await handleLine(s, '/limit abc', { sink })
    await handleLine(s, '/limit 0', { sink })
    expect(out.join('')).toContain('usage: /limit')
  })

  it('/model rebuilds the client so the new model takes effect', async () => {
    const s = await makeSession()
    const before = s.client
    const { sink } = makeSink()
    await handleLine(s, '/model gpt-4o', { sink })
    expect(s.config.model).toBe('gpt-4o')
    expect(s.client).not.toBe(before)
  })

  it('/save writes a JSON transcript and refuses to overwrite', async () => {
    dir = mkdtempSync(join(tmpdir(), 'dcode-save-'))
    process.chdir(dir)
    const s = await makeSession()
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
    process.chdir(dir)
    const s = await makeSession()
    s.history.push({ role: 'user', content: 'hi' })
    const { sink } = makeSink()
    await handleLine(s, '/save notes.md', { sink })
    const md = readFileSync(join(dir, 'notes.md'), 'utf8')
    expect(md).toContain('## user')
    expect(md).toContain('hi')
  })

  it('/save creates parent directories for a nested path', async () => {
    dir = mkdtempSync(join(tmpdir(), 'dcode-save-'))
    process.chdir(dir)
    const s = await makeSession()
    s.history.push({ role: 'user', content: 'hi' })
    const { sink } = makeSink()
    await handleLine(s, '/save sub/notes.json', { sink })
    expect(existsSync(join(dir, 'sub', 'notes.json'))).toBe(true)
  })

  it('a throwing command handler does not crash the REPL', async () => {
    dir = mkdtempSync(join(tmpdir(), 'dcode-save-'))
    process.chdir(dir)
    const s = await makeSession()
    // Plant a file where the parent dir should go so mkdirSync fails, exercising
    // the dispatch error guard in handleLine.
    writeFileSync(join(dir, 'blocker'), 'x')
    const { sink } = makeSink()
    await expect(
      handleLine(s, '/save blocker/notes.json', { sink }),
    ).resolves.toBe('ok')
  })
})

describe('formatStatusLine', () => {
  it('shows model, turn 0, and 0/usable before any turn has run', async () => {
    const s = await makeSession({ color: false })
    const line = formatStatusLine(s)
    expect(line).toContain(s.config.model)
    expect(line).toContain('turn 0')
    expect(line).not.toContain('↑') // no ↑/↓ segment before a real turn
    expect(line).toMatch(/0\/\d+ \(0% used\)/)
  })

  it("includes this turn's ↑/↓ usage once lastUsage is set", async () => {
    const s = await makeSession({ color: false })
    // Turn count is derived from history (one 'user' item per turn), not
    // stored separately — see repl.ts's turnCount.
    s.history.push(
      { role: 'user', content: 'one' },
      { role: 'user', content: 'two' },
      { role: 'user', content: 'three' },
    )
    s.lastUsage = { input: 105, output: 221 }
    const line = formatStatusLine(s)
    expect(line).toContain('turn 3')
    expect(line).toContain('↑105')
    expect(line).toContain('↓221')
  })

  // Deriving turn count from history means /undo and /reset can't leave a
  // separate counter stale the way earlier stored state could — this is the
  // regression test for exactly that bug.
  it('reflects a shorter turn count immediately after /undo', async () => {
    const s = await makeSession({ color: false })
    s.client = fakeClient('hi there', false, undefined, {
      input: 1,
      output: 2,
    })
    const { sink } = makeSink()
    await handleLine(s, 'first', { sink })
    await handleLine(s, 'second', { sink })
    expect(formatStatusLine(s)).toContain('turn 2')
    await handleLine(s, '/undo', { sink })
    expect(formatStatusLine(s)).toContain('turn 1')
    // The undone turn's usage must not linger either.
    expect(s.lastUsage).toBeUndefined()
  })

  it('does not count injected "Continue." retries as turns', async () => {
    const s = await makeSession({ color: false })
    s.history.push(
      { role: 'user', content: 'real prompt' },
      { role: 'assistant', content: 'partial' },
      { role: 'user', content: CONTINUE_PROMPT },
    )
    expect(formatStatusLine(s)).toContain('turn 1')
  })

  it('/undo removes a truncated turn back to its real prompt', async () => {
    const s = await makeSession({ color: false })
    s.history.push(
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'second' },
      { role: 'assistant', content: 'partial' },
      { role: 'user', content: CONTINUE_PROMPT },
      { role: 'assistant', content: 'rest' },
    )
    const { sink } = makeSink()
    await handleLine(s, '/undo', { sink })
    expect(s.history.map((h) => (h as { content?: string }).content)).toEqual([
      'first',
      'a1',
    ])
  })

  it('clears lastUsage when a turn fails', async () => {
    const s = await makeSession({ color: false })
    s.lastUsage = { input: 1, output: 2 }
    s.client = {
      stream() {
        throw new Error('boom')
      },
    } as unknown as Client
    const { sink } = makeSink()
    await handleLine(s, 'hello', { sink })
    expect(s.lastUsage).toBeUndefined()
  })

  it('resets to turn 0 after /reset confirm', async () => {
    const s = await makeSession({ color: false })
    s.client = fakeClient('hi there', false, undefined, {
      input: 1,
      output: 2,
    })
    const { sink } = makeSink()
    await handleLine(s, 'hello', { sink })
    expect(formatStatusLine(s)).toContain('turn 1')
    await handleLine(s, '/reset confirm', { sink })
    expect(formatStatusLine(s)).toContain('turn 0')
    expect(s.lastUsage).toBeUndefined()
  })

  // color:false is threaded through paintFor the same way the rest of the
  // REPL's output is (see util/color.ts) — the --no-color bug this codebase
  // has fixed before was exactly a case that looked colored-off but wasn't.
  it('emits no ANSI codes when color is false', async () => {
    const s = await makeSession({ color: false })
    s.lastUsage = { input: 1, output: 2 }
    const line = formatStatusLine(s)
    expect(line).toBe(stripVTControlCharacters(line))
  })
})

afterEach(() => vi.restoreAllMocks())
