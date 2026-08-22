import ansis from 'ansis'

export function renderToolResult(
  name: string,
  ok: boolean,
  ms: number,
): string {
  const status = ok ? ansis.green('✓') : ansis.red('✗')
  const secs = (ms / 1000).toFixed(1)
  return `› ${name}: ${status} ${ok ? 'done' : 'failed'} (${secs}s)`
}

const RULE = '─'.repeat(40)

// Verbose mode echoes a tool's raw output between turns; dim fences mark it
// as diagnostics so it doesn't read as more streamed model text.
export function renderToolOutput(name: string, output: string): string {
  return [ansis.dim(`── ${name} output ${RULE}`), output, ansis.dim(RULE)].join(
    '\n',
  )
}
