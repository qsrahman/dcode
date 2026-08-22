import { readFile } from 'node:fs/promises'
import { relative } from 'node:path'
import { z } from 'zod'
import type { ToolDefinition, ToolContext } from '../../agent/types.ts'
import { resolvePath } from './paths.ts'
import { walkDirs, globToRegExp } from './traverse.ts'

// Cap grep output so a broad pattern over a large tree can't flood the model's
// context (runTool's byte-truncation is a blunt backstop, not a real limit).
const GREP_MAX_MATCHES = 200

function grepTool(): ToolDefinition<{ pattern: string; path?: string }> {
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
    }),
    async execute(args: { pattern: string; path?: string }, ctx: ToolContext) {
      const target = args.path ?? '.'
      let re: RegExp
      try {
        re = new RegExp(args.pattern, 'g')
      } catch {
        throw new Error(`invalid regular expression: ${args.pattern}`)
      }
      const dir = await resolvePath(ctx.root, target)
      const ignore = new Set(ctx.config.ignore)
      const matches: string[] = []
      let capped = false
      outer: for await (const { full, entry } of walkDirs(dir, ignore)) {
        if (!entry.isFile()) continue
        let content: string
        try {
          content = await readFile(full, 'utf8')
        } catch {
          continue
        }
        const rel = relative(ctx.root, full)
        const lines = content.split('\n')
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!
          re.lastIndex = 0
          if (!re.test(line)) continue
          matches.push(`${rel}:${i + 1}: ${line}`)
          if (matches.length >= GREP_MAX_MATCHES) {
            capped = true
            break outer
          }
        }
      }
      let out = matches.join('\n') || '(no matches)'
      if (capped) {
        out += `\n… (stopped at ${GREP_MAX_MATCHES} matches; narrow the pattern or path)`
      }
      return out
    },
  }
}

function globTool(): ToolDefinition<{ pattern: string }> {
  return {
    name: 'glob',
    description:
      'List files matching a glob pattern under the working directory. Recursive; `**` matches any number of directories.',
    parameters: z.object({
      pattern: z
        .string()
        .describe('Glob pattern, e.g. "**/*.ts" or "src/**/*.ts"'),
    }),
    async execute(args: { pattern: string }, ctx: ToolContext) {
      const re = globToRegExp(args.pattern)
      const ignore = new Set(ctx.config.ignore)
      const matches: string[] = []
      for await (const { rel } of walkDirs(ctx.root, ignore)) {
        if (re.test(rel)) matches.push(rel)
      }
      matches.sort()
      return matches.join('\n') || '(no matches)'
    },
  }
}

export { grepTool, globTool }
