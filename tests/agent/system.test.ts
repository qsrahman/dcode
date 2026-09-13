import { describe, expect, it } from 'vitest'
import {
  BASE_SYSTEM_PROMPT,
  buildSystemPrompt,
} from '../../src/agent/system.ts'

describe('buildSystemPrompt', () => {
  it('uses process.cwd() as the working directory', () => {
    expect(buildSystemPrompt()).toContain(`Working directory: ${process.cwd()}`)
  })

  it('includes the current date so recency guidance is actionable', () => {
    expect(buildSystemPrompt()).toMatch(/Current date: \d{4}-\d{2}-\d{2}/)
  })

  it('embeds the base instructions', () => {
    expect(buildSystemPrompt()).toContain(BASE_SYSTEM_PROMPT)
  })

  const prompt = buildSystemPrompt()

  it('tells the model to use its (system-supplied) tools', () => {
    expect(prompt).toContain('tools')
    expect(prompt).toContain('Inspect with tools before you change anything')
  })

  it('does not enumerate tools in the prompt (the SDK supplies them)', () => {
    expect(prompt).not.toContain('read_file')
    expect(prompt).not.toContain('list_dir')
    expect(prompt).not.toContain('grep')
    expect(prompt).not.toContain('stat')
    expect(prompt).not.toContain('glob')
  })

  it('states the inspect-and-modify scope accurately', () => {
    expect(prompt).toContain('Inspect with tools before you change anything')
    expect(prompt).toContain('edit_file')
    expect(prompt).toContain('run_shell')
  })

  it('no longer claims the agent is read-only', () => {
    expect(prompt).not.toContain('read-only')
    expect(prompt).not.toContain('cannot modify files')
  })

  // The terminal can't render LaTeX/KaTeX ($...$, \frac{}{}), so the model
  // is told to write math in Unicode instead.
  it('tells the model to write math in Unicode, not LaTeX', () => {
    expect(prompt).toContain('Unicode')
    expect(prompt).toContain('LaTeX')
  })
})
