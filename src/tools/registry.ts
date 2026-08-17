import { z } from 'zod'
import type { Tool } from '../agent/types.ts'
import type { Tool as ResponsesTool } from 'openai/resources/responses/responses'

export class ToolRegistry {
  private tools = new Map<string, Tool>()

  register(tool: Tool): void {
    this.tools.set(tool.name, tool)
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name)
  }

  list(): Tool[] {
    return [...this.tools.values()]
  }

  toResponsesTools(): ResponsesTool[] {
    return this.list().map(toResponsesTool)
  }
}

// zod v4's built-in converter emits a JSON Schema (draft 2020-12) that the
// Responses API accepts; strict:false keeps arg parsing lenient.
export function toResponsesTool(tool: Tool): ResponsesTool {
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: z.toJSONSchema(tool.parameters),
    strict: false,
  } as ResponsesTool
}
