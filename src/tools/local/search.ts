import { readFile } from 'node:fs/promises'
import { relative } from 'node:path'
import { z } from 'zod'
import type { ToolDefinition, ToolContext } from '../../agent/types.ts'
import { resolvePath } from './paths.ts'
import { walkDir, globToRegExp, createIgnore } from './traverse.ts'

// Cap grep output so a broad pattern over a large tree can't flood the model's
// context (runTool's byte-truncation is a blunt backstop, not a real limit).
const GREP_MAX_MATCHES = 200
// Cap glob results the same way.
const GLOB_MAX = 1000

function grepTool(): ToolDefinition<{
  pattern: string
  path?: string
  ignore_case?: boolean
  context?: number
}> {
  return {
    name: 'grep',
    description:
      'Search file contents for a regular expression under the working directory.',
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
      const target = args.path ?? '.'
      let re: RegExp
      try {
        re = new RegExp(args.pattern, args.ignore_case ? 'gi' : 'g')
      } catch {
        throw new Error(`invalid regular expression: ${args.pattern}`)
      }
      const dir = await resolvePath(ctx.root, target)
      const ig = createIgnore(ctx.config.ignore)
      const ctxLines = args.context ?? 0
      const matches: string[] = []
      let capped = false
      let matchCount = 0
      outer: for await (const { full, entry } of walkDir(dir, ig)) {
        if (!entry.isFile()) continue
        let content: string
        try {
          const buf = await readFile(full)
          // Skip binaries: a NUL byte in the leading chunk (git's heuristic)
          // means UTF-8 decoding would yield garbage lines that pollute
          // match output.
          if (buf.subarray(0, 8000).includes(0)) continue
          content = buf.toString('utf8')
        } catch {
          continue
        }
        const rel = relative(ctx.root, full)
        const lines = content.split('\n')
        const hitIdx: number[] = []
        for (let i = 0; i < lines.length; i++) {
          re.lastIndex = 0
          if (re.test(lines[i]!)) hitIdx.push(i)
        }
        if (hitIdx.length === 0) continue
        let lastPushed = -2
        for (const m of hitIdx) {
          if (matchCount >= GREP_MAX_MATCHES) {
            capped = true
            break outer
          }
          const lo = Math.max(0, m - ctxLines)
          const hi = Math.min(lines.length - 1, m + ctxLines)
          for (let i = lo; i <= hi; i++) {
            if (i === lastPushed) continue
            matches.push(`${rel}:${i + 1}: ${lines[i]!}`)
            lastPushed = i
          }
          matchCount++
        }
        matches.push('')
      }
      let out = matches.join('\n').trimEnd() || '(no matches)'
      if (capped) {
        out += `\n… (stopped at ${GREP_MAX_MATCHES} matches; narrow the pattern or path)`
      }
      return out
    },
  }
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
