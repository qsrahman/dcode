import { describe, expect, it } from 'vitest'
import { AGENT_TYPES } from '../../src/agent/subagent.ts'
import { cfg } from '../helpers.ts'

describe('AGENT_TYPES prompts', () => {
  // general reuses the base system prompt (unlike explore's own dedicated
  // one below), so it's the one that could accidentally drag in guidance
  // that doesn't apply to a depth-limited sub-agent.
  it("general's prompt omits the Sub-agents section (task is denied, and MAX_DEPTH would reject it anyway)", () => {
    const prompt = AGENT_TYPES.general!.buildPrompt(cfg())
    expect(prompt).not.toContain('## Sub-agents')
    expect(prompt).not.toContain('Use the task tool to delegate')
    // Still gets the rest of the base prompt.
    expect(prompt).toContain('## Tool use')
    expect(prompt).toContain('## Style')
  })

  it("explore's prompt is its own dedicated, self-contained one, not the base prompt", () => {
    const prompt = AGENT_TYPES.explore!.buildPrompt(cfg())
    expect(prompt).toContain('READ-ONLY')
    expect(prompt).not.toContain('## Tool use')
    expect(prompt).not.toContain('## Sub-agents')
  })
})
