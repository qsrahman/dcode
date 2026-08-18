import { readFile, readdir, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
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

// Shared recursive directory walk: yields every entry with its path relative to
// root. Skips symlinks (don't follow) and silently continues past unreadable
// directories — the same traversal rules grep and glob need.
async function* walkDirs(
  root: string,
): AsyncGenerator<{ full: string; rel: string; entry: Dirent }> {
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()!
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = resolve(dir, entry.name)
      yield { full, rel: relative(root, full), entry }
      if (entry.isDirectory() && !entry.isSymbolicLink()) stack.push(full)
    }
  }
}

function readFileTool(): Tool<{ path: string }> {
  return {
    name: 'read_file',
    description: 'Read a UTF-8 text file under the working directory.',
    parameters: z.object({
      path: z.string().describe('Relative path under the working directory'),
    }),
    async execute(args: { path: string }, ctx: ToolContext) {
      const file = resolvePath(ctx.root, args.path)
      try {
        return await readFile(file, 'utf8')
      } catch (err) {
        throw new Error(fsError(err, args.path))
      }
    },
  }
}

function listDirTool(): Tool<{ path?: string }> {
  return {
    name: 'list_dir',
    description: 'List a directory under the working directory.',
    parameters: z.object({
      path: z
        .string()
        .optional()
        .describe('Directory under the working directory; defaults to root'),
    }),
    async execute(args: { path?: string }, ctx: ToolContext) {
      const target = args.path ?? '.'
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

function grepTool(): Tool<{ pattern: string; path?: string }> {
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
      const dir = resolvePath(ctx.root, target)
      const matches: string[] = []
      for await (const { full, entry } of walkDirs(dir)) {
        if (!entry.isFile()) continue
        let content: string
        try {
          content = await readFile(full, 'utf8')
        } catch {
          continue
        }
        const rel = relative(ctx.root, full)
        content.split('\n').forEach((line, i) => {
          re.lastIndex = 0
          if (re.test(line)) matches.push(`${rel}:${i + 1}: ${line}`)
        })
      }
      return matches.join('\n') || '(no matches)'
    },
  }
}

function statTool(): Tool<{ path?: string }> {
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
    async execute(args: { path?: string }, ctx: ToolContext) {
      const target = args.path ?? '.'
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

function globTool(): Tool<{ pattern: string }> {
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
      const matches: string[] = []
      for await (const { rel } of walkDirs(ctx.root)) {
        if (re.test(rel)) matches.push(rel)
      }
      matches.sort()
      return matches.join('\n') || '(no matches)'
    },
  }
}
