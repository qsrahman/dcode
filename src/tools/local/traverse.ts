import { readdir } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { resolve, relative } from 'node:path'

// Shared recursive directory walk: yields every entry with its path relative to
// root. Skips symlinks entirely (never follow — a symlink could point outside
// root), silently continues past unreadable directories, and prunes ignored
// directory names (e.g. .git, node_modules) — the traversal rules grep and glob
// need.
async function* walkDirs(
  root: string,
  ignore: ReadonlySet<string>,
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
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory() && ignore.has(entry.name)) continue
      const full = resolve(dir, entry.name)
      yield { full, rel: relative(root, full), entry }
      if (entry.isDirectory()) stack.push(full)
    }
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

export { walkDirs, globToRegExp }
