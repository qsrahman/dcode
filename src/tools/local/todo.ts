import { z } from 'zod/v4'
import { defineTool } from '../registry.ts'
import type { TaskStore } from '../../agent/types.ts'

const todoSchema = z.object({
  content: z.string().describe('Brief description of the task'),
  status: z
    .enum(['pending', 'in_progress', 'completed', 'cancelled'])
    .describe('Current status'),
  priority: z
    .enum(['high', 'medium', 'low'])
    .optional()
    .describe('Priority (default medium)'),
})

export const todoTool = (store: TaskStore) =>
  defineTool({
    name: 'todowrite',
    category: 'plan',
    description: `Create and update the session's task list to plan and track multi-step work; the user sees it. Send the whole list on every call.

Use it for work with 3 or more distinct steps, for several requests at once, or when asked. Skip it for a single simple step or a purely informational request.

Statuses: pending, in_progress (exactly one at a time while work remains), completed, cancelled. Mark a task in_progress before starting it and completed only once it is done and verified; update as you go rather than in a batch. If blocked, keep the task in_progress and add one for the blocker. Keep tasks specific and actionable, and keep commands the user gave you verbatim.`,
    parameters: z.object({
      todos: z
        .array(todoSchema)
        .describe('The full updated list; it replaces the previous one'),
    }),
    async execute({ todos }) {
      // The store and its readers (/tasks, compaction) want every field, but
      // making the model invent a priority per item bought nothing.
      const full = todos.map((t) => ({
        ...t,
        priority: t.priority ?? 'medium',
      }))
      store.replace(full)
      return JSON.stringify(full, null, 2)
    },
  })
