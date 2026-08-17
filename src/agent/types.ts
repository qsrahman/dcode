import type { z } from 'zod'
import type { AppConfig } from '../config/schema.ts'
import type { Logger } from '../util/log.ts'

export interface ToolContext {
  root: string
  config: AppConfig
  logger: Logger
}

export interface Tool {
  name: string
  description: string
  parameters: z.ZodType
  execute(args: unknown, ctx: ToolContext): Promise<string>
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
