import { relative, resolve } from 'node:path'
import { execa } from 'execa'
import { rgPath } from '@vscode/ripgrep'
import { z } from 'zod'
import type { ToolContext } from '../../agent/types.ts'
import { defineTool } from '../registry.ts'
import { errorMessage } from '../../util/log.ts'
import { resolvePath } from './paths.ts'
import { baseExecOptions, CHILD_MAX_BUFFER } from './exec.ts'

// Cap grep output so a broad pattern over a large tree can't flood the model's
// context (runTool's byte-truncation is a blunt backstop, not a real limit).
const GREP_MAX_MATCHES = 200
// Cap glob results the same way.
const GLOB_MAX = 1000
// Skip files above this size (ripgrep's own --max-filesize, not a JS read
// cap): a large log/dump anywhere under root shouldn't dominate the search.
// This is a silent skip — ripgrep doesn't report it anywhere (stdout or
// stderr), so there's no clean way to surface a note to the model about it.
const GREP_MAX_FILE_SIZE = '5M'

// ripgrep's --json encodes every string as either `{text}` (valid UTF-8) or
// `{bytes}` (base64 of the raw bytes, used whenever the data isn't valid
// UTF-8 — a matched line in a latin-1 file, a filename with odd bytes).
// Both forms have to be handled: assuming `text` throws on the `bytes` form
// and kills the whole search, not just that one file.
type RgText = { text?: string; bytes?: string }

interface RgEvent {
  type: 'begin' | 'match' | 'context' | 'end' | 'summary'
  data?: {
    path?: RgText
    lines?: RgText
    line_number?: number
  }
}

// Decode either form to a string. `bytes` is base64 of raw, non-UTF-8 bytes,
// so decoding is lossy (invalid sequences become U+FFFD) — still far more
// useful to the model than dropping the match or failing the call.
function rgText(v: RgText | undefined): string | undefined {
  if (!v) return undefined
  if (typeof v.text === 'string') return v.text
  if (typeof v.bytes === 'string') {
    return Buffer.from(v.bytes, 'base64').toString('utf8')
  }
  return undefined
}

interface RgResult {
  exitCode?: number
  signal?: string
  stderr: string
  isMaxBuffer: boolean
  isCanceled: boolean
  timedOut: boolean
}

// A non-0/1 exit means something actually went wrong (0 = found something,
// 1 = ran fine with nothing found — ripgrep's convention, not an error).
// reject:false means execa never throws for this, so a maxBuffer overflow,
// timeout, or abort all land here with exitCode left undefined (the process
// was killed, not exited normally) — check the same result fields runExec's
// catch branch checks, rather than falling through to a generic "ripgrep
// exited with undefined". Exported (rather than inlined in runRg) so this
// classification is unit-testable without spawning a real process.
export function classifyRgFailure(result: RgResult): Error {
  if (result.isMaxBuffer) {
    return new Error(
      `ripgrep output exceeded ${CHILD_MAX_BUFFER} bytes; narrow the search (a smaller path or a more specific pattern)`,
    )
  }
  if (result.isCanceled) return new Error('aborted')
  if (result.timedOut) return new Error('ripgrep timed out')
  return new Error(
    result.stderr.trim() ||
      `ripgrep exited with ${result.exitCode ?? result.signal ?? 'unknown status'}`,
  )
}

// Shared by grep/glob: ripgrep's exit code convention doesn't fit exec.ts's
// runExec (which throws on any nonzero exit), so both tools call execa
// directly and share this result-checking helper instead.
async function runRg(rgArgs: string[], ctx: ToolContext) {
  const result = await execa(rgPath, rgArgs, {
    ...baseExecOptions(ctx.root, ctx.signal),
    timeout: ctx.config.toolTimeout,
    maxBuffer: CHILD_MAX_BUFFER,
    reject: false,
  })
  if (result.exitCode === 0 || result.exitCode === 1) return result
  throw classifyRgFailure(result)
}

// Normalize a path ripgrep reports (relative to cwd, or absolute if the
// search target was absolute) to root-relative, regardless of which form it
// came back in.
function toRootRelative(root: string, text: string): string {
  return relative(root, resolve(root, text))
}

// Arguments both tools always pass. `--hidden` reveals dotfiles/dotdirs
// (ripgrep skips them by default, unlike the walkDir-based implementation
// these tools replaced); .git stays excluded regardless.
const BASE_RG_ARGS = ['--hidden', '-g', '!.git'] as const

// config.ignore is gitignore-syntax already, so ripgrep understands each
// entry natively via -g '!pattern'.
//
// Order matters and is not merely stylistic: ripgrep resolves competing -g
// globs last-match-wins, so these must be appended *after* any caller-supplied
// -g patterns. Folded ahead of glob's own patterns, a request for `**/*`
// re-includes everything config.ignore just excluded.
function ignoreArgs(ignore: readonly string[]): string[] {
  return ignore.flatMap((pattern) => ['-g', `!${pattern}`])
}

