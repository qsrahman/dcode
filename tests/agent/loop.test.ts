import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { styleText, stripVTControlCharacters } from 'node:util'
import OpenAI from 'openai'
import { z } from 'zod/v4'
import type {
  Client,
  OpenAIResponse,
  ResponseInput,
} from '../../src/agent/client.ts'
import { isContextOverflowError } from '../../src/agent/client.ts'
import { runAgent } from '../../src/agent/loop.ts'
import { CapturingSink } from '../../src/ui/sink.ts'
import { renderToolResult, renderToolOutput } from '../../src/ui/tools.ts'
import type { ToolDefinition } from '../../src/agent/types.ts'
import { ToolRegistry } from '../../src/tools/registry.ts'
import { createLogger } from '../../src/util/log.ts'
import { cfg, messageItem } from '../helpers.ts'

function fakeClientWithCalls(calls: unknown[][]): Client {
  let turn = 0
  return {
    stream() {
      const text = `turn ${turn}`
      return {
        async *[Symbol.asyncIterator]() {
          yield text
        },
        finalResponse: async () => {
          // A message item alongside any function_call items, mirroring how
          // the real API backs output_text — see helpers.ts's messageItem.
          const output = [messageItem(text), ...(calls[turn] ?? [])]
          turn++
          return { output, output_text: text } as unknown as OpenAIResponse
        },
      }
    },
  }
}

const readTool: ToolDefinition = {
  name: 'read_file',
  category: 'read',
  description: 'reads',
  parameters: z.object({}),
  async execute() {
    return 'file contents'
  },
}

const writeTool: ToolDefinition = {
  name: 'write_file',
  category: 'edit',
  description: 'writes',
  parameters: z.object({ path: z.string() }),
  async execute(args: { path: string }) {
    return `wrote ${args.path}`
  },
}

