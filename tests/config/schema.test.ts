import { describe, expect, it } from 'vitest'
import { configSchema } from '../../src/config/schema.ts'

describe('configSchema', () => {
  it('applies documented defaults', () => {
    const c = configSchema.parse({})
    expect(c.model).toBe('gpt-5.4-mini')
    expect(c.maxToolIterations).toBe(16)
    expect(c.context.window).toBe(200000)
    expect(c.context.compactAt).toBe(0.85)
  })

  // This refine is the guard that keeps compactHistory able to make actual
  // progress: keepTokens is the tail compaction always retains verbatim, so
  // if it were allowed to reach or exceed the usable budget, a compaction
  // could retain the *entire* history as "tail" and never shrink it —
  // exactly the kind of thrash the circuit breaker exists to catch, except
  // this stops it from ever being configured in the first place.
  it('rejects keepTokens >= window - reserved', () => {
    expect(() =>
      configSchema.parse({
        context: {
          window: 1000,
          reserved: 200,
          keepTokens: 800, // == window - reserved
        },
      }),
    ).toThrow(/keepTokens must be less than window - reserved/)
  })

  it('accepts keepTokens strictly less than window - reserved', () => {
    const c = configSchema.parse({
      context: { window: 1000, reserved: 200, keepTokens: 799 },
    })
    expect(c.context.keepTokens).toBe(799)
  })

  // .strict() (used by config/config.ts's readConfigFile, not this bare
  // .parse) rejects unknown keys rather than silently ignoring them — a
  // typo'd field in dcode.json should fail loudly, not vanish. Verified
  // here against the schema directly since every field already tolerates
  // *absence* via .optional()/.default(), so an unrecognized key is the
  // only thing .strict() has to catch.
  it('.strict() rejects an unknown top-level key', () => {
    expect(() =>
      configSchema.strict().parse({ model: 'x', bogus: true }),
    ).toThrow()
  })

  // .strict() doesn't cascade into nested objects on its own — context's
  // own .strict() (schema.ts) is what makes a typo inside `context`
  // (e.g. `windo` instead of `window`) fail loudly too, rather than being
  // silently dropped while `window` quietly falls back to its default.
  it('.strict() also rejects an unknown key nested inside context', () => {
    expect(() =>
      configSchema.strict().parse({ context: { windo: 1000 } }),
    ).toThrow()
  })

  it('a bare (non-strict) parse tolerates an already-known nested shape', () => {
    // Sanity check that .strict() is what's actually doing the rejecting
    // above, not some other validation — the same input passes without it.
    expect(() =>
      configSchema.parse({ context: { window: 100000, reserved: 1000 } }),
    ).not.toThrow()
  })

  // zod returns a `.default()` value verbatim rather than re-parsing it, so a
  // literal default object is a second copy of the field defaults that can
  // drift from them silently: omitting `context` would yield the stale
  // literal while `"context": {}` would yield the real defaults. The default
  // is now derived by parsing {} through the same schema.
  it('gives the same context whether the key is absent or an empty object', () => {
    expect(configSchema.parse({}).context).toEqual(
      configSchema.parse({ context: {} }).context,
    )
  })

  it('still fills every context field when the key is absent', () => {
    expect(configSchema.parse({}).context).toEqual({
      auto: true,
      window: 200000,
      reserved: 20000,
      keepTokens: 15000,
      prune: true,
      compactAt: 0.85,
    })
  })

  describe('mcpServers', () => {
    it('defaults to no configured servers', () => {
      expect(configSchema.parse({}).mcpServers).toEqual({})
    })

    it('infers type: local from a command field', () => {
      const c = configSchema.parse({
        mcpServers: { local: { command: 'node', args: ['server.js'] } },
      })
      expect(c.mcpServers.local).toEqual({
        type: 'local',
        enabled: false,
        command: 'node',
        args: ['server.js'],
      })
    })

    it('infers type: remote from a url field', () => {
      const c = configSchema.parse({
        mcpServers: {
          remote: {
            url: 'https://example.com/mcp',
            headers: { Authorization: 'Bearer x' },
          },
        },
      })
      expect(c.mcpServers.remote).toEqual({
        type: 'remote',
        enabled: false,
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer x' },
      })
    })

    it('defaults enabled to false', () => {
      const c = configSchema.parse({
        mcpServers: {
          local: { command: 'node' },
          remote: { url: 'https://example.com/mcp' },
        },
      })
      expect(c.mcpServers.local?.enabled).toBe(false)
      expect(c.mcpServers.remote?.enabled).toBe(false)
    })

    it('accepts an explicit enabled: true', () => {
      const c = configSchema.parse({
        mcpServers: { local: { command: 'node', enabled: true } },
      })
      expect(c.mcpServers.local?.enabled).toBe(true)
    })

    it('defaults local args to an empty array', () => {
      const c = configSchema.parse({
        mcpServers: { local: { command: 'node' } },
      })
      expect(c.mcpServers.local).toMatchObject({ args: [] })
    })

    it('accepts an explicit type without inference', () => {
      const c = configSchema.parse({
        mcpServers: { local: { type: 'local', command: 'node' } },
      })
      expect(c.mcpServers.local?.type).toBe('local')
    })

    // .strict() on each server variant, same as context: a typo'd field
    // inside one server's config should fail loudly, not vanish silently.
    it('.strict() rejects an unknown key inside a server entry', () => {
      expect(() =>
        configSchema.strict().parse({
          mcpServers: { local: { command: 'node', comand: 'typo' } },
        }),
      ).toThrow()
    })

    it('rejects a server entry with neither command nor url', () => {
      expect(() => configSchema.parse({ mcpServers: { bad: {} } })).toThrow()
    })
  })
})
