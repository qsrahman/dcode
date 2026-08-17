import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  ToolRegistry,
  toResponsesTool,
  zodToJsonSchema,
} from '../../src/tools/registry.ts'

describe('ToolRegistry', () => {
  it('registers, lists and looks up by name', () => {
    const r = new ToolRegistry()
    const t = {
      name: 'x',
      description: 'd',
      parameters: z.object({}),
      execute: async () => '',
    }
    r.register(t)
    expect(r.get('x')).toBe(t)
    expect(r.list()).toHaveLength(1)
    expect(r.get('nope')).toBeUndefined()
  })

  it('converts to Responses tools with strict:false', () => {
    const tool = {
      name: 'read_file',
      description: 'reads',
      parameters: z.object({ path: z.string() }),
      execute: async () => '',
    }
    const rt = toResponsesTool(tool) as any
    expect(rt.type).toBe('function')
    expect(rt.name).toBe('read_file')
    expect(rt.strict).toBe(false)
    expect(rt.parameters.type).toBe('object')
    expect(rt.parameters.properties.path.type).toBe('string')
    expect(rt.parameters.required).toEqual(['path'])
  })
})

describe('zodToJsonSchema', () => {
  it('handles nested objects, optional, enum, array', () => {
    const s = z.object({
      a: z.string(),
      b: z.number().optional(),
      c: z.enum(['x', 'y']),
      d: z.array(z.string()),
    })
    const j = zodToJsonSchema(s) as any
    expect(j.type).toBe('object')
    expect(j.required).toEqual(['a', 'c', 'd'])
    expect(j.properties.b.type).toBe('number')
    expect(j.properties.c.enum).toEqual(['x', 'y'])
    expect(j.properties.d.type).toBe('array')
  })
})
