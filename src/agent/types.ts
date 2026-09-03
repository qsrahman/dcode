import type { z } from 'zod'
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

export interface ToolDefinition<P = unknown> {
  name: string
  description: string
  parameters: z.ZodType<P>
  execute(args: P, ctx: ToolContext): Promise<string>
  // `false` forces the call to run sequentially (in emission order) rather than
  // being batched with other parallel-eligible calls via Promise.all. Mutating
  // tools set this so side effects don't race; read-only tools default to
  // parallel. This is scheduling only — there is no approval gate.
  parallel?: boolean
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
