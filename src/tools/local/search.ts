import { relative, resolve } from 'node:path'
import { execa } from 'execa'
import { rgPath } from '@vscode/ripgrep'
import { z } from 'zod'
import type { ToolDefinition, ToolContext } from '../../agent/types.ts'
import { resolvePath } from './paths.ts'
import { walkDir, globToRegExp, createIgnore } from './traverse.ts'
import { safeEnv } from './exec.ts'
import { CHILD_MAX_BUFFER } from './constants.ts'

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

interface RgEvent {
  type: 'begin' | 'match' | 'context' | 'end' | 'summary'
  data?: {
    path?: { text: string }
    lines?: { text: string }
    line_number?: number
  }
}

function grepTool(): ToolDefinition<{
  pattern: string
  path?: string
  ignore_case?: boolean
  context?: number
}> {
  return {
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
    async execute(
      args: {
        pattern: string
        path?: string
        ignore_case?: boolean
        context?: number
      },
      ctx: ToolContext,
    ) {
      const dir = await resolvePath(ctx.root, args.path ?? '.')
      const rgArgs = [
        '--json',
        '--line-number',
        '--color=never',
        '--max-filesize',
        GREP_MAX_FILE_SIZE,
        // Reveal dotfiles/dotdirs (the old walkDir-based grep searched them
        // too, unlike ripgrep's default); .git stays excluded regardless.
        '--hidden',
        '-g',
        '!.git',
      ]
      if (args.ignore_case) rgArgs.push('--ignore-case')
      if (args.context) rgArgs.push('--context', String(args.context))
      // ctx.config.ignore is gitignore-syntax already (decision: matches the
      // `ignore` package traverse.ts uses for glob) — ripgrep understands the
      // same syntax natively via -g '!pattern'.
      for (const pattern of ctx.config.ignore) {
        rgArgs.push('-g', `!${pattern}`)
      }
      rgArgs.push('--regexp', args.pattern, dir)

      const result = await execa(rgPath, rgArgs, {
        cwd: ctx.root,
        env: safeEnv(),
        extendEnv: false,
        timeout: ctx.config.toolTimeout,
        maxBuffer: CHILD_MAX_BUFFER,
        cancelSignal: ctx.signal,
        reject: false,
      })
      // Exit code 0 = matches found, 1 = ran fine with no matches — both are
      // success. Anything else (bad regex, bad path, ...) is a real error.
      if (result.exitCode !== 0 && result.exitCode !== 1) {
        if (/regex parse error/i.test(result.stderr)) {
          throw new Error(`invalid regular expression: ${args.pattern}`)
        }
        throw new Error(
          result.stderr.trim() || `ripgrep exited with ${result.exitCode}`,
        )
      }
      const lines: string[] = []
      let matchCount = 0
      let capped = false
      outer: for (const raw of result.stdout.split('\n')) {
        if (!raw) continue
        let evt: RgEvent
        try {
          evt = JSON.parse(raw)
        } catch {
          continue
        }
        switch (evt.type) {
          case 'match':
            if (matchCount >= GREP_MAX_MATCHES) {
              capped = true
              break outer
            }
            matchCount++
            lines.push(formatRgLine(ctx.root, evt))
            break
          case 'context':
            lines.push(formatRgLine(ctx.root, evt))
            break
          case 'end':
            lines.push('')
            break
        }
      }
      let out = lines.join('\n').trimEnd() || '(no matches)'
      if (capped) {
        out += `\n… (stopped at ${GREP_MAX_MATCHES} matches; narrow the pattern or path)`
      }
      return out
    },
  }
}

function formatRgLine(root: string, evt: RgEvent): string {
  const rel = relative(root, resolve(root, evt.data!.path!.text))
  const text = evt.data!.lines!.text.replace(/\n$/, '')
  return `${rel}:${evt.data!.line_number}: ${text}`
}

function globTool(): ToolDefinition<{
  pattern: string | string[]
  limit?: number
}> {
  return {
    name: 'glob',
    description:
      'List files matching glob pattern(s) under the working directory. Recursive; `**` matches any number of directories.',
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
    async execute(
      args: { pattern: string | string[]; limit?: number },
      ctx: ToolContext,
    ) {
      const patterns = Array.isArray(args.pattern)
        ? args.pattern
        : [args.pattern]
      const res = patterns.map((p) => globToRegExp(p))
      const ig = createIgnore(ctx.config.ignore)
      const matches: string[] = []
      for await (const { rel } of walkDir(ctx.root, ig)) {
        if (res.some((re) => re.test(rel))) matches.push(rel)
      }
      matches.sort()
      const limit = args.limit ?? GLOB_MAX
      const capped = matches.length > limit
      const shown = capped ? matches.slice(0, limit) : matches
      let out = shown.join('\n') || '(no matches)'
      if (capped) {
        out += `\n… (showing first ${limit} of ${matches.length}; narrow the pattern)`
      }
      return out
    },
  }
}

export { grepTool, globTool }
