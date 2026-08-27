import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { todoTool } from '../../src/tools/local/task.ts'
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

describe('todo tool', () => {
  it('add returns the new id and stores it', async () => {
    const out = await todoTool(store).execute(
      { action: 'add', title: 'do thing' },
      ctx,
    )
    expect(out).toBe('created T1: do thing')
    expect(store.list().map((t) => t.id)).toEqual(['T1'])
  })

  it('add records blockers', async () => {
    await todoTool(store).execute({ action: 'add', title: 'dep' }, ctx)
    const t = await todoTool(store).execute(
      { action: 'add', title: 'next', blockedBy: ['T1'] },
      ctx,
    )
    expect(t).toBe('created T2: next')
    expect(store.get('T2')?.blockedBy).toEqual(['T1'])
  })

  it('add requires a title', async () => {
    expect(await todoTool(store).execute({ action: 'add' }, ctx)).toBe(
      'error: add requires a title',
    )
  })

  it('list renders ids, statuses, and blockers', async () => {
    await todoTool(store).execute({ action: 'add', title: 'a' }, ctx)
    await todoTool(store).execute(
      { action: 'add', title: 'b', blockedBy: ['T1'] },
      ctx,
    )
    await todoTool(store).execute(
      { action: 'update', id: 'T1', status: 'completed' },
      ctx,
    )
    const out = await todoTool(store).execute({ action: 'list' }, ctx)
    expect(out).toContain('T1  [completed]  a')
    expect(out).toContain('T2  [pending]  b (blocked by T1)')
  })

  it('list reports an empty list', async () => {
    expect(await todoTool(store).execute({ action: 'list' }, ctx)).toBe(
      '(no tasks)',
    )
  })

  it('update changes status and notes', async () => {
    await todoTool(store).execute({ action: 'add', title: 'x' }, ctx)
    const out = await todoTool(store).execute(
      { action: 'update', id: 'T1', status: 'in_progress', notes: 'on it' },
      ctx,
    )
    expect(out).toBe('updated T1: [in_progress] x')
    expect(store.get('T1')?.notes).toBe('on it')
  })

  it('update requires an id', async () => {
    expect(
      await todoTool(store).execute(
        { action: 'update', status: 'completed' },
        ctx,
      ),
    ).toBe('error: update requires an id')
  })

  it('done marks a task completed', async () => {
    await todoTool(store).execute({ action: 'add', title: 'x' }, ctx)
    const out = await todoTool(store).execute({ action: 'done', id: 'T1' }, ctx)
    expect(out).toBe('updated T1: [completed] x')
    expect(store.get('T1')?.status).toBe('completed')
  })

  it('update/done reject an unknown id', async () => {
    expect(
      await todoTool(store).execute(
        { action: 'update', id: 'T9', status: 'completed' },
        ctx,
      ),
    ).toBe('no such task: T9')
    expect(
      await todoTool(store).execute({ action: 'done', id: 'T9' }, ctx),
    ).toBe('no such task: T9')
  })

  it('rejects an invalid status via schema', async () => {
    await todoTool(store).execute({ action: 'add', title: 'x' }, ctx)
    const res = await runTool(
      {
        id: 'c',
        name: 'todo',
        arguments: JSON.stringify({
          action: 'update',
          id: 'T1',
          status: 'weird',
        }),
      },
      todoTool(store),
      ctx,
    )
    expect(res.ok).toBe(false)
    expect(res.output.length).toBeGreaterThan(0)
  })
})
