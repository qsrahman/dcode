import { readdir } from 'node:fs/promises'
import { resolvePath } from '../tools/local/paths.ts'
import { SLASH_COMMANDS } from './commands.ts'

// REPL tab-completion: slash commands when the line starts with `/`, otherwise
// the last whitespace-delimited token is treated as a path relative to the
// working directory. Path completion is root-confined via resolvePath, so it
// can never suggest or traverse outside the project.
export function createCompleter(root: string) {
  return async (line: string): Promise<[string[], string]> => {
    if (line.startsWith('/')) {
      const hits = SLASH_COMMANDS.filter((c) =>
        c.startsWith(line.slice(1)),
      ).map((c) => `/${c}`)
      return [hits, line]
    }
    const parts = line.split(/\s+/)
    const token = parts.at(-1) ?? ''
    // An empty token (e.g. Tab right after a trailing space, or on a blank
    // line) falls through to the same logic below rather than returning no
    // completions: dir/base both resolve to '.'/'' , and every entry name
    // starts with '' — so this naturally lists the current directory,
    // matching normal shell Tab-completion behavior instead of going silent
    // exactly when browsing would be most useful.
    const slash = token.lastIndexOf('/')
    const dir = slash >= 0 ? token.slice(0, slash) : '.'
    const base = slash >= 0 ? token.slice(slash + 1) : token
    let absDir: string
    try {
      absDir = await resolvePath(root, dir)
    } catch {
      return [[], token]
    }
    let entries
    try {
      entries = await readdir(absDir, { withFileTypes: true })
    } catch {
      return [[], token]
    }
    const prefix = dir === '.' ? '' : `${dir}/`
    const hits = entries
      .filter((e) => e.name.startsWith(base))
      .map((e) => `${prefix}${e.name}${e.isDirectory() ? '/' : ''}`)
    return [hits, token]
  }
}