const grepTool = () =>
  defineTool({
    name: 'grep',
    description:
      'Search file contents for a regular expression under the working directory (backed by ripgrep — Rust regex syntax: no lookaround/backreferences, but no catastrophic-backtracking risk either).',
    parameters: z.object({
      pattern: z.string().describe('Regular expression to search for'),
      path: z
        .string()
        .optional()
        .describe('File or directory to search; defaults to root'),
      ignore_case: z.boolean().optional().describe('Case-insensitive match'),
      context: z
        .number()
        .int()
        .min(0)
        .max(10)
        .optional()
        .describe('Lines of context to show around each match'),
    }),
    async execute(args, ctx) {
      const dir = await resolvePath(ctx.root, args.path ?? '.')
      const rgArgs = [
        '--json',
        '--line-number',
        '--color=never',
        '--max-filesize',
        GREP_MAX_FILE_SIZE,
        ...BASE_RG_ARGS,
        ...ignoreArgs(ctx.config.ignore),
      ]
      if (args.ignore_case) rgArgs.push('--ignore-case')
      if (args.context) rgArgs.push('--context', String(args.context))
      // An anchored -g pattern (e.g. a config.ignore entry like "/dist") is
      // matched relative to cwd, not to the search-target argument — so the
      // target must be relative (cwd is already ctx.root) or such patterns
      // silently match nothing.
      rgArgs.push('--regexp', args.pattern, relative(ctx.root, dir) || '.')

      let result: Awaited<ReturnType<typeof runRg>>
      try {
        result = await runRg(rgArgs, ctx)
      } catch (err) {
        const message = errorMessage(err)
        if (/regex parse error/i.test(message)) {
          throw new Error(`invalid regular expression: ${args.pattern}`)
        }
        throw err
      }
      const lines: string[] = []
      let matchCount = 0
      let capped = false
      for (const raw of result.stdout.split('\n')) {
        if (!raw) continue
        let evt: RgEvent
        try {
          evt = JSON.parse(raw)
        } catch {
          continue
        }
        if (evt.type === 'end') {
          lines.push('')
          continue
        }
        if (evt.type !== 'match' && evt.type !== 'context') continue
        if (evt.type === 'match') {
          if (matchCount >= GREP_MAX_MATCHES) {
            capped = true
            break
          }
          matchCount++
        }
        const line = formatRgLine(ctx.root, evt)
        if (line !== null) lines.push(line)
      }
      let out = lines.join('\n').trimEnd() || '(no matches)'
      if (capped) {
        out += `\n… (stopped at ${GREP_MAX_MATCHES} matches; narrow the pattern or path)`
      }
      return out
    },
  })

// Returns null for an event that carries neither a path nor line content in
// any decodable form — skipped rather than emitted as a half-formed line.
function formatRgLine(root: string, evt: RgEvent): string | null {
  const path = rgText(evt.data?.path)
  const lines = rgText(evt.data?.lines)
  if (path === undefined || lines === undefined) return null
  const rel = toRootRelative(root, path)
  return `${rel}:${evt.data?.line_number}: ${lines.replace(/\n$/, '')}`
}

const globTool = () =>
  defineTool({
    name: 'glob',
    description:
      'List files matching glob pattern(s) under the working directory (backed by ripgrep --files — gitignore-style globs: `**` matches any depth, and a bare pattern like `*.ts` with no `/` also matches at any depth, not just the top level; anchor with a leading `/` for root-only).',
    parameters: z.object({
      pattern: z
        .union([z.string(), z.array(z.string())])
        .describe(
          'Glob pattern or patterns, e.g. "**/*.ts" or ["**/*.ts","**/*.js"]',
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('Maximum entries to return'),
    }),
    async execute(args, ctx) {
      const patterns = Array.isArray(args.pattern)
        ? args.pattern
        : [args.pattern]
      const rgArgs = ['--files', ...BASE_RG_ARGS]
      for (const p of patterns) rgArgs.push('-g', p)
      // After the caller's patterns — see ignoreArgs on why the order binds.
      rgArgs.push(...ignoreArgs(ctx.config.ignore))
      // '.' rather than ctx.root: an anchored pattern like "sub/**" is
      // matched relative to cwd (already ctx.root), not to an absolute
      // target argument — passing the absolute path here silently drops
      // matches for any pattern containing a literal path segment.
      rgArgs.push('.')

      const result = await runRg(rgArgs, ctx)
      const matches = result.stdout
        .split('\n')
        .filter(Boolean)
        .map((p) => toRootRelative(ctx.root, p))
        .sort()
      const limit = args.limit ?? GLOB_MAX
      const capped = matches.length > limit
      const shown = capped ? matches.slice(0, limit) : matches
      let out = shown.join('\n') || '(no matches)'
      if (capped) {
        out += `\n… (showing first ${limit} of ${matches.length}; narrow the pattern)`
      }
      return out
    },
  })

export { grepTool, globTool }
