import { describe, expect, it, vi } from 'vitest'
import { createLogger } from '../../src/util/log.ts'
import { TaskStore } from '../../src/agent/types.ts'
import { cfg, fakeClient } from '../helpers.ts'

// Records how runOneShot builds its ContextManager. Compaction can't be driven
// through a one-shot run (it cuts at user prompts and a one-shot history has
// only one), so the wiring is checked at the constructor.
const built: unknown[][] = []
vi.mock('../../src/agent/context/manager.ts', async (importOriginal) => {
  const mod =
    await importOriginal<typeof import('../../src/agent/context/manager.ts')>()
  class SpyContextManager extends mod.ContextManager {
    constructor(...args: ConstructorParameters<typeof mod.ContextManager>) {
      super(...args)
      built.push(args)
    }
  }
  return { ...mod, ContextManager: SpyContextManager }
})

const { runOneShot } = await import('../../src/agent/loop.ts')

describe('runOneShot context wiring', () => {
  it("gives the session's task store to the ContextManager so compaction sees the plan", async () => {
    built.length = 0
    const config = cfg()
    const tasks = new TaskStore()
    await runOneShot(fakeClient('done'), config, 'hi', {
      logger: createLogger(config),
      sink: { write() {} },
      tasks,
    })
    expect(built).toHaveLength(1)
    expect(built[0]![2]).toBe(tasks)
  })

  it('works without a task store', async () => {
    built.length = 0
    const config = cfg()
    await runOneShot(fakeClient('done'), config, 'hi', {
      logger: createLogger(config),
      sink: { write() {} },
    })
    expect(built[0]![2]).toBeUndefined()
  })
})
