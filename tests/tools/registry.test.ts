import { describe, expect, it } from 'vitest'
import { z } from 'zod/v4'
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

  // MCP tools (tools/mcp/manager.ts) carry the server's own JSON Schema
  // directly rather than one derived from `parameters` — this is what makes
  // that possible without a lossy JSON-Schema -> zod -> JSON-Schema round trip.
  it('uses jsonSchema verbatim instead of deriving one from parameters when present', () => {
    const raw = {
      type: 'object',
      properties: { q: { type: 'string', description: 'query' } },
      required: ['q'],
    }
    const tool = {
      name: 'mcp__srv__search',
      description: 'd',
      parameters: z.record(z.string(), z.unknown()),
      jsonSchema: raw,
      execute: async () => '',
    }
    const rt = toResponsesTool(tool) as any
    expect(rt.parameters).toBe(raw)
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
