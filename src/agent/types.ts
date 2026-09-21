import type { z } from 'zod/v4'
import type { Config } from '../config/schema.ts'
import type { Logger } from '../util/log.ts'

export interface ToolContext {
  root: string
  config: Config
  logger: Logger
  // Aborted when the user cancels the turn (Ctrl-C). Tools that spawn processes
  // forward it so the child is killed; runTool also races against it.
  signal?: AbortSignal
  // Nesting depth: 0 = parent agent, 1 = sub-agent, etc. Used by the task
  // tool to enforce the depth limit (sub-agents cannot spawn sub-agents).
  depth?: number
}

// How the terminal groups a tool in the per-query summary (`2 search · 13 read`).
// Purely presentational; scheduling is `parallel`, not this.
export const TOOL_CATEGORIES = [
  'search',
  'read',
  'edit',
  'run',
  'web',
  'plan',
] as const
export type ToolCategory = (typeof TOOL_CATEGORIES)[number]

export interface ToolDefinition<P = unknown> {
  name: string
  description: string
  parameters: z.ZodType<P>
  // Raw JSON Schema to advertise to the Responses API instead of one derived
  // from `parameters` via z.toJSONSchema. Used by MCP tools (tools/mcp/
  // manager.ts): an MCP server already hands back its tool's input schema as
  // JSON Schema, and round-tripping that through a hand-built zod schema back
  // to JSON Schema would be lossy for no benefit — `parameters` there is just
  // a permissive passthrough for runtime parsing, since the MCP server (not
  // dcode) is authoritative on argument shape. Every built-in tool leaves
  // this unset and keeps deriving its schema from `parameters` as before.
  jsonSchema?: Record<string, unknown>
  execute(args: P, ctx: ToolContext): Promise<string>
  // `false` forces the call to run sequentially (in emission order) rather than
  // being batched with other parallel-eligible calls via Promise.all. Mutating
  // tools set this so side effects don't race; read-only tools default to
  // parallel. This is scheduling only — there is no approval gate.
  parallel?: boolean
  // What survives when a result exceeds the byte cap: the `head` (default), or
  // both `ends` with the middle dropped. Command output uses `ends`, because
  // the verdict of a build or test run (the failing assertion) is printed last.
  keep?: 'head' | 'ends'
  // Summary bucket for the terminal (see TOOL_CATEGORIES). Built-in tools all
  // set it (tests/tools/index.test.ts enforces that); a tool without one, such
  // as an MCP tool, is shown under `run`.
  category?: ToolCategory
}

export interface ToolCall {
  id: string
  name: string
  arguments: string
}

export interface ToolResult {
  id: string
  name: string
  output: string
  ok: boolean
  ms: number
  category?: ToolCategory
}

// Structural view of the fields accessed on ResponseInputItem / ResponseOutputItem
// across the codebase. The SDK's discriminated union is precise but verbose to
// cast at every access site; this narrow shape covers what we actually read.
export interface ResponseItemFields {
  type?: string
  role?: string
  content?: unknown
  name?: string
  call_id?: string
  arguments?: string
  output?: unknown
}

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'

export type TodoPriority = 'high' | 'medium' | 'low'

export interface Todo {
  content: string
  status: TodoStatus
  priority: TodoPriority
}

// Injected into history to resume a max_output_tokens-truncated turn. It is a
// user-role item but not a real prompt, so anything counting, undoing, or
// cutting history at prompt boundaries must go through isUserPrompt.
export const CONTINUE_PROMPT = 'Continue.'

export function isUserPrompt(item: object): boolean {
  const it = item as ResponseItemFields
  return it.role === 'user' && it.content !== CONTINUE_PROMPT
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
