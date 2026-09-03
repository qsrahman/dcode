import { describe, expect, it, vi, beforeEach } from 'vitest'
import { askUserTool } from '../../src/tools/local/question.ts'
import type { ToolContext } from '../../src/agent/types.ts'
import { cfg } from '../helpers.ts'
import { createLogger } from '../../src/util/log.ts'

vi.mock('@clack/prompts', () => ({
  select: vi.fn(),
  multiselect: vi.fn(),
  text: vi.fn(),
  isCancel: (v: unknown) => v === Symbol.for('clack:cancel'),
}))

import { select, multiselect, text } from '@clack/prompts'

const mockedSelect = vi.mocked(select)
const mockedMultiselect = vi.mocked(multiselect)
const mockedText = vi.mocked(text)

let ctx: ToolContext

beforeEach(() => {
  vi.clearAllMocks()
  ctx = { root: '/tmp', config: cfg(), logger: createLogger(cfg()) }
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
    const res = await import('../../src/agent/run.ts').then((m) =>
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
