import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BASE_SYSTEM_PROMPT,
  buildSystemPrompt,
} from '../../src/agent/system.ts'

const tmpRoots: string[] = []
function tmpRoot(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'dcode-system-'))
  tmpRoots.push(dir)
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(dir, name), text)
  }
  return dir
}
afterEach(() => {
  for (const d of tmpRoots.splice(0)) rmSync(d, { recursive: true })
})

describe('buildSystemPrompt', () => {
  it('uses process.cwd() as the working directory', () => {
    expect(buildSystemPrompt()).toContain(`Working directory: ${process.cwd()}`)
  })

  it('includes the current date so recency guidance is actionable', () => {
    expect(buildSystemPrompt()).toMatch(/Current date: \d{4}-\d{2}-\d{2}/)
  })

  // run_shell shells out to the host, and BSD (macOS) vs GNU (Linux) tools
  // differ, so the model needs to know which it's on.
  it('includes the platform', () => {
    expect(buildSystemPrompt()).toContain(`Platform: ${process.platform}`)
  })

  it('embeds the base instructions', () => {
    expect(buildSystemPrompt()).toContain(BASE_SYSTEM_PROMPT)
  })

  // An empty root: the repo's own AGENTS.md would otherwise be included and
  // trip the tool-name assertions below.
  const prompt = buildSystemPrompt({ root: tmpRoot() })

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

  // run_process/kill_process were already named for their stateful,
  // multi-call workflow; read_process is the third leg of that same
  // workflow (start, poll output, stop) and deserves the same treatment,
  // unlike the plain read-only tools excluded above.
  it('names read_process alongside run_process/kill_process', () => {
    expect(prompt).toContain('read_process')
  })

  it('tells the model to finish, verify, and summarize', () => {
    expect(prompt).toContain('Keep working until the request is fully resolved')
    expect(prompt).toContain("run the project's relevant checks")
    expect(prompt).toContain(
      'End any task that used tools with a short summary',
    )
  })

  // The tool-progress freeze (ui/tools.ts, via onBeforeText) assumes tool
  // turns emit no visible text, so the model is told not to narrate them.
  it('tells the model not to narrate between tool calls', () => {
    expect(prompt).toContain("don't narrate between tool calls")
  })

  // A general sub-agent has `task` denied by policy and rejected again by
  // task.ts's MAX_DEPTH — see subagent.ts's own buildPrompt comment — so
  // instructions telling it to delegate to a sub-agent of its own would be
  // dead, misleading guidance for that role specifically.
  it('omits the Sub-agents section when subagents: false', () => {
    const noSubagents = buildSystemPrompt({ subagents: false, root: tmpRoot() })
    expect(noSubagents).not.toContain('## Sub-agents')
    expect(noSubagents).not.toContain('Use the task tool to delegate')
    // The rest of the prompt is unaffected.
    expect(noSubagents).toContain('## Tool use')
    expect(noSubagents).toContain('## Style')
  })

  it('includes the Sub-agents section by default', () => {
    expect(prompt).toContain('## Sub-agents')
  })

  describe('project instructions', () => {
    it('loads AGENTS.md from the working directory', () => {
      const p = buildSystemPrompt({
        root: tmpRoot({ 'AGENTS.md': 'Use pnpm.' }),
      })
      expect(p).toContain('## Project instructions (AGENTS.md)')
      expect(p).toContain('Use pnpm.')
    })

    it('falls back to CLAUDE.md when there is no AGENTS.md', () => {
      const p = buildSystemPrompt({
        root: tmpRoot({ 'CLAUDE.md': 'Use yarn.' }),
      })
      expect(p).toContain('## Project instructions (CLAUDE.md)')
      expect(p).toContain('Use yarn.')
    })

    it('prefers AGENTS.md and ignores CLAUDE.md when both exist', () => {
      const p = buildSystemPrompt({
        root: tmpRoot({
          'AGENTS.md': 'from agents',
          'CLAUDE.md': 'from claude',
        }),
      })
      expect(p).toContain('from agents')
      expect(p).not.toContain('from claude')
    })

    it('treats an empty AGENTS.md as absent', () => {
      const p = buildSystemPrompt({
        root: tmpRoot({ 'AGENTS.md': '  \n', 'CLAUDE.md': 'from claude' }),
      })
      expect(p).toContain('from claude')
    })

    it('adds no section when neither file exists', () => {
      expect(buildSystemPrompt({ root: tmpRoot() })).not.toContain(
        'Project instructions',
      )
    })

    it('truncates an oversized file with a note', () => {
      const p = buildSystemPrompt({
        root: tmpRoot({ 'AGENTS.md': 'x'.repeat(40_000) }),
      })
      expect(p).toContain('AGENTS.md truncated at 32000 characters')
      expect(p).not.toContain('x'.repeat(32_001))
    })

    it('is still included for a sub-agent prompt', () => {
      const p = buildSystemPrompt({
        subagents: false,
        root: tmpRoot({ 'AGENTS.md': 'Use pnpm.' }),
      })
      expect(p).toContain('Use pnpm.')
      expect(p).not.toContain('## Sub-agents')
    })

    it('comes after the static sections and before the per-run lines', () => {
      const p = buildSystemPrompt({
        root: tmpRoot({ 'AGENTS.md': 'Use pnpm.' }),
      })
      expect(p.indexOf('## Style')).toBeLessThan(p.indexOf('Use pnpm.'))
      expect(p.indexOf('Use pnpm.')).toBeLessThan(
        p.indexOf('Working directory:'),
      )
    })
  })
})
