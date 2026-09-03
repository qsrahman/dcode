import { describe, expect, it } from 'vitest'
import { createLocalTools } from '../../src/tools/index.ts'
import { TaskStore } from '../../src/agent/tasks.ts'

// A pure assembly smoke test: nothing here exercises any tool's behavior
// (that's covered per-tool elsewhere), just that createLocalTools wires up
// every intended built-in tool under its expected name with no accidental
// gaps or collisions. A renamed export, a forgotten registration, or two
// tools accidentally sharing a name would all slip past typecheck (the
// ToolRegistry constructor's signature doesn't encode which names it should
// contain) but show up here.
describe('createLocalTools', () => {
  it('registers exactly the expected set of built-in tools, once each', () => {
    const registry = createLocalTools(new TaskStore())
    const names = registry.list().map((t) => t.name)
    expect(names.sort()).toEqual(
      [
        'read_file',
        'list_dir',
        'grep',
        'stat',
        'glob',
        'write_file',
        'edit_file',
        'move_file',
        'copy_file',
        'delete_file',
        'make_dir',
        'run_shell',
        'run_process',
        'read_process',
        'kill_process',
        'web_search',
        'web_fetch',
        'todo',
      ].sort(),
    )
    // No accidental name collision silently overwriting an earlier
    // registration (ToolRegistry.register keys by name in a Map).
    expect(new Set(names).size).toBe(names.length)
  })

  it('converts to Responses tool schemas without throwing', () => {
    const registry = createLocalTools(new TaskStore())
    const tools = registry.toResponsesTools()
    expect(tools).toHaveLength(registry.list().length)
    for (const t of tools) {
      expect(t.type).toBe('function')
      if (t.type === 'function') expect(typeof t.name).toBe('string')
    }
  })

  it('the todo tool closes over the given TaskStore, not a shared default', () => {
    const store = new TaskStore()
    const registry = createLocalTools(store)
    const todo = registry.get('todo')!
    const ctx = { root: '/tmp', config: undefined, logger: undefined } as never
    return todo.execute({ action: 'add', title: 'x' }, ctx).then(() => {
      expect(store.list()).toHaveLength(1)
    })
  })
})
