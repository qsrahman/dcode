import ansis from 'ansis'
import { format } from 'node:util'
import type { AppConfig } from '../config/schema.ts'

export interface Logger {
  debug(...args: unknown[]): void
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

type Paint = (s: string) => string

// Build colorizers locally so we never mutate the global `ansis.enabled`
// (which would leak across tests). When color is off, every paint is identity.
function paintFor(color: boolean): Record<keyof Logger, Paint> {
  if (!color) {
    const id = (s: string) => s
    return { debug: id, info: id, warn: id, error: id }
  }
  return {
    debug: (s) => ansis.dim(s),
    info: (s) => ansis.cyan(s),
    warn: (s) => ansis.yellow(s),
    error: (s) => ansis.red(s),
  }
}

export function createLogger(
  config: Pick<AppConfig, 'verbose' | 'color'>,
  stream: NodeJS.WritableStream = process.stderr,
): Logger {
  const paint = paintFor(config.color)
  const write = (label: string, paint: Paint, args: unknown[]) => {
    stream.write(`${paint(label)} ${format(...args)}\n`)
  }
  return {
    debug: (...args) => {
      if (config.verbose) write('[debug]', paint.debug, args)
    },
    info: (...args) => {
      if (config.verbose) write('[info]', paint.info, args)
    },
    warn: (...args) => write('[warn]', paint.warn, args),
    error: (...args) => write('[error]', paint.error, args),
  }
}
