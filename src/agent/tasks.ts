export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'blocked'

export interface Task {
  id: string
  title: string
  status: TaskStatus
  blockedBy: string[]
  notes?: string
}

// In-session task list: the model creates/lists/updates tasks to plan and track
// work. No persistence — the list lives for the run and is reset on `/reset`.
export class TaskStore {
  private seq = 0
  private tasks = new Map<string, Task>()

  create(title: string, blockedBy: string[] = []): Task {
    const id = `T${++this.seq}`
    const task: Task = {
      id,
      title,
      status: 'pending',
      blockedBy: [...blockedBy],
    }
    this.tasks.set(id, task)
    return copyTask(task)
  }

  // create/get/list/update all return copies, never the store's own Task objects —
  // a caller mutating a returned Task directly (e.g. pushing onto its
  // blockedBy array) would silently corrupt the store's state without going
  // through update(), bypassing the single place that's meant to change it.
  get(id: string): Task | undefined {
    const task = this.tasks.get(id)
    return task ? copyTask(task) : undefined
  }

  list(): Task[] {
    return [...this.tasks.values()].map(copyTask)
  }

  update(
    id: string,
    patch: Partial<Pick<Task, 'title' | 'status' | 'notes' | 'blockedBy'>>,
  ): Task | undefined {
    const task = this.tasks.get(id)
    if (!task) return undefined
    if (patch.title !== undefined) task.title = patch.title
    if (patch.status !== undefined) task.status = patch.status
    if (patch.notes !== undefined) task.notes = patch.notes
    if (patch.blockedBy !== undefined) task.blockedBy = patch.blockedBy
    return copyTask(task)
  }
}

function copyTask(task: Task): Task {
  return { ...task, blockedBy: [...task.blockedBy] }
}
