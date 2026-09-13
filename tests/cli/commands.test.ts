import { describe, it, expect } from 'vitest'
import {
  createCommands,
  SLASH_COMMANDS,
  parseCommand,
} from '../../src/cli/commands.ts'

describe('command registry', () => {
  it('exposes every command plus aliases for completion', () => {
    for (const name of [
      'help',
      'version',
      'model',
      'reset',
      'tools',
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

  it('resolves an alias to the same definition as its canonical name', () => {
    const r = createCommands()
    expect(r.get('todo')).toBe(r.get('tasks'))
    // list() yields canonical commands only, so the alias is not double-listed.
    const names = r.list().map((c) => c.name)
    expect(names).toContain('tasks')
    expect(names).not.toContain('todo')
  })

  it('derives listings from one source (no separate description map)', () => {
    const r = createCommands()
    for (const c of r.list()) {
      expect(c.description.length).toBeGreaterThan(0)
    }
    // names() includes both canonical names and aliases for tab completion.
    expect(r.names()).toEqual(expect.arrayContaining(['tasks', 'todo']))
  })

  it('misses unknown commands instead of throwing', () => {
    const r = createCommands()
    expect(r.get('nope')).toBeUndefined()
  })

  it('parseCommand normalizes only the command name, not the args', () => {
    expect(parseCommand('/Key set OPENAI x')).toEqual({
      name: 'key',
      args: 'set OPENAI x',
    })
    expect(parseCommand('not-a-command')).toBeNull()
  })
})
