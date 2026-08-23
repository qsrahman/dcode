import { describe, expect, it } from 'vitest'
import { TaskStore } from '../../src/agent/tasks.ts'

describe('TaskStore', () => {
  it('creates tasks with sequential ids and pending status', () => {
    const s = new TaskStore()
    const a = s.create('first')
    const b = s.create('second')
    expect(a.id).toBe('T1')
    expect(b.id).toBe('T2')
    expect(a.title).toBe('first')
    expect(a.status).toBe('pending')
    expect(a.blockedBy).toEqual([])
  })

  it('lists tasks in creation order', () => {
    const s = new TaskStore()
    s.create('a')
    s.create('b')
    expect(s.list().map((t) => t.id)).toEqual(['T1', 'T2'])
  })

  it('records blockedBy at creation', () => {
    const s = new TaskStore()
    const dep = s.create('dep')
    const t = s.create('needs dep', [dep.id])
    expect(t.blockedBy).toEqual([dep.id])
  })

  it('updates status, notes, title, and blockers', () => {
    const s = new TaskStore()
    const t = s.create('work')
    const u = s.update(t.id, {
      status: 'in_progress',
      notes: 'doing it',
      blockedBy: ['T9'],
    })
    expect(u?.status).toBe('in_progress')
    expect(u?.notes).toBe('doing it')
    expect(u?.blockedBy).toEqual(['T9'])
  })

  it('returns undefined when updating a missing task', () => {
    const s = new TaskStore()
    expect(s.update('T99', { status: 'completed' })).toBeUndefined()
  })
})
