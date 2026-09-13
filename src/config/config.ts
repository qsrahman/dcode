import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type { ParsedArgs } from '../cli/args.ts'
import { configSchema, type Config } from './schema.ts'
import { errorMessage } from '../util/log.ts'

// Location of the per-user global config, following the XDG Base Directory
// spec: `$XDG_CONFIG_HOME/dcode/dcode.json`, with $XDG_CONFIG_HOME defaulting
// to ~/.config. A relative $XDG_CONFIG_HOME is ignored (the spec requires an
// absolute path), so a stray value can't point the config at a cwd-relative
// path.
export function globalConfigPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME
  const base = xdg && isAbsolute(xdg) ? xdg : join(homedir(), '.config')
  return join(base, 'dcode', 'dcode.json')
}

// The OpenAI SDK appends resource paths (`/responses`, `/models`) to `baseURL`,
// so the configured value must include the API-version prefix (e.g.
// `http://localhost:11434/v1`, `https://api.openai.com/v1`). Ensure that prefix
// is present so both bare origins and explicit `/v1` work.
export function normalizeBaseURL(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '')
  return /\/v1$/i.test(trimmed) ? trimmed : `${trimmed}/v1`
}

// Read the effective config file: an explicit --config <path> (a missing one is
// an error, so a typo doesn't fail silently) or, when none is given, the global
// XDG file (absent → schema defaults via `{}`). dcode is a globally installed
// personal tool, so there is no repo-local config discovery.
export function readConfigFile(path?: string): Partial<Config> {
  const target =
    path !== undefined ? resolve(process.cwd(), path) : globalConfigPath()
  if (!existsSync(target)) {
    if (path !== undefined) throw new Error(`Config file not found: ${target}`)
    return {}
  }
  const raw = readFileSync(target, 'utf8')
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (err) {
    throw new Error(`Invalid JSON in ${target}: ${errorMessage(err)}`)
  }
  try {
    // .strict() catches typo'd keys (including inside `context`) — every field
    // tolerates absence via .optional()/.default(), so unknown keys are rejected
    // rather than silently ignored.
    return configSchema.strict().parse(json)
  } catch (err) {
    throw new Error(`Failed to load config ${target}: ${errorMessage(err)}`)
  }
}

// Build the effective config from all sources. Precedence (highest wins): CLI
// flags > env (OPENAI_*) > config file > schema defaults, layered by spreading
// file then env into one object and applying args last.
export function buildConfig(args: ParsedArgs): Config {
  const merged: Record<string, unknown> = { ...readConfigFile(args.config) }
  if (process.env.OPENAI_API_KEY) merged.apiKey = process.env.OPENAI_API_KEY
  if (process.env.OPENAI_BASE_URL) merged.baseURL = process.env.OPENAI_BASE_URL
  if (process.env.OPENAI_MODEL) merged.model = process.env.OPENAI_MODEL
  if (process.env.BRAVE_API_KEY) merged.brave = process.env.BRAVE_API_KEY
  if (typeof merged.baseURL === 'string') {
    merged.baseURL = normalizeBaseURL(merged.baseURL)
  }
  if (args.model) merged.model = args.model
  if (args.noColor) merged.color = false
  // The parse is non-strict (unlike readConfigFile's .strict()): the file was
  // already strict-parsed and env keys are a fixed known set, so nothing
  // unknown can reach here except via a bug in this function. verbose is
  // CLI-only (not in configSchema), so attach it after parsing — the schema
  // would strip it, and the strict file parse rejects it as a persisted key.
  return { ...configSchema.parse(merged), verbose: args.verbose === true }
}
