import { describe, expect, it } from 'vitest'
import ansis from 'ansis'
import { renderToolResult, renderToolOutput } from '../../src/ui/render.ts'

describe('renderToolResult', () => {
  it('shows a check for success and a cross for failure', () => {
    expect(ansis.strip(renderToolResult('read_file', true, 0))).toBe(
      '› read_file: ✓ done (0.0s)',
    )
    expect(ansis.strip(renderToolResult('grep', false, 1200))).toBe(
      '› grep: ✗ failed (1.2s)',
    )
  })
})

describe('renderToolOutput', () => {
  it('fences the raw output between rules naming the tool', () => {
    const stripped = ansis.strip(renderToolOutput('grep', 'a\nb'))
    expect(stripped).toContain('── grep output ─')
    expect(stripped).toContain('\na\nb\n')
  })
})
