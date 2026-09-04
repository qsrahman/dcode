import { readFileSync } from 'node:fs'

// package.json may be missing or unparsable (e.g. bundled distributions), so
// never crash the CLI over a version string — fall back to 0.0.0.
export function getVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'),
    ) as { version?: unknown }
    return typeof pkg.version === 'string' && pkg.version
      ? pkg.version
      : '0.0.0'
  } catch {
    return '0.0.0'
  }
}
