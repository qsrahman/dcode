import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ToolRegistry, toResponsesTool } from '../../src/tools/registry.ts'

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

  it('converts nested objects, optional, enum, array via zod', () => {
    const tool = {
      name: 't',
      description: 'd',
      parameters: z.object({
        a: z.string(),
        b: z.number().optional(),
        c: z.enum(['x', 'y']),
        d: z.array(z.string()),
      }),
      execute: async () => '',
    }
    const p = (toResponsesTool(tool) as any).parameters
    expect(p.type).toBe('object')
    expect(p.required).toEqual(['a', 'c', 'd'])
    expect(p.properties.b.type).toBe('number')
    expect(p.properties.c.enum).toEqual(['x', 'y'])
    expect(p.properties.d.type).toBe('array')
  })
})
