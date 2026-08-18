import { describe, expect, it } from 'vitest'
import { configSchema } from '../../src/config/schema.ts'
import {
  BASE_SYSTEM_PROMPT,
  buildSystemPrompt,
} from '../../src/agent/system.ts'

describe('buildSystemPrompt', () => {
  it('includes the configured root', () => {
    const config = configSchema.parse({ root: '/tmp/work' })
    expect(buildSystemPrompt(config)).toContain('Working directory: /tmp/work')
  })

  it('falls back to process.cwd() when root is unset', () => {
    const config = configSchema.parse({})
    expect(buildSystemPrompt(config)).toContain(
      `Working directory: ${process.cwd()}`,
    )
  })

  it('embeds the base instructions', () => {
    const config = configSchema.parse({})
    expect(buildSystemPrompt(config)).toContain(BASE_SYSTEM_PROMPT)
  })

  const prompt = buildSystemPrompt(configSchema.parse({}))

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
})
