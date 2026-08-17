import { readFile, readdir } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { z } from 'zod'
import type { Tool, ToolContext } from '../../agent/types.ts'

export function createFsTools(): Tool[] {
  return [readFileTool(), listDirTool(), grepTool()]
}

function resolvePath(root: string, p: string): string {
  const resolved = resolve(root, p)
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new Error(`path escapes working directory: ${p}`)
  }
  return resolved
}

function readFileTool(): Tool {
  return {
    name: 'read_file',
    description: 'Read a UTF-8 text file under the working directory.',
    parameters: z.object({
      path: z.string().describe('Relative path under the working directory'),
    }),
    async execute(args: unknown, ctx: ToolContext) {
      const file = resolvePath(ctx.root, (args as { path: string }).path)
      return readFile(file, 'utf8')
    },
  }
}

function listDirTool(): Tool {
  return {
    name: 'list_dir',
    description: 'List a directory under the working directory.',
    parameters: z.object({
      path: z
        .string()
        .optional()
        .describe('Directory under the working directory; defaults to root'),
    }),
    async execute(args: unknown, ctx: ToolContext) {
      const dir = resolvePath(ctx.root, (args as { path?: string }).path ?? '.')
      const entries = await readdir(dir, { withFileTypes: true })
      return entries
        .map((e) => `${e.isDirectory() ? 'd' : 'f'} ${e.name}`)
        .join('\n')
    },
  }
}

function grepTool(): Tool {
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
    async execute(args: unknown, ctx: ToolContext) {
      const { pattern, path } = args as { pattern: string; path?: string }
      const target = resolvePath(ctx.root, path ?? '.')
      const re = new RegExp(pattern, 'g')
      const matches = await grepRecursive(target, re)
      return matches.join('\n') || '(no matches)'
    },
  }
}

async function grepRecursive(target: string, re: RegExp): Promise<string[]> {
  const entries = await readdir(target, { withFileTypes: true })
  const out: string[] = []
  for (const e of entries) {
    const full = resolve(target, e.name)
    if (e.isDirectory()) {
      out.push(...(await grepRecursive(full, re)))
    } else if (e.isFile()) {
      const content = await readFile(full, 'utf8')
      content.split('\n').forEach((line, i) => {
        re.lastIndex = 0
        if (re.test(line)) out.push(`${full}:${i + 1}: ${line}`)
      })
    }
  }
  return out
}
