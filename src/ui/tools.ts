import { paintFor } from '../util/color.ts'
import type { Paint } from '../util/color.ts'

// Terminal rendering for tool calls. Kept out of agent/loop.ts so that module
// is orchestration only — the loop decides what happened, this decides how it
// looks — and so it sits beside ui/markdown.ts, the other half of what the
// terminal actually shows during a turn.

// --- Compact per-batch tool summary (interactive default) --------------------
//
// A turn can call many tools, so listing names on one line grows with the call
// count until it wraps. Summarizing by *family* keeps the line to a fixed
// handful of segments regardless of how many calls happened. Interactive TTY
// sessions show a live counter while a batch runs (updated on each completion —
// no timer) that freezes into this summary; piped/verbose output keeps the
// per-tool lines below instead.
const TOOL_CATEGORY: Record<string, string> = {
  grep: 'search',
  glob: 'search',
  read_file: 'read',
  list_dir: 'read',
  stat: 'read',
  write_file: 'edit',
  edit_file: 'edit',
  move_file: 'edit',
  copy_file: 'edit',
  delete_file: 'edit',
  make_dir: 'edit',
  run_shell: 'run',
  run_process: 'run',
  read_process: 'run',
  kill_process: 'run',
  web_search: 'web',
  web_fetch: 'web',
  todowrite: 'plan',
  ask_user: 'plan',
  task: 'plan',
}
// Print order for the summary segments. An unmapped tool falls into 'run' as a
// catch-all so a newly added tool still appears rather than vanishing.
const CATEGORY_ORDER = ['search', 'read', 'edit', 'run', 'web', 'plan'] as const

function categoryOf(name: string): string {
  return TOOL_CATEGORY[name] ?? 'run'
}

export interface TurnTally {
  counts: Record<string, number>
  done: number
  failed: number
  startedMs: number
}

// One tally spans a whole user query, accumulating across every tool-calling
// turn — so a query that reads across several turns still collapses to a
// single summary, not one line per turn. There is no fixed total: the number
// of calls a query will make isn't known until it stops, so the live line
// shows a running count rather than done/total.
export function newTally(): TurnTally {
  return { counts: {}, done: 0, failed: 0, startedMs: Date.now() }
}

export function tallyResult(t: TurnTally, name: string, ok: boolean): void {
  const cat = categoryOf(name)
  t.counts[cat] = (t.counts[cat] ?? 0) + 1
  t.done += 1
  if (!ok) t.failed += 1
}

function secs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`
}

// The transient line shown while tools run — rewritten in place on each
// completion, and persisting across turns of one query. A running count plus
// the current tool name, so its width never depends on how many tools ran.
export function renderProgressLine(
  t: TurnTally,
  current: string,
  elapsedMs: number,
  color: boolean,
): string {
  const p = paintFor(color)
  const n = `${t.done} ${t.done === 1 ? 'tool' : 'tools'}`
  return `${p.dim('⋯')} ${p.dim(n)} ${p.dim('·')} ${p.cyan(current)} ${p.dim('·')} ${p.dim(secs(elapsedMs))}`
}

// The frozen summary the live line settles into: counts by family, a red
// failure count when any call failed, then elapsed. At most six short segments.
export function renderCategorySummary(
  t: TurnTally,
  elapsedMs: number,
  color: boolean,
): string {
  const p = paintFor(color)
  const segs = CATEGORY_ORDER.filter((c) => (t.counts[c] ?? 0) > 0).map((c) =>
    p.cyan(`${t.counts[c]} ${c}`),
  )
  if (t.failed > 0) segs.push(p.red(`✗${t.failed}`))
  segs.push(p.dim(secs(elapsedMs)))
  return segs.join(p.dim(' · '))
}

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
