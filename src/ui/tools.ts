import { paintFor, type Paint } from '../util/color.ts'

// Terminal rendering for tool calls. Kept out of agent/loop.ts so that module
// is orchestration only — the loop decides what happened, this decides how it
// looks — and so it sits beside ui/markdown.ts, the other half of what the
// terminal actually shows during a turn.

// One line per finished tool call: name, outcome, elapsed.
export function renderToolResult(
  name: string,
  ok: boolean,
  ms: number,
  color: boolean,
): string {
  const p = paintFor(color)
  const status = ok ? p.green('✓') : p.red('✗')
  const secs = (ms / 1000).toFixed(1)
  return `› ${p.cyan(name)}: ${status} ${ok ? 'done' : 'failed'} (${p.dim(secs + 's')})`
}

const RULE = '─'.repeat(40)

// Color a unified-diff line so edits and `git diff` output are scannable in
// verbose mode: hunk headers cyan, additions green, removals red.
function colorDiffLine(line: string, p: Record<string, Paint>): string {
  if (line.startsWith('@@')) return p.cyan!(line)
  if (line.startsWith('+')) return p.green!(line)
  if (line.startsWith('-')) return p.red!(line)
  return line
}

// Verbose mode echoes a tool's raw output between turns; dim fences mark it
// as diagnostics so it doesn't read as more streamed model text. Diff-like
// lines (from a `git diff` run through run_shell, or edit_file) are colored.
export function renderToolOutput(
  name: string,
  output: string,
  color: boolean,
): string {
  const p = paintFor(color)
  const body = output
    .split('\n')
    .map((line) => colorDiffLine(line, p))
    .join('\n')
  return [p.dim(`── ${name} output ${RULE}`), body, p.dim(RULE)].join('\n')
}
