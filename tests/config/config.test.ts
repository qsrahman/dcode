import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
  existsSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildConfig,
  globalConfigPath,
  readConfigFile,
} from '../../src/config/config.ts'

import { parseCli } from '../../src/cli/args.ts'

describe('readConfigFile', () => {
  let dir: string
  let globalHome: string
  const prevGlobalHome = process.env.XDG_CONFIG_HOME

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dcode-'))
    globalHome = mkdtempSync(join(tmpdir(), 'dcode-global-'))
    process.env.XDG_CONFIG_HOME = globalHome
    // XDG path is $XDG_CONFIG_HOME/dcode/dcode.json — create the subdir so the
    // direct writeFileSync(globalConfigPath()) calls below have a parent.
    mkdirSync(dirname(globalConfigPath()), { recursive: true })
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(globalHome, { recursive: true, force: true })
    if (prevGlobalHome === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = prevGlobalHome
  })

  it('parses a JSON config and keeps nested defaults', () => {
    const p = join(dir, 'dcode.json')
    writeFileSync(p, JSON.stringify({ model: 'gpt-4.1' }))
    const cfg = readConfigFile(p)
    expect(cfg.model).toBe('gpt-4.1')
  })

  it('throws when an explicit --config path is missing', () => {
    expect(() => readConfigFile(join(dir, 'missing.json'))).toThrow(/not found/)
  })

  it('returns {} when no default config file is found', () => {
    const prev = process.cwd()
    try {
      process.chdir(dir)
      expect(readConfigFile()).toEqual({})
    } finally {
      process.chdir(prev)
    }
  })

  it('rejects an invalid config value', () => {
    const p = join(dir, 'dcode.json')
    writeFileSync(p, JSON.stringify({ model: 123 }))
    expect(() => readConfigFile(p)).toThrow()
  })

  it('falls back to a global config when no local file exists', () => {
    const prev = process.cwd()
    try {
      process.chdir(dir)
      writeFileSync(
        globalConfigPath(),
        JSON.stringify({ model: 'global-model', baseURL: 'http://global' }),
      )
      const cfg = readConfigFile()
      expect(cfg.model).toBe('global-model')
      expect(cfg.baseURL).toBe('http://global')
    } finally {
      process.chdir(prev)
    }
  })

  it('uses an explicit --config file instead of the global config', () => {
    const prev = process.cwd()
    try {
      process.chdir(dir)
      writeFileSync(
        globalConfigPath(),
        JSON.stringify({ model: 'global', baseURL: 'http://global' }),
      )
      const explicit = join(dir, 'explicit.json')
      writeFileSync(explicit, JSON.stringify({ model: 'explicit' }))
      const cfg = readConfigFile(explicit)
      expect(cfg.model).toBe('explicit')
      expect(cfg.baseURL).toBeUndefined()
    } finally {
      process.chdir(prev)
    }
  })
})

