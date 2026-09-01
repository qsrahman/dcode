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
//
// `as const` (not `Record<string, 'apiKey' | 'brave'>`) so `keyof typeof
// PROVIDERS` is the exact `'openai' | 'brave'` union — keyField below can
// then require that narrowed type instead of a bare `string`, so indexing
// PROVIDERS is checked by the compiler rather than relying on every caller
// having already called isKnownProvider() first.
const PROVIDERS = {
  openai: 'apiKey',
  brave: 'brave',
} as const

// Object.keys() always widens to string[] regardless of the source object's
// precise type (a TS signature limitation, not a runtime risk — this is
// Object.keys of a closed, known-shape literal) — the one cast this module
// needs is here, not on every keyField call.
export const KEY_PROVIDERS = Object.keys(
  PROVIDERS,
) as (keyof typeof PROVIDERS)[]

export function isKnownProvider(p: string): p is keyof typeof PROVIDERS {
  return p in PROVIDERS
}

export function keyField(provider: keyof typeof PROVIDERS): 'apiKey' | 'brave' {
  return PROVIDERS[provider]
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
  const data = readGlobalRaw()
  data[field] = value
  writeGlobalConfig(data)
}

export function unsetGlobalKey(field: 'apiKey' | 'brave'): void {
  const p = globalConfigPath()
  if (!existsSync(p)) return
  const data = readGlobalRaw()
  delete data[field]
  writeGlobalConfig(data)
}

// Shared write path: serialize + chmod the config file and its parent directory
// so secrets never become world- or group-readable. `mode` on writeFileSync
// only applies when the file is newly created — an existing file (left over
// from an editor, or an earlier permissive write) keeps its old mode. chmod it
// explicitly so the permissions are always correct.
function writeGlobalConfig(data: Record<string, unknown>): void {
  const p = globalConfigPath()
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 })
  writeFileSync(p, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
  chmodSync(p, 0o600)
  chmodSync(dirname(p), 0o700)
}
