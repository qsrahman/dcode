import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { globalConfigPath } from '../../src/config/config.ts'
import {
  isKnownProvider,
  keyField,
  KEY_PROVIDERS,
  setGlobalKey,
  unsetGlobalKey,
} from '../../src/cli/keys.ts'

const prev = process.env.DCODE_CONFIG_HOME
let home: string

beforeEach(() => {
  home = join(tmpdir(), `dcode-keys-${Math.random().toString(36).slice(2)}`)
  process.env.DCODE_CONFIG_HOME = home
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  if (prev === undefined) delete process.env.DCODE_CONFIG_HOME
  else process.env.DCODE_CONFIG_HOME = prev
})

describe('key storage', () => {
  it('writes the openai key to the global config with 0600 perms', () => {
    setGlobalKey('apiKey', 'sk-secret')
    const p = globalConfigPath()
    expect(existsSync(p)).toBe(true)
    expect(statSync(p).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(p, 'utf8')).apiKey).toBe('sk-secret')
  })

  it('merges with existing global-config fields', () => {
    setGlobalKey('apiKey', 'sk-secret')
    setGlobalKey('brave', 'br-secret')
    const data = JSON.parse(readFileSync(globalConfigPath(), 'utf8'))
    expect(data.apiKey).toBe('sk-secret')
    expect(data.brave).toBe('br-secret')
  })

  it('removes a key on unset', () => {
    setGlobalKey('apiKey', 'sk-secret')
    unsetGlobalKey('apiKey')
    const data = JSON.parse(readFileSync(globalConfigPath(), 'utf8'))
    expect(data.apiKey).toBeUndefined()
  })

  it('exposes a known-provider allowlist', () => {
    expect(isKnownProvider('openai')).toBe(true)
    expect(isKnownProvider('brave')).toBe(true)
    expect(isKnownProvider('evil')).toBe(false)
    expect(keyField('openai')).toBe('apiKey')
    expect(KEY_PROVIDERS).toEqual(['openai', 'brave'])
  })
})
