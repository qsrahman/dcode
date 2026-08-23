import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  taskCreateTool,
  taskListTool,
  taskUpdateTool,
} from '../../src/tools/local/task.ts'
import type { ToolContext } from '../../src/agent/types.ts'
import { runTool } from '../../src/agent/run.ts'
import { TaskStore } from '../../src/agent/tasks.ts'
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

describe('task tools', () => {
  it('task_create returns the new id and stores it', async () => {
    const out = await taskCreateTool(store).execute({ title: 'do thing' }, ctx)
    expect(out).toBe('created T1: do thing')
    expect(store.list().map((t) => t.id)).toEqual(['T1'])
  })

  it('task_create records blockers', async () => {
    await taskCreateTool(store).execute({ title: 'dep' }, ctx)
    const t = await taskCreateTool(store).execute(
      { title: 'next', blockedBy: ['T1'] },
      ctx,
    )
    expect(t).toBe('created T2: next')
    expect(store.get('T2')?.blockedBy).toEqual(['T1'])
  })

  it('task_list renders ids, statuses, and blockers', async () => {
    await taskCreateTool(store).execute({ title: 'a' }, ctx)
    await taskCreateTool(store).execute({ title: 'b', blockedBy: ['T1'] }, ctx)
    await taskUpdateTool(store).execute({ id: 'T1', status: 'completed' }, ctx)
    const out = await taskListTool(store).execute({}, ctx)
    expect(out).toContain('T1  [completed]  a')
    expect(out).toContain('T2  [pending]  b (blocked by T1)')
  })

  it('task_list reports an empty list', async () => {
    expect(await taskListTool(store).execute({}, ctx)).toBe('(no tasks)')
  })

  it('task_update changes status and notes', async () => {
    await taskCreateTool(store).execute({ title: 'x' }, ctx)
    const out = await taskUpdateTool(store).execute(
      { id: 'T1', status: 'in_progress', notes: 'on it' },
      ctx,
    )
    expect(out).toBe('updated T1: [in_progress] x')
    expect(store.get('T1')?.notes).toBe('on it')
  })

  it('task_update rejects an unknown id', async () => {
    const out = await taskUpdateTool(store).execute(
      { id: 'T9', status: 'completed' },
      ctx,
    )
    expect(out).toBe('no such task: T9')
  })

  it('task_update rejects an invalid status via schema', async () => {
    await taskCreateTool(store).execute({ title: 'x' }, ctx)
    const res = await runTool(
      {
        id: 'c',
        name: 'task_update',
        arguments: JSON.stringify({ id: 'T1', status: 'weird' }),
      },
      taskUpdateTool(store),
      ctx,
    )
    expect(res.ok).toBe(false)
    expect(res.output.length).toBeGreaterThan(0)
  })
})
