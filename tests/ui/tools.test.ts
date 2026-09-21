import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ToolCategory } from '../../src/agent/types.ts'
import { stripVTControlCharacters } from 'node:util'
import {
  newTally,
  tallyResult,
  renderProgressLine,
  renderCategorySummary,
  createToolProgress,
} from '../../src/ui/tools.ts'

const clean = (s: string) => stripVTControlCharacters(s)

describe('tallyResult', () => {
  it('groups tools by category and counts completions and failures', () => {
    const t = newTally()
    tallyResult(t, 'search', true) // search
    tallyResult(t, 'read', true) // read
    tallyResult(t, 'edit', false) // edit, failed
    tallyResult(t, 'run', true) // run
    expect(t.done).toBe(4)
    expect(t.failed).toBe(1)
    expect(t.counts).toEqual({ search: 1, read: 1, edit: 1, run: 1 })
  })

  it('puts a tool with no category (e.g. MCP) in the run catch-all rather than dropping it', () => {
    const t = newTally()
    tallyResult(t, undefined, true)
    expect(t.counts).toEqual({ run: 1 })
  })
})

describe('renderProgressLine', () => {
  it('omits the count before any tool has finished', () => {
    expect(clean(renderProgressLine(newTally(), 'thinking…', 400, false))).toBe(
      '⋯ thinking… · 0.4s',
    )
  })

  it('shows a running count and the current tool — width independent of call count', () => {
    const t = newTally()
    for (let i = 0; i < 11; i++) tallyResult(t, 'edit', true)
    const line = clean(renderProgressLine(t, 'edit_file', 6200, false))
    expect(line).toBe('⋯ 11 tools · edit_file · 6.2s')
  })

  it('singularizes the count at one tool', () => {
    const t = newTally()
    tallyResult(t, 'search', true)
    expect(clean(renderProgressLine(t, 'grep', 100, false))).toBe(
      '⋯ 1 tool · grep · 0.1s',
    )
  })
})

describe('renderCategorySummary', () => {
  it('summarizes a heavy turn as a bounded set of family segments', () => {
    const t = newTally()
    const add = (c: ToolCategory, k: number) => {
      for (let i = 0; i < k; i++) tallyResult(t, c, true)
    }
    add('search', 3)
    add('read', 6)
    add('edit', 5)
    add('run', 2)
    // Order follows CATEGORY_ORDER (search, read, edit, run, web, plan).
    expect(clean(renderCategorySummary(t, 41600, false))).toBe(
      '3 search · 6 read · 5 edit · 2 run · 41.6s',
    )
  })

  it('appends a failure count only when something failed', () => {
    const t = newTally()
    tallyResult(t, 'read', true)
    tallyResult(t, 'read', true)
    tallyResult(t, 'edit', false)
    expect(clean(renderCategorySummary(t, 4200, false))).toBe(
      '2 read · 1 edit · ✗1 · 4.2s',
    )
  })

  it('omits empty families — a two-tool turn is as short as its content', () => {
    const t = newTally()
    tallyResult(t, 'search', true)
    tallyResult(t, 'read', true)
    expect(clean(renderCategorySummary(t, 1100, false))).toBe(
      '1 search · 1 read · 1.1s',
    )
  })
})

// Live mode is gated on process.stdout.isTTY and not CI, so force both.
describe('createToolProgress — activity line', () => {
  const realIsTTY = process.stdout.isTTY
  const realCI = process.env.CI
  const CLEAR_LINE = '\r\x1b[2K'

  beforeEach(() => {
    delete process.env.CI
  })
  afterEach(() => {
    process.stdout.isTTY = realIsTTY
    if (realCI === undefined) delete process.env.CI
    else process.env.CI = realCI
  })

  function reporter(live: boolean) {
    process.stdout.isTTY = live
    const chunks: string[] = []
    const progress = createToolProgress(
      { write: (t) => void chunks.push(t) },
      { color: false, verbose: false },
    )
    return {
      progress,
      text: () => clean(chunks.join('')),
      raw: () => chunks.join(''),
    }
  }

  it('shows thinking, then erases the line when the answer starts', () => {
    const { progress, text, raw } = reporter(true)
    progress.onActivity({ kind: 'reasoning' })
    expect(text()).toContain('⋯ thinking…')
    progress.freeze() // what runTurn's onBeforeText does at the first text
    expect(raw().endsWith(CLEAR_LINE)).toBe(true)
    // Nothing ran, so no summary line is written.
    expect(text()).not.toMatch(/search|read|edit|run/)
  })

  it('names the tool the model is calling, then folds into the normal summary', () => {
    const { progress, text } = reporter(true)
    progress.onActivity({ kind: 'tool_call', name: 'read_file' })
    expect(text()).toContain('⋯ read_file…')
    progress.onResult({
      id: '1',
      name: 'read_file',
      output: '',
      ok: true,
      ms: 5,
      category: 'read',
    })
    progress.freeze()
    expect(text()).toContain('1 read')
  })

  it('writes nothing off a TTY', () => {
    const { progress, raw } = reporter(false)
    progress.onActivity({ kind: 'reasoning' })
    progress.freeze()
    expect(raw()).toBe('')
  })

  it('freeze with nothing on screen writes nothing', () => {
    const { progress, raw } = reporter(true)
    progress.freeze()
    expect(raw()).toBe('')
  })
})
