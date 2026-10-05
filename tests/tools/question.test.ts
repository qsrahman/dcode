import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { askUserTool } from '../../src/tools/local/question.ts'
import type { ToolContext } from '../../src/agent/types.ts'
import { cfg } from '../helpers.ts'
import { createLogger } from '../../src/util/log.ts'

vi.mock('@clack/prompts', () => ({
  select: vi.fn(),
  multiselect: vi.fn(),
  text: vi.fn(),
  cancel: vi.fn(),
  isCancel: (v: unknown) => v === Symbol.for('clack:cancel'),
}))

import { select, multiselect, text } from '@clack/prompts'

const mockedSelect = vi.mocked(select)
const mockedMultiselect = vi.mocked(multiselect)
const mockedText = vi.mocked(text)

let ctx: ToolContext
const realIsTTY = process.stdin.isTTY

// ask_user refuses to prompt when stdin isn't a TTY (a piped one-shot run
// would otherwise hang forever waiting for a keypress). vitest runs with a
// non-TTY stdin, so the interactive path has to be simulated here.
beforeEach(() => {
  vi.clearAllMocks()
  ctx = { root: '/tmp', config: cfg(), logger: createLogger(cfg()) }
  process.stdin.isTTY = true
})

afterEach(() => {
  process.stdin.isTTY = realIsTTY
  vi.restoreAllMocks()
})

describe('ask_user tool', () => {
  it('has correct name', () => {
    expect(askUserTool().name).toBe('ask_user')
  })

  it('single-select returns selected label', async () => {
    mockedSelect.mockResolvedValue('Option A')
    const out = await askUserTool().execute(
      {
        questions: [
          {
            question: 'Pick one',
            header: 'Choice',
            options: [
              { label: 'Option A', description: 'first' },
              { label: 'Option B', description: 'second' },
            ],
          },
        ],
      },
      ctx,
    )
    expect(out).toContain('"Pick one"="Option A"')
  })

  it('multi-select returns selected labels', async () => {
    mockedMultiselect.mockResolvedValue(['Option A', 'Option C'])
    const out = await askUserTool().execute(
      {
        questions: [
          {
            question: 'Pick some',
            header: 'Multi',
            multiple: true,
            options: [
              { label: 'Option A', description: '' },
              { label: 'Option B', description: '' },
              { label: 'Option C', description: '' },
            ],
          },
        ],
      },
      ctx,
    )
    expect(out).toContain('"Pick some"="Option A, Option C"')
  })

  it('cancel returns Unanswered', async () => {
    const cancel = Symbol.for('clack:cancel')
    mockedSelect.mockResolvedValue(cancel)
    const out = await askUserTool().execute(
      {
        questions: [
          {
            question: 'Pick',
            header: 'X',
            options: [{ label: 'A', description: '' }],
          },
        ],
      },
      ctx,
    )
    expect(out).toContain('"Pick"="Unanswered"')
  })

  it('custom text returns typed answer', async () => {
    // First call: select shows options, user picks "Type your own answer"
    mockedSelect.mockResolvedValue('__custom__')
    // Second call: text prompt returns typed value
    mockedText.mockResolvedValue('my custom answer')
    const out = await askUserTool().execute(
      {
        questions: [
          {
            question: 'Pick or type',
            header: 'Custom',
            options: [{ label: 'Option A', description: '' }],
            custom: true,
          },
        ],
      },
      ctx,
    )
    expect(out).toContain('"Pick or type"="my custom answer"')
  })

  it('custom disabled does not add type-your-own option', async () => {
    mockedSelect.mockResolvedValue('Option A')
    await askUserTool().execute(
      {
        questions: [
          {
            question: 'Pick',
            header: 'No custom',
            custom: false,
            options: [{ label: 'Option A', description: '' }],
          },
        ],
      },
      ctx,
    )
    const callArgs = mockedSelect.mock.calls[0]![0]!
    expect(callArgs.options).toHaveLength(1)
    expect(callArgs.options[0]!.value).toBe('Option A')
  })

  it('multiple questions are asked sequentially', async () => {
    mockedSelect.mockResolvedValueOnce('A').mockResolvedValueOnce('B')
    const out = await askUserTool().execute(
      {
        questions: [
          {
            question: 'First',
            header: 'Q1',
            options: [{ label: 'A', description: '' }],
          },
          {
            question: 'Second',
            header: 'Q2',
            options: [{ label: 'B', description: '' }],
          },
        ],
      },
      ctx,
    )
    expect(out).toContain('"First"="A"')
    expect(out).toContain('"Second"="B"')
    expect(mockedSelect).toHaveBeenCalledTimes(2)
  })

  it('validates schema rejects invalid input', async () => {
    const res = await import('../../src/agent/exec.ts').then((m) =>
      m.runTool(
        {
          id: 'c',
          name: 'ask_user',
          arguments: JSON.stringify({ questions: 'not an array' }),
        },
        askUserTool(),
        ctx,
      ),
    )
    expect(res.ok).toBe(false)
  })
})

