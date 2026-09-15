import { z } from 'zod/v4'
import { defineTool } from '../registry.ts'
import type { TaskStore } from '../../agent/todo-store.ts'

const todoSchema = z.object({
  content: z.string().describe('Brief description of the task'),
  status: z
    .enum(['pending', 'in_progress', 'completed', 'cancelled'])
    .describe('Current status: pending, in_progress, completed, or cancelled'),
  priority: z
    .enum(['high', 'medium', 'low'])
    .describe('Priority level: high, medium, or low'),
})

export const todoTool = (store: TaskStore) =>
  defineTool({
    name: 'todowrite',
    description: `Create and maintain a structured task list for the current coding session. Tracks progress, organizes multi-step work, and surfaces status to the user.

## When to use
Use proactively when:
- The task requires 3+ distinct steps or actions (not just 3 tool calls for a single conceptual step)
- The work is non-trivial and benefits from planning
- The user provides multiple tasks (numbered or comma-separated) or explicitly asks for a todo list
- New instructions arrive - capture them as todos
- You start a task - mark it \`in_progress\` (only one at a time) before working
- You finish a task - mark it \`completed\` and add any follow-ups discovered during the work

## When NOT to use
Skip when:
- The work is a single, straightforward task (or <3 trivial steps)
- The request is purely informational or conversational
- Tracking adds no organizational value

## States
- \`pending\` - not started
- \`in_progress\` - actively working (exactly ONE at a time)
- \`completed\` - finished successfully
- \`cancelled\` - no longer needed

## Rules
- Update status in real time; don't batch completions
- Mark \`completed\` only after the required work is actually done, including any required verification. Never based on intent.
- Keep exactly one \`in_progress\` while work remains
- If blocked or partial, keep it \`in_progress\` and add a follow-up todo describing the blocker
- Preserve user-provided commands verbatim (flags, args, order)
- Items should be specific and actionable; break large work into smaller steps`,
    parameters: z.object({
      todos: z
        .array(todoSchema)
        .describe('The updated todo list (send the full list each time)'),
    }),
    async execute({ todos }) {
      store.replace(todos)
      return JSON.stringify(todos, null, 2)
    },
  })