describe('globalConfigPath', () => {
  const prevGlobalHome = process.env.XDG_CONFIG_HOME
  afterEach(() => {
    if (prevGlobalHome === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = prevGlobalHome
  })

  it('honors XDG_CONFIG_HOME ($XDG_CONFIG_HOME/dcode/dcode.json)', () => {
    const home = mkdtempSync(join(tmpdir(), 'dcode-home-'))
    process.env.XDG_CONFIG_HOME = home
    expect(globalConfigPath()).toBe(join(home, 'dcode', 'dcode.json'))
    rmSync(home, { recursive: true, force: true })
  })

  it('defaults to ~/.config/dcode/dcode.json when XDG_CONFIG_HOME is unset', () => {
    delete process.env.XDG_CONFIG_HOME
    expect(globalConfigPath()).toBe(
      join(homedir(), '.config', 'dcode', 'dcode.json'),
    )
  })

  it('ignores a relative XDG_CONFIG_HOME (spec requires an absolute path)', () => {
    process.env.XDG_CONFIG_HOME = 'relative/config'
    expect(globalConfigPath()).toBe(
      join(homedir(), '.config', 'dcode', 'dcode.json'),
    )
  })
})

describe('buildConfig', () => {
  const prevEnv = process.env.OPENAI_MODEL
  const prevKey = process.env.OPENAI_API_KEY
  const prevBrave = process.env.BRAVE_API_KEY
  const prevBaseURL = process.env.OPENAI_BASE_URL
  const prevCwd = process.cwd()
  const prevGlobalHome = process.env.XDG_CONFIG_HOME
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dcode-'))
    process.chdir(dir)
    process.env.XDG_CONFIG_HOME = dir
    delete process.env.OPENAI_BASE_URL
    mkdirSync(dirname(globalConfigPath()), { recursive: true })
  })
  afterEach(() => {
    process.chdir(prevCwd)
    rmSync(dir, { recursive: true, force: true })
    if (prevGlobalHome === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = prevGlobalHome
    if (prevEnv === undefined) delete process.env.OPENAI_MODEL
    else process.env.OPENAI_MODEL = prevEnv
    if (prevKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = prevKey
    if (prevBrave === undefined) delete process.env.BRAVE_API_KEY
    else process.env.BRAVE_API_KEY = prevBrave
    if (prevBaseURL === undefined) delete process.env.OPENAI_BASE_URL
    else process.env.OPENAI_BASE_URL = prevBaseURL
  })

  it('appends /v1 to a bare-origin baseURL from the config file', () => {
    writeFileSync(
      globalConfigPath(),
      JSON.stringify({ baseURL: 'http://localhost:11434' }),
    )
    expect(buildConfig(parseCli([])).baseURL).toBe('http://localhost:11434/v1')
  })

  it('leaves a baseURL that already ends in /v1 unchanged', () => {
    writeFileSync(
      globalConfigPath(),
      JSON.stringify({ baseURL: 'http://localhost:11434/v1/' }),
    )
    expect(buildConfig(parseCli([])).baseURL).toBe('http://localhost:11434/v1')
  })

  it('reads OPENAI_MODEL from the environment', () => {
    process.env.OPENAI_MODEL = 'gemma4:cloud'
    expect(buildConfig(parseCli([])).model).toBe('gemma4:cloud')
  })

  it('falls back to the schema default when unset', () => {
    delete process.env.OPENAI_MODEL
    expect(buildConfig(parseCli([])).model).toBe('gpt-5.4-mini')
  })

  it('is unaffected by a global config when local is absent', () => {
    delete process.env.OPENAI_MODEL
    expect(existsSync(globalConfigPath())).toBe(false)
    expect(buildConfig(parseCli([])).model).toBe('gpt-5.4-mini')
  })

  it('reads apiKey and brave from the global config when env is unset', () => {
    delete process.env.OPENAI_API_KEY
    delete process.env.BRAVE_API_KEY
    writeFileSync(
      globalConfigPath(),
      JSON.stringify({ apiKey: 'sk-global', brave: 'br-global' }),
    )
    const cfg = buildConfig(parseCli([]))
    expect(cfg.apiKey).toBe('sk-global')
    expect(cfg.brave).toBe('br-global')
  })

  it('resolves the full precedence chain defaults < global < env < cli', () => {
    for (const k of ['OPENAI_MODEL', 'OPENAI_API_KEY']) delete process.env[k]
    writeFileSync(
      globalConfigPath(),
      JSON.stringify({ model: 'global-model', apiKey: 'global-key' }),
    )
    // global config applies when env/cli are absent
    expect(buildConfig(parseCli([])).model).toBe('global-model')
    // env overrides the global config
    process.env.OPENAI_MODEL = 'env-model'
    process.env.OPENAI_API_KEY = 'env-key'
    expect(buildConfig(parseCli([])).model).toBe('env-model')
    expect(buildConfig(parseCli([])).apiKey).toBe('env-key')
    // CLI overrides env
    expect(buildConfig(parseCli(['--model', 'cli-model'])).model).toBe(
      'cli-model',
    )
  })
})