describe('ask_user without an interactive terminal', () => {
  // A refusal is a failure: returning the explanation as a successful result
  // let the model treat it as an answer and counted the turn as a completed
  // call.
  it('fails instead of hanging on a non-TTY stdin', async () => {
    process.stdin.isTTY = false
    await expect(
      askUserTool().execute(
        {
          questions: [
            {
              question: 'Pick one',
              header: 'Choice',
              options: [{ label: 'A', description: 'first' }],
            },
          ],
        },
        ctx,
      ),
    ).rejects.toThrow('no interactive terminal')
    expect(mockedSelect).not.toHaveBeenCalled()
  })

  it('reaches the model as ok:false via runTool', async () => {
    process.stdin.isTTY = false
    const { runTool } = await import('../../src/agent/exec.ts')
    const res = await runTool(
      {
        id: 'c',
        name: 'ask_user',
        arguments: JSON.stringify({
          questions: [
            {
              question: 'Pick one',
              header: 'Choice',
              options: [{ label: 'A', description: 'first' }],
            },
          ],
        }),
      },
      askUserTool(),
      ctx,
    )
    expect(res.ok).toBe(false)
    expect(res.output).toContain('no interactive terminal')
  })
})

// Without the signal, an abort mid-prompt leaves the terminal in raw mode with
// clack's keypress listener attached: runTool gives up on the promise, but
// nothing detaches them. @clack/core's Prompt closes itself on abort, which is
// what releases them — so the signal has to reach every prompt, including the
// follow-up text() for a custom answer.
describe('ask_user cancellation', () => {
  const oneQuestion = {
    questions: [
      {
        question: 'Pick one',
        header: 'Choice',
        options: [{ label: 'A', description: 'first' }],
      },
    ],
  }

  it('passes ctx.signal to select', async () => {
    mockedSelect.mockResolvedValue('A')
    const ac = new AbortController()
    await askUserTool().execute(oneQuestion, { ...ctx, signal: ac.signal })
    expect(mockedSelect).toHaveBeenCalledWith(
      expect.objectContaining({ signal: ac.signal }),
    )
  })

  it('passes ctx.signal to the custom-answer prompt too', async () => {
    mockedSelect.mockResolvedValue('__custom__')
    mockedText.mockResolvedValue('typed')
    const ac = new AbortController()
    await askUserTool().execute(oneQuestion, { ...ctx, signal: ac.signal })
    expect(mockedText).toHaveBeenCalledWith(
      expect.objectContaining({ signal: ac.signal }),
    )
  })

  it('passes ctx.signal to multiselect', async () => {
    mockedMultiselect.mockResolvedValue([])
    const ac = new AbortController()
    await askUserTool().execute(
      { questions: [{ ...oneQuestion.questions[0]!, multiple: true }] },
      { ...ctx, signal: ac.signal },
    )
    expect(mockedMultiselect).toHaveBeenCalledWith(
      expect.objectContaining({ signal: ac.signal }),
    )
  })

  // An aborted prompt resolves as a cancel, which the tool reports as
  // "Unanswered" — the same as a user pressing Esc.
  it('records an aborted prompt as Unanswered', async () => {
    mockedSelect.mockResolvedValue(Symbol.for('clack:cancel'))
    const ac = new AbortController()
    const out = await askUserTool().execute(oneQuestion, {
      ...ctx,
      signal: ac.signal,
    })
    expect(out).toContain('"Pick one"="Unanswered"')
  })
})
