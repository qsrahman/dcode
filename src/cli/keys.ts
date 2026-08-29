import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { globalConfigPath } from '../config/config.ts'

// Secrets live only in the per-user global config. A friendly provider name maps
// to the config field that holds its key. The allowlist is deliberately small so
// `/key` can't be used to write arbitrary config keys.
const PROVIDERS: Record<string, 'apiKey' | 'brave'> = {
  openai: 'apiKey',
  brave: 'brave',
}

export const KEY_PROVIDERS = Object.keys(PROVIDERS)

export function isKnownProvider(p: string): p is keyof typeof PROVIDERS {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, p)
}

export function keyField(provider: string): 'apiKey' | 'brave' {
  // Only called after isKnownProvider(); the cast is safe.
  return PROVIDERS[provider] as 'apiKey' | 'brave'
}

function readGlobalRaw(): Record<string, unknown> {
  const p = globalConfigPath()
  if (!existsSync(p)) return {}
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

// Persist a single secret into the global config. The file is written owner-only
// (0o600) and the directory is locked to 0o700 so keys never become world- or
// group-readable. Other global-config fields are preserved.
export function setGlobalKey(field: 'apiKey' | 'brave', value: string): void {
  const p = globalConfigPath()
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 })
  const data = readGlobalRaw()
  data[field] = value
  writeFileSync(p, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
  // `mode` on writeFileSync only applies when the file is newly created — an
  // existing file (left over from an editor, or an earlier permissive write)
  // keeps its old mode. chmod it explicitly so secrets can't stay readable by
  // other local users just because the file already existed.
  chmodSync(p, 0o600)
  chmodSync(dirname(p), 0o700)
}

export function unsetGlobalKey(field: 'apiKey' | 'brave'): void {
  const p = globalConfigPath()
  if (!existsSync(p)) return
  const data = readGlobalRaw()
  delete data[field]
  writeFileSync(p, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
  // `mode` on writeFileSync only applies when the file is newly created — an
  // existing file (left over from an editor, or an earlier permissive write)
  // keeps its old mode. chmod it explicitly so secrets can't stay readable by
  // other local users just because the file already existed.
  chmodSync(p, 0o600)
  chmodSync(dirname(p), 0o700)
}
