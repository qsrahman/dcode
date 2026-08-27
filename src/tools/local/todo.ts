import { z } from 'zod'
import type { ToolDefinition } from '../../agent/types.ts'
import type { Task, TaskStore } from '../../agent/tasks.ts'

const statusEnum = z.enum(['pending', 'in_progress', 'completed', 'blocked'])

function formatTask(t: Task): string {
  const blocker = t.blockedBy.length
    ? ` (blocked by ${t.blockedBy.join(', ')})`
    : ''
  const note = t.notes ? ` — ${t.notes}` : ''
  return `${t.id}  [${t.status}]  ${t.title}${blocker}${note}`
}

// One tool that wraps the session TaskStore for add/list/update/done, replacing
// the previous task_create / task_list / task_update trio so the model manages
// its plan through a single, well-defined interface.
export function todoTool(store: TaskStore): ToolDefinition {
  return {
    name: 'todo',
    description:
      'Manage the session task list to plan and track multi-step work: add a task, list tasks, update a task (status/title/notes/blockers), or mark one done.',
    parameters: z.object({
      action: z
        .enum(['add', 'list', 'update', 'done'])
        .describe('What to do: add, list, update, or done'),
      title: z.string().optional().describe('Task title (action: add)'),
      id: z
        .string()
        .optional()
        .describe('Task id to update or mark done (action: update, done)'),
      status: statusEnum
        .optional()
        .describe(
          'New status: pending, in_progress, completed, or blocked (action: update)',
        ),
      notes: z.string().optional().describe('Note to attach (action: update)'),
      blockedBy: z
        .array(z.string())
        .optional()
        .describe('Ids of tasks that must finish first (action: add, update)'),
    }),
    async execute({ action, title, id, status, notes, blockedBy }) {
      switch (action) {
        case 'add': {
          if (!title) return 'error: add requires a title'
          const t = store.create(title, blockedBy ?? [])
          return `created ${t.id}: ${t.title}`
        }
        case 'list': {
          const tasks = store.list()
          return tasks.length === 0
            ? '(no tasks)'
            : tasks.map(formatTask).join('\n')
        }
        case 'update': {
          if (!id) return 'error: update requires an id'
          const updated = store.update(id, { status, title, notes, blockedBy })
          return updated
            ? `updated ${updated.id}: [${updated.status}] ${updated.title}`
            : `no such task: ${id}`
        }
        case 'done': {
          if (!id) return 'error: done requires an id'
          const updated = store.update(id, { status: 'completed' })
          return updated
            ? `updated ${updated.id}: [${updated.status}] ${updated.title}`
            : `no such task: ${id}`
        }
      }
      return 'error: unknown action'
    },
  }
}
