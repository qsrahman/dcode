import ansis from 'ansis'

export function renderToolResult(
  name: string,
  ok: boolean,
  ms: number,
): string {
  const status = ok ? ansis.green('✓') : ansis.red('✗')
  const secs = (ms / 1000).toFixed(1)
  return `› ${name}: ${status} done (${secs}s)`
}
