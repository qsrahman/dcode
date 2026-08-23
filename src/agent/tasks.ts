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
    const task: Task = { id, title, status: 'pending', blockedBy }
    this.tasks.set(id, task)
    return task
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id)
  }

  list(): Task[] {
    return [...this.tasks.values()]
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
    return task
  }
}
