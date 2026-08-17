import { describe, expect, it } from 'vitest'
import { appConfigSchema } from '../../src/config/schema.ts'
import {
  BASE_SYSTEM_PROMPT,
  buildSystemPrompt,
} from '../../src/agent/system.ts'

describe('buildSystemPrompt', () => {
  it('includes the configured root', () => {
    const config = appConfigSchema.parse({ root: '/tmp/work' })
    expect(buildSystemPrompt(config)).toContain('Working directory: /tmp/work')
  })

  it('falls back to process.cwd() when root is unset', () => {
    const config = appConfigSchema.parse({})
    expect(buildSystemPrompt(config)).toContain(
      `Working directory: ${process.cwd()}`,
    )
  })

  it('embeds the base instructions', () => {
    const config = appConfigSchema.parse({})
    expect(buildSystemPrompt(config)).toContain(BASE_SYSTEM_PROMPT)
  })

  const prompt = buildSystemPrompt(appConfigSchema.parse({}))

  it('tells the model to use its (system-supplied) tools', () => {
    expect(prompt).toContain('tools')
    expect(prompt).toContain('Inspect with tools before you answer')
  })

  it('does not enumerate tools in the prompt (the SDK supplies them)', () => {
    expect(prompt).not.toContain('read_file')
    expect(prompt).not.toContain('list_dir')
    expect(prompt).not.toContain('grep')
    expect(prompt).not.toContain('stat')
    expect(prompt).not.toContain('glob')
  })

  it('states the read-only scope accurately', () => {
    expect(prompt).toContain('read-only')
    expect(prompt).toContain('cannot modify files')
  })

  it('does not claim editing/shell/git are available', () => {
    expect(prompt).not.toContain('reading and editing files')
    expect(prompt).not.toContain('editing files')
  })
})
