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

// Minimal hand-rolled zod -> JSON Schema converter covering the subset our
// tools use (no new dependency). strict:false keeps arg parsing lenient.
export function zodToJsonSchema(schema: any): JsonSchema {
  if (schema instanceof z.ZodString) return { type: 'string' }
  if (schema instanceof z.ZodNumber) return { type: 'number' }
  if (schema instanceof z.ZodBoolean) return { type: 'boolean' }
  if (schema instanceof z.ZodEnum) {
    return { type: 'string', enum: Object.keys(schema._zod.def.entries) }
  }
  if (schema instanceof z.ZodArray) {
    return { type: 'array', items: zodToJsonSchema(schema._zod.def.element) }
  }
  if (schema instanceof z.ZodOptional) {
    return zodToJsonSchema(schema._zod.def.innerType)
  }
  if (schema instanceof z.ZodDefault) {
    return zodToJsonSchema(schema._zod.def.innerType)
  }
  if (schema instanceof z.ZodObject) {
    const shape = schema._zod.def.shape as Record<string, z.ZodType>
    const properties: Record<string, JsonSchema> = {}
    const required: string[] = []
    for (const [key, value] of Object.entries(shape)) {
      properties[key] = zodToJsonSchema(value)
      if (
        !(value instanceof z.ZodOptional) &&
        !(value instanceof z.ZodDefault)
      ) {
        required.push(key)
      }
    }
    return {
      type: 'object',
      properties,
      required: required.length ? required : undefined,
      additionalProperties: false,
    }
  }
  return {}
}

export function toResponsesTool(tool: Tool): ResponsesTool {
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: zodToJsonSchema(tool.parameters),
    strict: false,
  } as ResponsesTool
}

type JsonSchema = {
  type?: string
  description?: string
  enum?: string[]
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  additionalProperties?: boolean
}
