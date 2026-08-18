import type { z } from 'zod'
import type { AppConfig } from '../config/schema.ts'
import type { Logger } from '../util/log.ts'

export interface ToolContext {
  root: string
  config: AppConfig
  logger: Logger
}

export interface ToolDefinition<P = unknown> {
  name: string
  description: string
  parameters: z.ZodType<P>
  // Mutating tools (write_file/edit_file/run_shell) require permission approval
  // from the harness gate; read-only tools run without prompting.
  mutates?: boolean
  execute(args: P, ctx: ToolContext): Promise<string>
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
