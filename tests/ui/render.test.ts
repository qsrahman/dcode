import { describe, expect, it } from 'vitest'
import ansis from 'ansis'
import { renderToolResult } from '../../src/ui/render.ts'

describe('renderToolResult', () => {
  it('shows a check for success and a cross for failure', () => {
    expect(ansis.strip(renderToolResult('read_file', true, 0))).toBe(
      '› read_file: ✓ done (0.0s)',
    )
    expect(ansis.strip(renderToolResult('grep', false, 1200))).toBe(
      '› grep: ✗ done (1.2s)',
    )
  })
})
