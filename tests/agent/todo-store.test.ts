import { describe, expect, it } from 'vitest'
import { TaskStore } from '../../src/agent/todo-store.ts'

describe('TaskStore', () => {
  it('starts with an empty list', () => {
    const s = new TaskStore()
    expect(s.list()).toEqual([])
  })

  it('replaces the list and returns a copy', () => {
    const s = new TaskStore()
    const todos = [
      { content: 'a', status: 'pending' as const, priority: 'high' as const },
      { content: 'b', status: 'completed' as const, priority: 'low' as const },
    ]
    s.replace(todos)
    expect(s.list()).toEqual(todos)
  })

  it('returns copies — external mutation does not affect store', () => {
    const s = new TaskStore()
    s.replace([{ content: 'a', status: 'pending', priority: 'medium' }])
    const list = s.list()
    list[0]!.content = 'mutated'
    expect(s.list()[0]!.content).toBe('a')
  })

  it('second replace overwrites the first', () => {
    const s = new TaskStore()
    s.replace([{ content: 'first', status: 'pending', priority: 'low' }])
    s.replace([
      { content: 'second', status: 'completed', priority: 'high' },
      { content: 'third', status: 'in_progress', priority: 'medium' },
    ])
    expect(s.list()).toHaveLength(2)
    expect(s.list()[0]!.content).toBe('second')
  })
})
