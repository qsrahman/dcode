import { z } from 'zod/v4'
import type { ToolContext, ToolDefinition } from '../agent/types.ts'
import type { Tool as ResponsesTool } from 'openai/resources/responses/responses'

// Build a ToolDefinition whose argument type is *derived* from its zod schema
// rather than declared alongside it. Without this every tool spelled its
// parameter shape twice — once as an explicit `ToolDefinition<{...}>`
// annotation and once as the schema — with nothing keeping the two in sync,
// and the tools that skipped the annotation fell back to `P = unknown` and
// cast `args as {...}` inside `execute`, which is a plain type hole: the cast
// is unchecked, so a schema change can't surface as a compile error. Here the
// schema is the single source of truth and `execute`'s `args` is inferred
// from it, so a mismatch is a type error at the definition site.
export function defineTool<P>(def: {
  name: string
  description: string
  // Omit (or `true`) for read-only tools, which the loop batches in parallel;
  // `false` forces sequential execution. See ToolDefinition.parallel.
  parallel?: boolean
  parameters: z.ZodType<P>
  // See ToolDefinition.jsonSchema — only MCP-sourced tools pass this.
  jsonSchema?: Record<string, unknown>
  execute(args: P, ctx: ToolContext): Promise<string>
}): ToolDefinition<P> {
  return def
}

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
// Responses API accepts; strict:false keeps arg parsing lenient. A tool that
// already carries a raw JSON Schema (jsonSchema — MCP tools) uses that
// instead of deriving one from `parameters`, since it's the server's own
// authoritative schema, not something dcode defined.
export function toResponsesTool(tool: ToolDefinition): ResponsesTool {
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.jsonSchema ?? z.toJSONSchema(tool.parameters),
    strict: false,
  } as ResponsesTool
}
