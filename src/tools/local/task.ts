import { z } from 'zod'
import type { ToolDefinition } from '../../agent/types.ts'
import type { TaskStore, TaskStatus } from '../../agent/tasks.ts'

const statusEnum = z.enum(['pending', 'in_progress', 'completed', 'blocked'])

export function taskCreateTool(store: TaskStore): ToolDefinition {
  return {
    name: 'task_create',
    description:
      'Add a task to the session task list. Returns the new task id (e.g. T1). Use blockedBy to record dependencies on other tasks.',
    parameters: z.object({
      title: z.string().describe('Short description of the task'),
      blockedBy: z
        .array(z.string())
        .optional()
        .describe(
          'Ids of tasks that must finish before this one (e.g. ["T1"])',
        ),
    }),
    async execute({ title, blockedBy }) {
      const task = store.create(title, blockedBy ?? [])
      return `created ${task.id}: ${task.title}`
    },
  }
}

export function taskListTool(store: TaskStore): ToolDefinition {
  return {
    name: 'task_list',
    description:
      'List all tasks in the session with their id, status, and blockers. Call this to see outstanding work.',
    parameters: z.object({}),
    async execute() {
      const tasks = store.list()
      if (tasks.length === 0) return '(no tasks)'
      return tasks
        .map((t) => {
          const blocker = t.blockedBy.length
            ? ` (blocked by ${t.blockedBy.join(', ')})`
            : ''
          const note = t.notes ? ` — ${t.notes}` : ''
          return `${t.id}  [${t.status}]  ${t.title}${blocker}${note}`
        })
        .join('\n')
    },
  }
}

export function taskUpdateTool(store: TaskStore): ToolDefinition {
  return {
    name: 'task_update',
    description:
      'Update a task: change its status, title, or notes, or record blockers. Returns the updated task.',
    parameters: z.object({
      id: z.string().describe('Task id to update, e.g. T1'),
      status: statusEnum
        .optional()
        .describe('New status: pending, in_progress, completed, or blocked'),
      title: z.string().optional().describe('Replace the task title'),
      notes: z.string().optional().describe('Attach a note to the task'),
      blockedBy: z
        .array(z.string())
        .optional()
        .describe('Replace the blocker ids'),
    }),
    async execute({ id, status, title, notes, blockedBy }) {
      const updated = store.update(id, {
        status,
        title,
        notes,
        blockedBy,
      } as Partial<{
        title: string
        status: TaskStatus
        notes: string
        blockedBy: string[]
      }>)
      if (!updated) return `no such task: ${id}`
      return `updated ${updated.id}: [${updated.status}] ${updated.title}`
    },
  }
}
