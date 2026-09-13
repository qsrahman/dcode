import { isCI } from '@clack/prompts'
import { paintFor } from '../util/color.ts'
import type { Paint } from '../util/color.ts'
import type { ToolResult } from '../agent/types.ts'

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

// --- Progress reporter -------------------------------------------------------
//
// Owns all terminal rendering of tool progress for one runAgent call, hiding
// the two modes the loop used to branch on inline: an interactive TTY shows a
// live counter that freezes into one category summary per query, while
// piped/CI/verbose output keeps a stable line per call. Keeping this here
// leaves agent/loop.ts as orchestration only.

// Carriage return + erase-line: rewrites the current terminal line in place so
// the live counter updates without scrolling. TTY-only.
const CLEAR_LINE = '\r\x1b[2K'

export interface ToolProgress {
  // Record a settled call. Live: update the counter in place. Non-live: no-op
  // (the per-call line is printed by renderBatch once the batch is in history).
  onResult(r: ToolResult): void
  // Non-live: print one line per finished call (and, in verbose, its raw
  // output). No-op while the live counter is active.
  renderBatch(results: ToolResult[]): void
  // Blank line separating a finished tool block from the next turn's streamed
  // text. Non-live only — the live counter persists in place across turns, so a
  // newline here would strand it above the redraw.
  separate(prevHadTools: boolean): void
  // Freeze the accumulated live counter into the bounded category summary above
  // the answer, then start a fresh tally. No-op when not live, or when nothing
  // ran. A trailing blank line separates the summary from the answer beneath it.
  freeze(): void
}

// The interactive live counter is used only on a real TTY that is not CI and
// not --verbose: CI's captured log has no cursor, so the in-place redraws would
// land as literal escape noise, and a log (piped or verbose) wants one durable
// record per call rather than a line rewritten in place.
export function createToolProgress(
  sink: { write(text: string): void },
  config: { color: boolean; verbose: boolean },
): ToolProgress {
  const live = Boolean(process.stdout.isTTY) && !isCI() && !config.verbose
  let pending = newTally()
  const redraw = (current: string) => {
    sink.write(
      CLEAR_LINE +
        renderProgressLine(
          pending,
          current,
          Date.now() - pending.startedMs,
          config.color,
        ),
    )
  }
  return {
    onResult(r) {
      if (!live) return
      tallyResult(pending, r.name, r.ok)
      redraw(r.name)
    },
    renderBatch(results) {
      if (live) return
      for (const r of results) {
        sink.write(`${renderToolResult(r.name, r.ok, r.ms, config.color)}\n`)
        if (config.verbose) {
          sink.write(`${renderToolOutput(r.name, r.output, config.color)}\n`)
        }
      }
    },
    separate(prevHadTools) {
      if (prevHadTools && !live) sink.write('\n')
    },
    freeze() {
      if (!live || pending.done === 0) return
      sink.write(
        `${CLEAR_LINE}  ${renderCategorySummary(pending, Date.now() - pending.startedMs, config.color)}\n\n`,
      )
      pending = newTally()
    },
  }
}
