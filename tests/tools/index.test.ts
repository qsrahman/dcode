import { describe, expect, it } from 'vitest'
import { z } from 'zod/v4'
import { createLocalTools } from '../../src/tools/index.ts'
import { TaskStore } from '../../src/agent/todo-store.ts'
import type { Client } from '../../src/agent/client.ts'
import { unknownAgentTools } from '../../src/agent/subagent.ts'
import type { ToolDefinition } from '../../src/agent/types.ts'

const mockClient: Client = {
  stream() {
    throw new Error('mock client: not implemented')
  },
}

// A pure assembly smoke test: nothing here exercises any tool's behavior
// (that's covered per-tool elsewhere), just that createLocalTools wires up
// every intended built-in tool under its expected name with no accidental
// gaps or collisions. A renamed export, a forgotten registration, or two
// tools accidentally sharing a name would all slip past typecheck (the
// ToolRegistry constructor's signature doesn't encode which names it should
// contain) but show up here.
describe('createLocalTools', () => {
  it('registers exactly the expected set of built-in tools, once each', () => {
    const registry = createLocalTools(new TaskStore(), mockClient)
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
        'todowrite',
        'ask_user',
        'task',
      ].sort(),
    )
    // No accidental name collision silently overwriting an earlier
    // registration (ToolRegistry.register keys by name in a Map).
    expect(new Set(names).size).toBe(names.length)
  })

  it('converts to Responses tool schemas without throwing', () => {
    const registry = createLocalTools(new TaskStore(), mockClient)
    const tools = registry.toResponsesTools()
    expect(tools).toHaveLength(registry.list().length)
    for (const t of tools) {
      expect(t.type).toBe('function')
      if (t.type === 'function') expect(typeof t.name).toBe('string')
    }
  })

  it('the todowrite tool closes over the given TaskStore, not a shared default', () => {
    const store = new TaskStore()
    const registry = createLocalTools(store, mockClient)
    const todo = registry.get('todowrite')!
    const ctx = { root: '/tmp', config: undefined, logger: undefined } as never
    return todo
      .execute(
        {
          todos: [{ content: 'x', status: 'pending', priority: 'medium' }],
        },
        ctx,
      )
      .then(() => {
        expect(store.list()).toHaveLength(1)
      })
  })
})

// MCP tools (tools/mcp/manager.ts) are connected separately (async, per-
// server fallible) and passed in already-built, rather than connected inside
// createLocalTools itself — these tests stand in for that with a plain
// ToolDefinition, the same shape connectMcpServers produces.
describe('createLocalTools with MCP tools', () => {
  function fakeMcpTool(name: string): ToolDefinition {
    return {
      name,
      description: 'an mcp tool',
      parameters: z.record(z.string(), z.unknown()),
      execute: async () => 'ok',
    }
  }

  it('registers the given MCP tools alongside the built-ins', () => {
    const registry = createLocalTools(new TaskStore(), mockClient, [
      fakeMcpTool('mcp__srv__search'),
    ])
    expect(registry.get('mcp__srv__search')).toBeDefined()
    expect(registry.list()).toHaveLength(21) // 20 built-ins + 1 MCP tool
  })

  it("includes MCP tools in the task tool's own description", () => {
    const registry = createLocalTools(new TaskStore(), mockClient, [
      fakeMcpTool('mcp__srv__search'),
    ])
    // The task tool is registered last specifically so its generated
    // description (describeAgentTypes) reflects tools registered before it —
    // MCP tools included. general's tool set is a deny-list of just ['task'],
    // so a newly connected MCP tool reaches it (and so this description)
    // automatically, the same way any other newly-registered tool does.
    expect(registry.get('task')!.description).toContain('mcp__srv__search')
  })

  it('defaults to no MCP tools when none are given', () => {
    const registry = createLocalTools(new TaskStore(), mockClient)
    expect(registry.list().some((t) => t.name.startsWith('mcp__'))).toBe(false)
  })
})

// The agent-type allow-lists in agent/subagent.ts are matched against the
// registry by name, so a typo there removes a tool from every sub-agent with
// no error at all — how `list_directory` shipped for a tool named `list_dir`.
// createLocalTools now refuses to build a registry in that state.
describe('agent-type tool allow-lists', () => {
  it('name only tools that are actually registered', () => {
    const names = createLocalTools(new TaskStore(), mockClient)
      .list()
      .map((t) => t.name)
    expect(unknownAgentTools(names)).toEqual([])
  })

  it('reports the offenders when a name matches nothing', () => {
    expect(unknownAgentTools(['read_file'])).toContain('explore:grep')
  })
})