describe('runAgent', () => {
  it('streams text and stops when there are no tool calls', async () => {
    const client = fakeClientWithCalls([[]])
    const history: ResponseInput = [{ role: 'user', content: 'go' }]
    const { text } = await runAgent(client, cfg(), history, {
      logger: createLogger(cfg()),
    })
    expect(text).toBe('turn 0')
    // The assistant turn is now the SDK's own `message` output item (via
    // toResponseInputItems), not a hand-reconstructed {role, content} pair.
    const last = history.at(-1) as { type?: string; role?: string }
    expect(last.type).toBe('message')
    expect(last.role).toBe('assistant')
  })

  it('runs tools, feeds results back, and terminates', async () => {
    const client = fakeClientWithCalls([
      [
        {
          type: 'function_call',
          call_id: 'c1',
          name: 'read_file',
          arguments: '{"path":"a.txt"}',
        },
      ],
      [],
    ])
    const history: ResponseInput = [{ role: 'user', content: 'go' }]
    const { text } = await runAgent(client, cfg(), history, {
      logger: createLogger(cfg()),
      tools: new ToolRegistry([readTool]),
    })
    expect(text).toBe('turn 1')
    const outputs = history.filter(
      (h) => (h as { type?: string }).type === 'function_call_output',
    )
    expect(outputs).toHaveLength(1)
    expect((outputs[0] as { output: string }).output).toBe('file contents')
  })

  // End-to-end regression for the --no-color bug: markdown rendering
  // (marked-terminal, via its own internal chalk import) and tool-status
  // rendering (ui/tools.ts's renderToolResult/renderToolOutput) each used to
  // decide color independently of config.color, so --no-color only worked
  // by accident (when NO_COLOR was set or output was piped). This runs a
  // full turn — streamed markdown text with bold, a tool call, and verbose
  // tool-output echoing — with color:false and asserts zero ANSI escape
  // bytes anywhere in what was written, not just that stripping happens to
  // produce the same text.
  it('produces zero ANSI escape codes end-to-end when color is false', async () => {
    let turn = 0
    const client: Client = {
      stream() {
        const text = turn === 0 ? 'Some **bold** text' : 'turn 1'
        return {
          async *[Symbol.asyncIterator]() {
            yield text
          },
          finalResponse: async () => {
            const output =
              turn === 0
                ? [
                    messageItem(text),
                    {
                      type: 'function_call',
                      call_id: 'c1',
                      name: 'read_file',
                      arguments: '{}',
                    },
                  ]
                : [messageItem(text)]
            turn++
            return { output, output_text: text } as unknown as OpenAIResponse
          },
        }
      },
    }
    const history: ResponseInput = [{ role: 'user', content: 'go' }]
    const chunks: string[] = []
    await runAgent(client, cfg({ color: false, verbose: true }), history, {
      sink: { write: (t) => void chunks.push(t) },
      logger: createLogger(cfg()),
      tools: new ToolRegistry([readTool]),
    })
    const out = chunks.join('')
    expect(out).not.toMatch(/\x1b\[/)
    expect(out).toContain('bold')
    expect(out).toContain('read_file')
  })

  it('caps iterations at maxToolIterations', async () => {
    const client: Client = {
      stream() {
        return {
          async *[Symbol.asyncIterator]() {
            yield 'loop'
          },
          finalResponse: async () =>
            ({
              output: [
                {
                  type: 'function_call',
                  call_id: 'c',
                  name: 'read_file',
                  arguments: '{}',
                },
              ],
              output_text: 'loop',
            }) as unknown as OpenAIResponse,
        }
      },
    }
    const history: ResponseInput = [{ role: 'user', content: 'go' }]
    const { truncated } = await runAgent(
      client,
      cfg({ maxToolIterations: 3 }),
      history,
      {
        logger: createLogger(cfg()),
        tools: new ToolRegistry([readTool]),
      },
    )
    const outputs = history.filter(
      (h) => (h as { type?: string }).type === 'function_call_output',
    )
    expect(outputs).toHaveLength(3)
    // Every call the cap did let through still got its output (history stays
    // resumable), and the result says so rather than looking like a normal
    // completion.
    expect(truncated).toBe(true)
  })

  it('reports truncated: false when the loop ends on its own', async () => {
    const client = fakeClientWithCalls([[]])
    const history: ResponseInput = [{ role: 'user', content: 'go' }]
    const { truncated } = await runAgent(client, cfg(), history, {
      logger: createLogger(cfg()),
    })
    expect(truncated).toBe(false)
  })

  // Reasoning models require reasoning items to be replayed alongside their
  // corresponding function_call on every stateless (store: false) turn that
  // continues a tool call — a hand-reconstructed history that only kept
  // function_call items would silently drop them.
  it('replays reasoning items alongside function_call items', async () => {
    const client = fakeClientWithCalls([
      [
        { type: 'reasoning', id: 'r1', summary: [] },
        {
          type: 'function_call',
          call_id: 'c1',
          name: 'read_file',
          arguments: '{"path":"a"}',
        },
      ],
      [],
    ])
    const history: ResponseInput = [{ role: 'user', content: 'go' }]
    await runAgent(client, cfg(), history, {
      logger: createLogger(cfg()),
      tools: new ToolRegistry([readTool]),
    })
    const reasoning = history.find(
      (h) => (h as { type?: string }).type === 'reasoning',
    )
    expect(reasoning).toBeDefined()
    // The reasoning item must come before its function_call, matching the
    // order the model actually emitted them in.
    const reasoningIdx = history.findIndex(
      (h) => (h as { type?: string }).type === 'reasoning',
    )
    const callIdx = history.findIndex(
      (h) => (h as { type?: string }).type === 'function_call',
    )
    expect(reasoningIdx).toBeLessThan(callIdx)
  })

  it('runs mutating tools unconditionally', async () => {
    const client = fakeClientWithCalls([
      [
        {
          type: 'function_call',
          call_id: 'c1',
          name: 'write_file',
          arguments: '{"path":"a.txt"}',
        },
      ],
      [],
    ])
    const history: ResponseInput = [{ role: 'user', content: 'go' }]
    await runAgent(client, cfg(), history, {
      logger: createLogger(cfg()),
      tools: new ToolRegistry([writeTool]),
    })
    const outputs = history.filter(
      (h) => (h as { type?: string }).type === 'function_call_output',
    )
    expect((outputs[0] as { output: string }).output).toBe('wrote a.txt')
  })

  it('runs mutating tools sequentially in call order', async () => {
    const order: string[] = []
    const seqTool: ToolDefinition = {
      name: 'write_file',
      description: 'writes',
      parameters: z.object({ path: z.string() }),
      async execute(args: { path: string }) {
        order.push(args.path)
        return `wrote ${args.path}`
      },
    }
    const client = fakeClientWithCalls([
      [
        {
          type: 'function_call',
          call_id: 'c1',
          name: 'write_file',
          arguments: '{"path":"a"}',
        },
        {
          type: 'function_call',
          call_id: 'c2',
          name: 'write_file',
          arguments: '{"path":"b"}',
        },
      ],
      [],
    ])
    const history: ResponseInput = [{ role: 'user', content: 'go' }]
    await runAgent(client, cfg(), history, {
      logger: createLogger(cfg()),
      tools: new ToolRegistry([seqTool]),
    })
    expect(order).toEqual(['a', 'b'])
  })

  it('runs parallel-eligible (read) calls concurrently via Promise.all', async () => {
    let active = 0
    let maxActive = 0
    const makeRead = (name: string): ToolDefinition => ({
      name,
      description: 'reads',
      parameters: z.object({}),
      async execute() {
        active++
        maxActive = Math.max(maxActive, active)
        await new Promise((r) => setTimeout(r, 20))
        active--
        return 'ok'
      },
    })
    const client = fakeClientWithCalls([
      [
        {
          type: 'function_call',
          call_id: 'c1',
          name: 'read_a',
          arguments: '{}',
        },
        {
          type: 'function_call',
          call_id: 'c2',
          name: 'read_b',
          arguments: '{}',
        },
      ],
      [],
    ])
    const history: ResponseInput = [{ role: 'user', content: 'go' }]
    await runAgent(client, cfg(), history, {
      logger: createLogger(cfg()),
      tools: new ToolRegistry([makeRead('read_a'), makeRead('read_b')]),
    })
    // Both reads ran in the same Promise.all batch, so peak concurrency was 2.
    expect(maxActive).toBe(2)
  })

  it('runs mutating (parallel:false) calls sequentially', async () => {
    let active = 0
    let maxActive = 0
    const write: ToolDefinition = {
      name: 'write_file',
      description: 'writes',
      parameters: z.object({ path: z.string() }),
      parallel: false,
      async execute() {
        active++
        maxActive = Math.max(maxActive, active)
        await new Promise((r) => setTimeout(r, 20))
        active--
        return 'ok'
      },
    }
    const client = fakeClientWithCalls([
      [
        {
          type: 'function_call',
          call_id: 'c1',
          name: 'write_file',
          arguments: '{"path":"a"}',
        },
        {
          type: 'function_call',
          call_id: 'c2',
          name: 'write_file',
          arguments: '{"path":"b"}',
        },
      ],
      [],
    ])
    const history: ResponseInput = [{ role: 'user', content: 'go' }]
    await runAgent(client, cfg(), history, {
      logger: createLogger(cfg()),
      tools: new ToolRegistry([write]),
    })
    // Mutating calls run one at a time, so peak concurrency was 1.
    expect(maxActive).toBe(1)
  })

  it('preserves call order in history across read and mutate results', async () => {
    const readTool2: ToolDefinition = {
      name: 'read_file',
      description: 'reads',
      parameters: z.object({ path: z.string() }),
      async execute() {
        return 'ok'
      },
    }
    const writeTool2: ToolDefinition = {
      name: 'write_file',
      description: 'writes',
      parameters: z.object({ path: z.string() }),
      async execute() {
        return 'ok'
      },
    }
    const client = fakeClientWithCalls([
      [
        {
          type: 'function_call',
          call_id: 'c1',
          name: 'write_file',
          arguments: '{"path":"a"}',
        },
        {
          type: 'function_call',
          call_id: 'c2',
          name: 'read_file',
          arguments: '{"path":"b"}',
        },
      ],
      [],
    ])
    const history: ResponseInput = [{ role: 'user', content: 'go' }]
    await runAgent(client, cfg(), history, {
      logger: createLogger(cfg()),
      tools: new ToolRegistry([readTool2, writeTool2]),
    })
    const outputs = history.filter(
      (h) => (h as { type?: string }).type === 'function_call_output',
    ) as { call_id: string; output: string }[]
    expect(outputs.map((o) => o.call_id)).toEqual(['c1', 'c2'])
  })

  it('passes the system prompt via instructions, not as a history item', async () => {
    const calls: { input: ResponseInput; opts: { instructions?: string } }[] =
      []
    const client: Client = {
      stream(input, opts) {
        calls.push({ input, opts: opts ?? {} })
        return {
          async *[Symbol.asyncIterator]() {
            yield 'ok'
          },
          finalResponse: async () =>
            ({ output: [], output_text: 'ok' }) as unknown as OpenAIResponse,
        }
      },
    }
    const history: ResponseInput = [{ role: 'user', content: 'go' }]
    await runAgent(client, cfg(), history, { logger: createLogger(cfg()) })
    expect(calls.length).toBeGreaterThan(0)
    expect(typeof calls[0]!.opts.instructions).toBe('string')
    expect(calls[0]!.opts.instructions).toContain('Working directory')
    // The system prompt is carried via `instructions`, never injected as a
    // `system` role item in the conversation history.
    expect(
      history.some((h) => (h as { role?: string }).role === 'system'),
    ).toBe(false)
  })

  it('on abort, throws but leaves history balanced (every call has an output)', async () => {
    const client = fakeClientWithCalls([
      [
        {
          type: 'function_call',
          call_id: 'c1',
          name: 'read_file',
          arguments: '{}',
        },
        {
          type: 'function_call',
          call_id: 'c2',
          name: 'read_file',
          arguments: '{}',
        },
      ],
      [],
    ])
    const ac = new AbortController()
    ac.abort()
    const history: ResponseInput = [{ role: 'user', content: 'go' }]
    await expect(
      runAgent(client, cfg(), history, {
        logger: createLogger(cfg()),
        tools: new ToolRegistry([readTool]),
        signal: ac.signal,
      }),
    ).rejects.toThrow(/aborted/)
    const calls = history.filter(
      (h) => (h as { type?: string }).type === 'function_call',
    )
    const outputs = history.filter(
      (h) => (h as { type?: string }).type === 'function_call_output',
    )
    expect(calls).toHaveLength(2)
    expect(outputs).toHaveLength(2)
    expect((outputs[0] as { output: string }).output).toBe('aborted')
  })
})

describe('tool result rendering', () => {
  it('shows a check for success and a cross for failure', () => {
    expect(
      stripVTControlCharacters(renderToolResult('read_file', true, 0, true)),
    ).toBe('› read_file: ✓ done (0.0s)')
    expect(
      stripVTControlCharacters(renderToolResult('grep', false, 1200, true)),
    ).toBe('› grep: ✗ failed (1.2s)')
  })

  it('fences the raw output between rules naming the tool', () => {
    const stripped = stripVTControlCharacters(
      renderToolOutput('grep', 'a\nb', true),
    )
    expect(stripped).toContain('── grep output ─')
    expect(stripped).toContain('\na\nb\n')
  })

  it('colors diff lines (additions green, removals red, headers cyan)', () => {
    const out = renderToolOutput('edit_file', '@@ -1 +1 @@\n-old\n+new', true)
    expect(stripVTControlCharacters(out)).toContain('@@ -1 +1 @@')
    expect(stripVTControlCharacters(out)).toContain('-old')
    expect(stripVTControlCharacters(out)).toContain('+new')
    expect(out).toContain(styleText('green', '+new'))
    expect(out).toContain(styleText('red', '-old'))
  })

  // The bug this guards against: --no-color only worked when NO_COLOR was
  // set or output was piped, because the old ANSI library's own TTY
  // auto-detection ignored config.color entirely. color:false must produce
  // zero ANSI codes, regardless of terminal auto-detection.
  it('emits no ANSI codes at all when color is false', () => {
    const result = renderToolResult('read_file', true, 0, false)
    expect(result).toBe(stripVTControlCharacters(result))
    expect(result).toBe('› read_file: ✓ done (0.0s)')

    const output = renderToolOutput(
      'edit_file',
      '@@ -1 +1 @@\n-old\n+new',
      false,
    )
    expect(output).toBe(stripVTControlCharacters(output))
    expect(output).toContain('@@ -1 +1 @@')
    expect(output).toContain('-old')
    expect(output).toContain('+new')
  })
})

// The interactive (TTY) default: a live counter that freezes into a bounded
// category summary, instead of one `› tool: ✓` line per call. Gated on
// process.stdout.isTTY, so it must be forced on here (vitest runs non-TTY).
describe('runAgent — interactive tool summary', () => {
  const realIsTTY = process.stdout.isTTY
  const realCI = process.env.CI

  // The live line is gated on `!isCI()` too; neutralize a real CI env so the
  // TTY-forcing tests below exercise the interactive path deterministically.
  beforeEach(() => {
    delete process.env.CI
  })
  afterEach(() => {
    if (realCI === undefined) delete process.env.CI
    else process.env.CI = realCI
  })

  function runWith(sink: CapturingSink, calls: unknown[][]) {
    const client = fakeClientWithCalls(calls)
    const history: ResponseInput = [{ role: 'user', content: 'go' }]
    return runAgent(client, cfg(), history, {
      sink,
      logger: createLogger(cfg()),
      tools: new ToolRegistry([readTool, writeTool]),
    })
  }

  const twoToolTurn: unknown[][] = [
    [
      {
        type: 'function_call',
        call_id: 'c1',
        name: 'read_file',
        arguments: '{}',
      },
      {
        type: 'function_call',
        call_id: 'c2',
        name: 'write_file',
        arguments: '{"path":"a.txt"}',
      },
    ],
    [],
  ]

  it('renders one category summary instead of a line per tool', async () => {
    process.stdout.isTTY = true
    try {
      const sink = new CapturingSink()
      await runWith(sink, twoToolTurn)
      const out = stripVTControlCharacters(sink.text)
      // Bounded family summary, not an enumerated per-call list.
      expect(out).toContain('1 read · 1 edit')
      expect(out).not.toContain('› read_file:')
      expect(out).not.toContain('› write_file:')
      // The answer still streams after the summary.
      expect(out).toContain('turn 1')
    } finally {
      process.stdout.isTTY = realIsTTY
    }
  })

  // A client that reports model activity through the callback runTurn passes
  // down, then either streams text or fails, like a real reasoning model would.
  function activityClient(mode: 'answer' | 'fail'): Client {
    return {
      stream(_input, opts) {
        opts?.onActivity?.({ kind: 'reasoning' })
        return {
          async *[Symbol.asyncIterator]() {
            if (mode === 'fail') throw new Error('boom')
            yield 'answer'
          },
          finalResponse: async () =>
            ({
              output: [messageItem('answer')],
              output_text: 'answer',
            }) as unknown as OpenAIResponse,
        }
      },
    }
  }

  it('shows a thinking line during a silent phase and erases it when text starts', async () => {
    process.stdout.isTTY = true
    try {
      const sink = new CapturingSink()
      await runAgent(
        activityClient('answer'),
        cfg(),
        [{ role: 'user', content: 'go' }],
        { sink, logger: createLogger(cfg()) },
      )
      const raw = sink.text
      expect(stripVTControlCharacters(raw)).toContain('⋯ thinking…')
      // The transient line is cleared before the answer is written over it.
      expect(raw.indexOf('\r\x1b[2K', raw.indexOf('thinking'))).toBeLessThan(
        raw.indexOf('answer'),
      )
    } finally {
      process.stdout.isTTY = realIsTTY
    }
  })

  it('erases the activity line when the turn fails, so the error lands on a clean line', async () => {
    process.stdout.isTTY = true
    try {
      const sink = new CapturingSink()
      await expect(
        runAgent(
          activityClient('fail'),
          cfg(),
          [{ role: 'user', content: 'go' }],
          { sink, logger: createLogger(cfg()) },
        ),
      ).rejects.toThrow('boom')
      expect(sink.text.endsWith('\r\x1b[2K')).toBe(true)
    } finally {
      process.stdout.isTTY = realIsTTY
    }
  })

  it('keeps the per-tool lines (no summary) when not a TTY', async () => {
    process.stdout.isTTY = false
    try {
      const sink = new CapturingSink()
      await runWith(sink, twoToolTurn)
      const out = stripVTControlCharacters(sink.text)
      expect(out).toContain('› read_file: ✓ done')
      expect(out).not.toContain('1 read · 1 edit')
    } finally {
      process.stdout.isTTY = realIsTTY
    }
  })

  it('keeps the per-tool lines under CI even with a TTY (no in-place redraw)', async () => {
    process.stdout.isTTY = true
    process.env.CI = 'true'
    try {
      const sink = new CapturingSink()
      await runWith(sink, twoToolTurn)
      const out = stripVTControlCharacters(sink.text)
      expect(out).toContain('› read_file: ✓ done')
      expect(out).not.toContain('1 read · 1 edit')
    } finally {
      process.stdout.isTTY = realIsTTY
    }
  })
})

// ── A7: Multi-retry compaction ─────────────────────────────────────────────

describe('isContextOverflowError', () => {
  it('matches a 413 OpenAI APIError and its context_length_exceeded code', () => {
    expect(
      isContextOverflowError(
        new OpenAI.APIError(
          413,
          { code: 'context_length_exceeded' },
          'too long',
          undefined,
        ),
      ),
    ).toBe(true)
    // Some providers report the code on a non-413 status.
    expect(
      isContextOverflowError(
        new OpenAI.APIError(
          400,
          { code: 'context_length_exceeded' },
          'too long',
          undefined,
        ),
      ),
    ).toBe(true)
  })

  it('matches plain Error objects carrying a 413 status', () => {
    const e = Object.assign(new Error('over budget'), { status: 413 })
    expect(isContextOverflowError(e)).toBe(true)
  })

  it('falls back to message wording', () => {
    expect(
      isContextOverflowError(
        new Error('prompt is too long: maximum context length is 128000'),
      ),
    ).toBe(true)
    expect(isContextOverflowError(new Error('network timeout'))).toBe(false)
    expect(isContextOverflowError('not an error')).toBe(false)
    expect(isContextOverflowError(null)).toBe(false)
  })
})

function makeOverflowError(): Error & { status: number; code: string } {
  const e = new Error('maximum context length exceeded') as Error & {
    status: number
    code: string
  }
  e.status = 413
  e.code = 'context_length_exceeded'
  return e
}

function fakeContext(overflowRetries = 3): {
  context: Parameters<typeof runAgent>[3]['context']
  overflowCount: () => number
} {
  let overflowN = 0
  return {
    context: {
      beforeTurn: async () => 'none',
      observe: () => {},
      predict: () => 0,
      onOverflow: async () => {
        overflowN++
        return overflowN <= overflowRetries
      },
    } as any,
    overflowCount: () => overflowN,
  }
}

describe('runAgent — overflow retry (A7)', () => {
  function overflowClient(failTimes: number): {
    client: Client
    streamCount: () => number
  } {
    let n = 0
    return {
      client: {
        stream() {
          n++
          if (n <= failTimes) throw makeOverflowError()
          return {
            async *[Symbol.asyncIterator]() {
              yield 'ok'
            },
            finalResponse: async () =>
              ({
                output: [messageItem('ok')],
                output_text: 'ok',
              }) as unknown as OpenAIResponse,
          }
        },
      } satisfies Client,
      streamCount: () => n,
    }
  }

  it('compacts and retries up to 3 times on overflow', async () => {
    const { client, streamCount } = overflowClient(2) // fail first 2 times
    const { context, overflowCount } = fakeContext(5) // always "succeed"
    const history: ResponseInput = [{ role: 'user', content: 'go' }]
    const { text } = await runAgent(client, cfg(), history, {
      logger: createLogger(cfg()),
      context,
    })
    expect(text).toBe('ok')
    expect(overflowCount()).toBe(2)
    expect(streamCount()).toBe(3)
  })

  it('throws after all 3 overflow retries are exhausted', async () => {
    const { client, streamCount } = overflowClient(5) // always fail
    const { context, overflowCount } = fakeContext(5) // always "succeed"
    const history: ResponseInput = [{ role: 'user', content: 'go' }]
    await expect(
      runAgent(client, cfg(), history, {
        logger: createLogger(cfg()),
        context,
      }),
    ).rejects.toThrow(/context.length.exceeded|maximum context length/i)
    expect(overflowCount()).toBe(3)
    expect(streamCount()).toBe(4)
  })

  it('does not retry non-overflow errors', async () => {
    let n = 0
    const client: Client = {
      stream() {
        n++
        return {
          async *[Symbol.asyncIterator]() {
            if (n === 1) throw new Error('network timeout')
            yield 'ok'
          },
          finalResponse: async () =>
            ({
              output: [messageItem('ok')],
              output_text: 'ok',
            }) as unknown as OpenAIResponse,
        }
      },
    }
    const history: ResponseInput = [{ role: 'user', content: 'go' }]
    await expect(
      runAgent(client, cfg(), history, {
        logger: createLogger(cfg()),
      }),
    ).rejects.toThrow('network timeout')
    expect(n).toBe(1) // no retry
  })
})

// ── A3: Max output tokens recovery ─────────────────────────────────────────

describe('runAgent — max output tokens recovery (A3)', () => {
  it('injects "Continue." when response is truncated and retries', async () => {
    let turn = 0
    const client: Client = {
      stream() {
        turn++
        return {
          async *[Symbol.asyncIterator]() {
            yield turn === 1 ? 'partial' : 'done'
          },
          finalResponse: async () => {
            if (turn === 1) {
              return {
                output: [messageItem('partial')],
                output_text: 'partial',
                incomplete_details: { reason: 'max_output_tokens' },
              } as unknown as OpenAIResponse
            }
            return {
              output: [messageItem('done')],
              output_text: 'done',
            } as unknown as OpenAIResponse
          },
        }
      },
    }
    const history: ResponseInput = [{ role: 'user', content: 'go' }]
    const { text } = await runAgent(client, cfg(), history, {
      logger: createLogger(cfg()),
    })
    expect(text).toBe('done')
    // "Continue." was injected into history after the truncated turn
    const continueMsg = history.find(
      (h) => (h as { content?: string }).content === 'Continue.',
    )
    expect(continueMsg).toBeDefined()
    expect((continueMsg as { role: string }).role).toBe('user')
  })

  it('gives up after 3 consecutive truncations', async () => {
    let turn = 0
    const client: Client = {
      stream() {
        turn++
        return {
          async *[Symbol.asyncIterator]() {
            yield `turn ${turn}`
          },
          finalResponse: async () =>
            ({
              output: [messageItem(`turn ${turn}`)],
              output_text: `turn ${turn}`,
              incomplete_details: { reason: 'max_output_tokens' },
            }) as unknown as OpenAIResponse,
        }
      },
    }
    const history: ResponseInput = [{ role: 'user', content: 'go' }]
    const { text } = await runAgent(client, cfg(), history, {
      logger: createLogger(cfg()),
    })
    // Returns the last truncated text
    expect(text).toBe('turn 4') // 1 initial + 3 continues = 4 turns
    // 3 "Continue." messages in history
    const continues = history.filter(
      (h) => (h as { content?: string }).content === 'Continue.',
    )
    expect(continues).toHaveLength(3)
    // Total streams: 1 initial + 3 continues = 4
    expect(turn).toBe(4)
  })

  it('does not inject "Continue." for non-truncated responses', async () => {
    const client: Client = {
      stream() {
        return {
          async *[Symbol.asyncIterator]() {
            yield 'complete'
          },
          finalResponse: async () =>
            ({
              output: [messageItem('complete')],
              output_text: 'complete',
              incomplete_details: null,
            }) as unknown as OpenAIResponse,
        }
      },
    }
    const history: ResponseInput = [{ role: 'user', content: 'go' }]
    const { text } = await runAgent(client, cfg(), history, {
      logger: createLogger(cfg()),
    })
    expect(text).toBe('complete')
    const continues = history.filter(
      (h) => (h as { content?: string }).content === 'Continue.',
    )
    expect(continues).toHaveLength(0)
  })

  it('resets continue counter after a successful non-truncated turn', async () => {
    let turn = 0
    const client: Client = {
      stream() {
        turn++
        return {
          async *[Symbol.asyncIterator]() {
            yield `turn ${turn}`
          },
          finalResponse: async () => {
            // Turn 1: truncated, Turn 2: complete
            const truncated = turn === 1
            return {
              output: [messageItem(`turn ${turn}`)],
              output_text: `turn ${turn}`,
              incomplete_details: truncated
                ? { reason: 'max_output_tokens' }
                : null,
            } as unknown as OpenAIResponse
          },
        }
      },
    }
    const history: ResponseInput = [{ role: 'user', content: 'go' }]
    const { text } = await runAgent(client, cfg(), history, {
      logger: createLogger(cfg()),
    })
    // Continue runs within one tool iteration; non-truncated turn 2 exits the
    // while loop, then the main loop breaks (no tool calls).
    expect(text).toBe('turn 2')
    // One "Continue." message (only turn 1 was truncated)
    const continues = history.filter(
      (h) => (h as { content?: string }).content === 'Continue.',
    )
    expect(continues).toHaveLength(1)
  })

  it('replays the truncated partial before "Continue."', async () => {
    let turn = 0
    const client: Client = {
      stream() {
        turn++
        return {
          async *[Symbol.asyncIterator]() {
            yield turn === 1 ? 'partial' : 'done'
          },
          finalResponse: async () => {
            if (turn === 1) {
              return {
                output: [messageItem('partial')],
                output_text: 'partial',
                incomplete_details: { reason: 'max_output_tokens' },
              } as unknown as OpenAIResponse
            }
            return {
              output: [messageItem('done')],
              output_text: 'done',
            } as unknown as OpenAIResponse
          },
        }
      },
    }
    const history: ResponseInput = [{ role: 'user', content: 'go' }]
    const { text } = await runAgent(client, cfg(), history, {
      logger: createLogger(cfg()),
    })
    expect(text).toBe('done')
    // The truncated turn was replayed as an assistant message, ordered before
    // the "Continue." so the retry sees the partial answer.
    const partialIdx = history.findIndex((h) => {
      const item = h as { type?: string; content?: { text?: string }[] }
      return (
        item.type === 'message' &&
        item.content?.some((c) => 'text' in c && c.text === 'partial') === true
      )
    })
    const continueIdx = history.findIndex(
      (h) => (h as { content?: string }).content === 'Continue.',
    )
    expect(partialIdx).toBeGreaterThan(-1)
    expect(continueIdx).toBeGreaterThan(partialIdx)
  })

  it('recovers an overflow on a "Continue." retry via compaction', async () => {
    let n = 0
    const client: Client = {
      stream() {
        n++
        // The retry after "Continue." overflows; the overflow recovery must
        // kick in there too instead of surfacing the error raw.
        if (n === 2) throw makeOverflowError()
        return {
          async *[Symbol.asyncIterator]() {
            yield n === 1 ? 'partial' : 'done'
          },
          finalResponse: async () => {
            if (n === 1) {
              return {
                output: [messageItem('partial')],
                output_text: 'partial',
                incomplete_details: { reason: 'max_output_tokens' },
              } as unknown as OpenAIResponse
            }
            return {
              output: [messageItem('done')],
              output_text: 'done',
            } as unknown as OpenAIResponse
          },
        }
      },
    }
    const { context, overflowCount } = fakeContext()
    const history: ResponseInput = [{ role: 'user', content: 'go' }]
    const { text } = await runAgent(client, cfg(), history, {
      logger: createLogger(cfg()),
      context,
    })
    expect(text).toBe('done')
    expect(overflowCount()).toBe(1)
    expect(n).toBe(3)
  })
})
