import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ParsedArgs } from '../cli/args.ts'
import { configSchema, type Config } from './schema.ts'
import { errorMessage } from '../util/log.ts'

// Location of the per-user global config. Defaults to
// ~/.config/dcode/dcode.json (XDG-style) but can be relocated via
// DCODE_CONFIG_HOME (used for testing and for users who prefer another spot).
export function globalConfigPath(): string {
  const base = process.env.DCODE_CONFIG_HOME
    ? resolve(process.env.DCODE_CONFIG_HOME)
    : resolve(homedir(), '.config', 'dcode')
  return join(base, 'dcode.json')
}

// The OpenAI SDK appends resource paths (`/responses`, `/models`) to `baseURL`,
// so the configured value must include the API-version prefix (e.g.
// `http://localhost:11434/v1`, `https://api.openai.com/v1`). Ensure that prefix
// is present so both bare origins and explicit `/v1` work.
export function normalizeBaseURL(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '')
  return /\/v1$/i.test(trimmed) ? trimmed : `${trimmed}/v1`
}

// Config precedence (highest wins): CLI flags > env (OPENAI_*) > global
// (~/.config/dcode/dcode.json) > schema defaults. An explicit --config <path> is
// read instead of the global file (and a missing path is an error, so a typo
// doesn't fail silently). dcode is a globally installed personal tool, so there
// is no repo-local config discovery.
export function loadConfig(path?: string): Partial<Config> {
  const target =
    path !== undefined ? resolve(process.cwd(), path) : globalConfigPath()
  if (!existsSync(target)) {
    if (path !== undefined) throw new Error(`Config file not found: ${target}`)
    return {}
  }
  return readConfigFile(target)
}

function readConfigFile(abs: string): Partial<Config> {
  const raw = readFileSync(abs, 'utf8')
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (err) {
    throw new Error(`Invalid JSON in ${abs}: ${errorMessage(err)}`)
  }
  try {
    // .strict() catches typo'd keys (including inside `context`) — every field
    // tolerates absence via .optional()/.default(), so unknown keys are rejected
    // rather than silently ignored.
    return configSchema.strict().parse(json)
  } catch (err) {
    throw new Error(`Failed to load config ${abs}: ${errorMessage(err)}`)
  }
}

// Non-strict here is intentional, unlike readConfigFile's .strict() above:
// `file`/`env` already passed through configSchema.strict()/known env-var
// checks respectively, so by the time they reach this merge there's nothing
// left to typo — a stray unknown key could only get here via a bug in this
// module itself, which .strict() wouldn't meaningfully guard against anyway.
export function mergeConfigs(
  file: Partial<Config>,
  env: Partial<Config>,
  args: ParsedArgs,
): Config {
  const merged: Record<string, unknown> = { ...file, ...env }
  if (typeof merged.baseURL === 'string') {
    merged.baseURL = normalizeBaseURL(merged.baseURL)
  }
  if (args.model) merged.model = args.model
  if (args.noColor) merged.color = false
  // verbose is CLI-only (not in configSchema), so attach it after parsing —
  // the schema would strip it, and the strict file parse rejects it as a
  // persisted key. `--verbose` remains the only way to turn it on.
  return { ...configSchema.parse(merged), verbose: args.verbose === true }
}

export function buildConfig(args: ParsedArgs): Config {
  const file = loadConfig(args.config)
  const env: Partial<Config> = {}
  if (process.env.OPENAI_API_KEY) env.apiKey = process.env.OPENAI_API_KEY
  if (process.env.OPENAI_BASE_URL) env.baseURL = process.env.OPENAI_BASE_URL
  if (process.env.OPENAI_MODEL) env.model = process.env.OPENAI_MODEL
  if (process.env.BRAVE_API_KEY) env.brave = process.env.BRAVE_API_KEY
  return mergeConfigs(file, env, args)
}
