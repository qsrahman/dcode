import { z } from 'zod'
import type { ToolDefinition } from '../agent/types.ts'
import type { Tool as ResponsesTool } from 'openai/resources/responses/responses'

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>()
  private responsesCache?: ResponsesTool[]

  constructor(tools: ToolDefinition[] = []) {
    for (const t of tools) this.register(t)
  }

  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool)
    this.responsesCache = undefined
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name)
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()]
  }

  // Converted once per registry: tool schemas are static for a session, and
  // runAgent rebuilds nothing now that the registry is created once upstream.
  toResponsesTools(): ResponsesTool[] {
    if (!this.responsesCache) {
      this.responsesCache = this.list().map(toResponsesTool)
    }
    return this.responsesCache
  }
}

// zod v4's built-in converter emits a JSON Schema (draft 2020-12) that the
// Responses API accepts; strict:false keeps arg parsing lenient.
export function toResponsesTool(tool: ToolDefinition): ResponsesTool {
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: z.toJSONSchema(tool.parameters),
    strict: false,
  } as ResponsesTool
}
