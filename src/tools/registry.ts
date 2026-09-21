import { z } from 'zod/v4'
import type {
  ToolCategory,
  ToolContext,
  ToolDefinition,
} from '../agent/types.ts'
import type { FunctionTool } from 'openai/resources/responses/responses'
import { zodResponsesFunction } from 'openai/helpers/zod'

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
  // See ToolDefinition.keep.
  keep?: 'head' | 'ends'
  // See ToolDefinition.category.
  category?: ToolCategory
  parameters: z.ZodType<P>
  // See ToolDefinition.jsonSchema — only MCP-sourced tools pass this.
  jsonSchema?: Record<string, unknown>
  execute(args: P, ctx: ToolContext): Promise<string>
}): ToolDefinition<P> {
  return def
}

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>()
  private responsesCache = new Map<boolean, FunctionTool[]>()

  constructor(tools: ToolDefinition[] = []) {
    for (const t of tools) this.register(t)
  }

  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool)
    this.responsesCache.clear()
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name)
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()]
  }

  // Converted once per registry and mode: tool schemas are static for a session,
  // and runAgent rebuilds nothing now that the registry is created once upstream.
  toResponsesTools(strict = false): FunctionTool[] {
    let tools = this.responsesCache.get(strict)
    if (!tools) {
      tools = this.list().map((t) => toResponsesTool(t, strict))
      this.responsesCache.set(strict, tools)
    }
    return tools
  }
}

// zod v4's built-in converter emits a JSON Schema (draft 2020-12) that the
// Responses API accepts; strict:false keeps arg parsing lenient. A tool that
// already carries a raw JSON Schema (jsonSchema — MCP tools) uses that
// instead of deriving one from `parameters`, since it's the server's own
// authoritative schema, not something dcode defined.
//
// With `strict` (config.strictTools), a built-in tool instead gets the SDK's
// strict schema: every property required, optional ones as `null` unions,
// `additionalProperties: false`. That is why the built-ins declare optional
// arguments with `.nullish()` — under it the model sends `null` for a field it
// doesn't use, and `.optional()` would both fail the SDK's conversion and reject
// that `null`. MCP tools are never made strict: their schemas are the servers',
// and a server may reject the `null` a strict schema asks for.
export function toResponsesTool(
  tool: ToolDefinition,
  strict = false,
): FunctionTool {
  if (strict && !tool.jsonSchema) {
    return zodResponsesFunction({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })
  }
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.jsonSchema ?? z.toJSONSchema(tool.parameters),
    strict: false,
  }
}
