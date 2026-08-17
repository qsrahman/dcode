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
})
