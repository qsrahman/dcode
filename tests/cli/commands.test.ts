import { describe, it, expect } from 'vitest'
import {
  COMMANDS,
  SLASH_COMMANDS,
  parseCommand,
} from '../../src/cli/commands.ts'

describe('slash commands', () => {
  it('exposes every command plus aliases for completion', () => {
    for (const name of [
      'help',
      'version',
      'model',
      'reset',
      'tools',
      'mcp',
      'clear',
      'compact',
      'context',
      'tasks',
      'todo',
      'config',
      'undo',
      'key',
      'limit',
      'save',
      'exit',
    ]) {
      expect(SLASH_COMMANDS).toContain(name)
    }
  })

  it('lists canonical commands only; aliases are completion-only', () => {
    const names = COMMANDS.map((c) => c.name)
    expect(names).toContain('tasks')
    expect(names).not.toContain('todo')
    expect(SLASH_COMMANDS).toEqual(expect.arrayContaining(['tasks', 'todo']))
  })

  it('gives every command a description', () => {
    for (const c of COMMANDS) {
      expect(c.description.length).toBeGreaterThan(0)
    }
  })

  it('parseCommand normalizes only the command name, not the args', () => {
    expect(parseCommand('/Key set OPENAI x')).toEqual({
      name: 'key',
      args: 'set OPENAI x',
    })
    expect(parseCommand('not-a-command')).toBeNull()
  })
})
