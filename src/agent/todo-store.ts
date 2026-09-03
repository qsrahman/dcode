export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'

export type TodoPriority = 'high' | 'medium' | 'low'

export interface Todo {
  content: string
  status: TodoStatus
  priority: TodoPriority
}

// In-session task list: the model replaces the entire list via `todowrite`,
// keeping statuses current as work progresses. No persistence — the list
// lives for the run and is reset on `/reset`.
export class TaskStore {
  private todos: Todo[] = []

  replace(todos: Todo[]): void {
    this.todos = todos.map((t) => ({ ...t }))
  }

  list(): Todo[] {
    return this.todos.map((t) => ({ ...t }))
  }
}
