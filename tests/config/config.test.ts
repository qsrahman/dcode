import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildConfig,
  loadConfig,
  mergeConfigs,
} from '../../src/config/config.ts'

import { parseCli } from '../../src/cli/args.ts'

describe('loadConfig', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dcode-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('parses a JSON config and keeps nested defaults', () => {
    const p = join(dir, 'dcode.json')
    writeFileSync(p, JSON.stringify({ model: 'gpt-4.1' }))
    const cfg = loadConfig(p)
    expect(cfg.model).toBe('gpt-4.1')
  })

  it('throws when an explicit --config path is missing', () => {
    expect(() => loadConfig(join(dir, 'missing.json'))).toThrow(/not found/)
  })

  it('returns {} when no default config file is found', () => {
    const prev = process.cwd()
    try {
      process.chdir(dir)
      expect(loadConfig()).toEqual({})
    } finally {
      process.chdir(prev)
    }
  })

  it('rejects an invalid config value', () => {
    const p = join(dir, 'dcode.json')
    writeFileSync(p, JSON.stringify({ model: 123 }))
    expect(() => loadConfig(p)).toThrow()
  })
})

describe('mergeConfigs', () => {
  const base = parseCli([])

  it('applies schema defaults', () => {
    const cfg = mergeConfigs({}, {}, base)
    expect(cfg.model).toBe('gpt-5')
  })

  it('lets the file override defaults', () => {
    expect(mergeConfigs({ model: 'gpt-4.1' }, {}, base).model).toBe('gpt-4.1')
  })

  it('lets env override the file', () => {
    expect(
      mergeConfigs({ model: 'gpt-4.1' }, { model: 'gpt-x' }, base).model,
    ).toBe('gpt-x')
  })

  it('lets --model override env', () => {
    const cfg = mergeConfigs(
      { model: 'gpt-4.1' },
      { model: 'gpt-x' },
      parseCli(['--model', 'cli']),
    )
    expect(cfg.model).toBe('cli')
  })
})

describe('buildConfig', () => {
  const prevEnv = process.env.OPENAI_MODEL
  const prevCwd = process.cwd()
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dcode-'))
    process.chdir(dir)
  })
  afterEach(() => {
    process.chdir(prevCwd)
    rmSync(dir, { recursive: true, force: true })
    if (prevEnv === undefined) delete process.env.OPENAI_MODEL
    else process.env.OPENAI_MODEL = prevEnv
  })

  it('reads OPENAI_MODEL from the environment', () => {
    process.env.OPENAI_MODEL = 'gemma4:cloud'
    expect(buildConfig(parseCli([])).model).toBe('gemma4:cloud')
  })

  it('falls back to the schema default when unset', () => {
    delete process.env.OPENAI_MODEL
    expect(buildConfig(parseCli([])).model).toBe('gpt-5')
  })
})
