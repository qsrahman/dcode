import { format } from 'node:util'
import type { Config } from '../config/schema.ts'
import { paintFor, type Paint } from './color.ts'

export interface Logger {
  debug(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// One colour per severity; the paints themselves come from util/color.ts,
// shared with the tool-result renderer in ui/tools.ts.
const LEVEL_STYLE = { debug: 'dim', warn: 'yellow', error: 'red' } as const

export function createLogger(
  config: Pick<Config, 'verbose' | 'color'>,
  stream: NodeJS.WritableStream = process.stderr,
): Logger {
  const p = paintFor(config.color)
  const paint = {
    debug: p[LEVEL_STYLE.debug],
    warn: p[LEVEL_STYLE.warn],
    error: p[LEVEL_STYLE.error],
  }
  const write = (label: string, paint: Paint, args: unknown[]) => {
    stream.write(`${paint(label)} ${format(...args)}\n`)
  }
  return {
    debug: (...args) => {
      if (config.verbose) write('[debug]', paint.debug, args)
    },
    warn: (...args) => write('[warn]', paint.warn, args),
    error: (...args) => write('[error]', paint.error, args),
  }
}
