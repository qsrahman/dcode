import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { todoTool } from '../../src/tools/local/todo.ts'
import type { ToolContext } from '../../src/agent/types.ts'
import { runTool } from '../../src/agent/run.ts'
import { TaskStore } from '../../src/agent/todo-store.ts'
import { cfg } from '../helpers.ts'
import { createLogger } from '../../src/util/log.ts'

let root: string
let ctx: ToolContext
let store: TaskStore

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dcode-task-'))
  store = new TaskStore()
  ctx = { root, config: cfg(), logger: createLogger(cfg()) }
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('todowrite tool', () => {
  it('replaces the full todo list', async () => {
    const todos = [
      {
        content: 'task a',
        status: 'pending' as const,
        priority: 'high' as const,
      },
      {
        content: 'task b',
        status: 'in_progress' as const,
        priority: 'medium' as const,
      },
    ]
    const out = await todoTool(store).execute({ todos }, ctx)
    const parsed = JSON.parse(out)
    expect(parsed).toEqual(todos)
    expect(store.list()).toEqual(todos)
  })

  it('returns empty list', async () => {
    const out = await todoTool(store).execute({ todos: [] }, ctx)
    expect(JSON.parse(out)).toEqual([])
    expect(store.list()).toEqual([])
  })

  it('overwrites previous list on each call', async () => {
    await todoTool(store).execute(
      {
        todos: [{ content: 'first', status: 'pending', priority: 'low' }],
      },
      ctx,
    )
    expect(store.list()).toHaveLength(1)

    await todoTool(store).execute(
      {
        todos: [
          { content: 'second', status: 'completed', priority: 'high' },
          { content: 'third', status: 'pending', priority: 'medium' },
        ],
      },
      ctx,
    )
    expect(store.list()).toHaveLength(2)
    expect(store.list()[0]!.content).toBe('second')
  })

  it('validates status enum via schema', async () => {
    const res = await runTool(
      {
        id: 'c',
        name: 'todowrite',
        arguments: JSON.stringify({
          todos: [{ content: 'x', status: 'weird', priority: 'high' }],
        }),
      },
      todoTool(store),
      ctx,
    )
    expect(res.ok).toBe(false)
  })

  it('validates priority enum via schema', async () => {
    const res = await runTool(
      {
        id: 'c',
        name: 'todowrite',
        arguments: JSON.stringify({
          todos: [{ content: 'x', status: 'pending', priority: 'urgent' }],
        }),
      },
      todoTool(store),
      ctx,
    )
    expect(res.ok).toBe(false)
  })

  it('copies todos — external mutation does not affect store', async () => {
    const todos = [
      {
        content: 'task',
        status: 'pending' as const,
        priority: 'medium' as const,
      },
    ]
    await todoTool(store).execute({ todos }, ctx)
    todos[0]!.content = 'mutated'
    expect(store.list()[0]!.content).toBe('task')
  })
})
