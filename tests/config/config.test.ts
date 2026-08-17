import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildConfig,
  loadConfigFile,
  mergeConfig,
} from '../../src/config/config.ts'
import { appConfigSchema } from '../../src/config/schema.ts'
import { parseCli } from '../../src/cli/args.ts'

describe('loadConfigFile', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dcode-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('parses a JSON config and keeps nested defaults', () => {
    const p = join(dir, 'dcode.json')
    writeFileSync(
      p,
      JSON.stringify({ model: 'gpt-4.1', permissions: { mode: 'auto' } }),
    )
    const cfg = loadConfigFile(p)
    expect(cfg.model).toBe('gpt-4.1')
    expect(cfg.permissions?.mode).toBe('auto')
  })

  it('returns {} when the file is absent', () => {
    expect(loadConfigFile(join(dir, 'missing.json'))).toEqual({})
  })

  it('rejects an invalid config value', () => {
    const p = join(dir, 'dcode.json')
    writeFileSync(p, JSON.stringify({ permissions: { mode: 'bogus' } }))
    expect(() => loadConfigFile(p)).toThrow()
  })
})

describe('mergeConfig', () => {
  const base = parseCli([])

  it('applies schema defaults', () => {
    const cfg = mergeConfig({}, {}, base)
    expect(cfg.model).toBe('gpt-5')
    expect(cfg.stream).toBe(true)
    expect(cfg.permissions.mode).toBe('interactive')
    expect(cfg.permissions.rules).toEqual({})
  })

  it('lets the file override defaults', () => {
    expect(mergeConfig({ model: 'gpt-4.1' }, {}, base).model).toBe('gpt-4.1')
  })

  it('lets env override the file', () => {
    expect(
      mergeConfig({ model: 'gpt-4.1' }, { model: 'gpt-x' }, base).model,
    ).toBe('gpt-x')
  })

  it('lets --model override env', () => {
    const cfg = mergeConfig(
      { model: 'gpt-4.1' },
      { model: 'gpt-x' },
      parseCli(['--model', 'cli']),
    )
    expect(cfg.model).toBe('cli')
  })

  it('--no-stream forces streaming off even when the file enables it', () => {
    expect(
      mergeConfig({ stream: true }, {}, parseCli(['--no-stream'])).stream,
    ).toBe(false)
  })

  it('--auto sets the mode', () => {
    expect(mergeConfig({}, {}, parseCli(['--auto'])).permissions.mode).toBe(
      'auto',
    )
  })

  it('rejects an invalid --mode', () => {
    expect(() => mergeConfig({}, {}, parseCli(['--mode', 'bogus']))).toThrow()
  })
})

describe('buildConfig', () => {
  const prev = process.env.OPENAI_DEFAULT_MODEL
  afterEach(() => {
    if (prev === undefined) delete process.env.OPENAI_DEFAULT_MODEL
    else process.env.OPENAI_DEFAULT_MODEL = prev
  })

  it('reads OPENAI_DEFAULT_MODEL from the environment', () => {
    process.env.OPENAI_DEFAULT_MODEL = 'gemma4:cloud'
    expect(buildConfig(parseCli([])).model).toBe('gemma4:cloud')
  })

  it('falls back to the schema default when unset', () => {
    delete process.env.OPENAI_DEFAULT_MODEL
    expect(buildConfig(parseCli([])).model).toBe('gpt-5')
  })
})

describe('appConfigSchema', () => {
  it('parses a full config including an mcp server', () => {
    const cfg = appConfigSchema.parse({
      model: 'gpt-5',
      mcp: [
        {
          name: 'x',
          transport: { type: 'stdio', command: 'node' },
          trust: false,
        },
      ],
    })
    expect(cfg.mcp[0]?.name).toBe('x')
  })
})
