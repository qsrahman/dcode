import { describe, expect, it } from 'vitest'
import { stripVTControlCharacters } from 'node:util'
import {
  newTally,
  tallyResult,
  renderProgressLine,
  renderCategorySummary,
} from '../../src/ui/tools.ts'

const clean = (s: string) => stripVTControlCharacters(s)

describe('tallyResult', () => {
  it('groups tools by family and counts completions and failures', () => {
    const t = newTally()
    tallyResult(t, 'grep', true) // search
    tallyResult(t, 'read_file', true) // read
    tallyResult(t, 'edit_file', false) // edit, failed
    tallyResult(t, 'run_shell', true) // run
    expect(t.done).toBe(4)
    expect(t.failed).toBe(1)
    expect(t.counts).toEqual({ search: 1, read: 1, edit: 1, run: 1 })
  })

  it('maps an unknown tool into the run catch-all rather than dropping it', () => {
    const t = newTally()
    tallyResult(t, 'some_future_tool', true)
    expect(t.counts).toEqual({ run: 1 })
  })
})

describe('renderProgressLine', () => {
  it('shows a running count and the current tool — width independent of call count', () => {
    const t = newTally()
    for (let i = 0; i < 11; i++) tallyResult(t, 'edit_file', true)
    const line = clean(renderProgressLine(t, 'edit_file', 6200, false))
    expect(line).toBe('⋯ 11 tools · edit_file · 6.2s')
  })

  it('singularizes the count at one tool', () => {
    const t = newTally()
    tallyResult(t, 'grep', true)
    expect(clean(renderProgressLine(t, 'grep', 100, false))).toBe(
      '⋯ 1 tool · grep · 0.1s',
    )
  })
})

describe('renderCategorySummary', () => {
  it('summarizes a heavy turn as a bounded set of family segments', () => {
    const t = newTally()
    const add = (n: string, k: number) => {
      for (let i = 0; i < k; i++) tallyResult(t, n, true)
    }
    add('grep', 3) // search 3
    add('read_file', 6) // read 6
    add('edit_file', 5) // edit 5
    add('run_shell', 2) // run 2
    // Order follows CATEGORY_ORDER (search, read, edit, run, web, plan).
    expect(clean(renderCategorySummary(t, 41600, false))).toBe(
      '3 search · 6 read · 5 edit · 2 run · 41.6s',
    )
  })

  it('appends a failure count only when something failed', () => {
    const t = newTally()
    tallyResult(t, 'read_file', true)
    tallyResult(t, 'read_file', true)
    tallyResult(t, 'edit_file', false)
    expect(clean(renderCategorySummary(t, 4200, false))).toBe(
      '2 read · 1 edit · ✗1 · 4.2s',
    )
  })

  it('omits empty families — a two-tool turn is as short as its content', () => {
    const t = newTally()
    tallyResult(t, 'grep', true)
    tallyResult(t, 'read_file', true)
    expect(clean(renderCategorySummary(t, 1100, false))).toBe(
      '1 search · 1 read · 1.1s',
    )
  })
})
