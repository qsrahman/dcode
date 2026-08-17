import { readFile, readdir, stat } from 'node:fs/promises'
import { resolve, relative, sep } from 'node:path'
import { z } from 'zod'
import type { Tool, ToolContext } from '../../agent/types.ts'

export function createFsTools(): Tool[] {
  return [readFileTool(), listDirTool(), grepTool(), statTool(), globTool()]
}

function resolvePath(root: string, p: string): string {
  const resolved = resolve(root, p)
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new Error(`path escapes working directory: ${p}`)
  }
  return resolved
}

// Turn a Node fs error into a message the model can act on (decision H: tool
// output is untrusted, but errors should be self-correcting, not cryptic).
function fsError(err: unknown, path: string): string {
  if (err instanceof Error && 'code' in err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return `no such file or directory: ${path}`
    if (code === 'EISDIR') return `is a directory, use list_dir: ${path}`
    if (code === 'ENOTDIR') return `not a directory: ${path}`
    if (code === 'EACCES') return `permission denied: ${path}`
  }
  return err instanceof Error ? err.message : String(err)
}

function readFileTool(): Tool {
  return {
    name: 'read_file',
    description: 'Read a UTF-8 text file under the working directory.',
    parameters: z.object({
      path: z.string().describe('Relative path under the working directory'),
    }),
    async execute(args: unknown, ctx: ToolContext) {
      const { path } = args as { path: string }
      const file = resolvePath(ctx.root, path)
      try {
        return await readFile(file, 'utf8')
      } catch (err) {
        throw new Error(fsError(err, path))
      }
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
      const { path } = args as { path?: string }
      const target = path ?? '.'
      const dir = resolvePath(ctx.root, target)
      try {
        const entries = await readdir(dir, { withFileTypes: true })
        return entries
          .map((e) => `${e.isDirectory() ? 'd' : 'f'} ${e.name}`)
          .join('\n')
      } catch (err) {
        throw new Error(fsError(err, target))
      }
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
      const target = path ?? '.'
      let re: RegExp
      try {
        re = new RegExp(pattern, 'g')
      } catch {
        throw new Error(`invalid regular expression: ${pattern}`)
      }
      const dir = resolvePath(ctx.root, target)
      try {
        const matches = await grepRecursive(dir, re)
        return matches.join('\n') || '(no matches)'
      } catch (err) {
        throw new Error(fsError(err, target))
      }
    },
  }
}

function statTool(): Tool {
  return {
    name: 'stat',
    description:
      'Report type, size, and modification time of a file or directory under the working directory.',
    parameters: z.object({
      path: z
        .string()
        .optional()
        .describe('Path under the working directory; defaults to root'),
    }),
    async execute(args: unknown, ctx: ToolContext) {
      const { path } = args as { path?: string }
      const target = path ?? '.'
      const full = resolvePath(ctx.root, target)
      let info: Awaited<ReturnType<typeof stat>>
      try {
        info = await stat(full)
      } catch (err) {
        throw new Error(fsError(err, target))
      }
      const kind = info.isDirectory()
        ? 'directory'
        : info.isFile()
          ? 'file'
          : 'other'
      return [
        `type: ${kind}`,
        `size: ${info.size} bytes`,
        `modified: ${info.mtime.toISOString()}`,
      ].join('\n')
    },
  }
}

function globTool(): Tool {
  return {
    name: 'glob',
    description:
      'List files matching a glob pattern under the working directory. Recursive; `**` matches any number of directories.',
    parameters: z.object({
      pattern: z
        .string()
        .describe('Glob pattern, e.g. "**/*.ts" or "src/**/*.ts"'),
    }),
    async execute(args: unknown, ctx: ToolContext) {
      const { pattern } = args as { pattern: string }
      let re: RegExp
      try {
        re = globToRegExp(pattern)
      } catch {
        throw new Error(`invalid glob pattern: ${pattern}`)
      }
      const matches: string[] = []
      await globWalk(ctx.root, ctx.root, re, matches)
      matches.sort()
      return matches.join('\n') || '(no matches)'
    },
  }
}

// Minimal glob -> RegExp: `*` matches within a path segment, `?` a single char,
// `**` matches any number of directories (including none). The project has no
// glob dependency, so this covers the patterns the agent needs.
function globToRegExp(glob: string): RegExp {
  let re = '^'
  for (let i = 0; i < glob.length; i++) {
    const c = glob.charAt(i)
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++
        re += '.*'
        if (glob[i + 1] === '/') i++
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '[^/]'
    } else if (c === '.') {
      re += '\\.'
    } else if ('+^${}()|[]\\'.includes(c)) {
      re += '\\' + c
    } else {
      re += c
    }
  }
  return new RegExp(re + '$')
}

async function globWalk(
  root: string,
  dir: string,
  re: RegExp,
  out: string[],
): Promise<void> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const full = resolve(dir, e.name)
    if (re.test(relative(root, full))) out.push(relative(root, full))
    if (e.isDirectory() && !e.isSymbolicLink()) {
      await globWalk(root, full, re, out)
    }
  }
}

async function grepRecursive(target: string, re: RegExp): Promise<string[]> {
  const entries = await readdir(target, { withFileTypes: true })
  const out: string[] = []
  for (const e of entries) {
    const full = resolve(target, e.name)
    if (e.isDirectory() && !e.isSymbolicLink()) {
      out.push(...(await grepRecursive(full, re)))
    } else if (e.isFile()) {
      let content: string
      try {
        content = await readFile(full, 'utf8')
      } catch {
        continue
      }
      content.split('\n').forEach((line, i) => {
        re.lastIndex = 0
        if (re.test(line)) out.push(`${full}:${i + 1}: ${line}`)
      })
    }
  }
  return out
}
