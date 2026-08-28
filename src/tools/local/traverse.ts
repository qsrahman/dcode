import { readdir } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { resolve, relative } from 'node:path'
import ignore from 'ignore'
import type { Ignore } from 'ignore'

// Build a gitignore-syntax matcher from the config's `ignore` patterns (names,
// globs, negation, directory-only trailing slash) — the single place callers
// turn config strings into something walkDir can query.
function createIgnore(patterns: readonly string[]): Ignore {
  return ignore().add([...patterns])
}

// Shared recursive directory walk: yields every entry with its path relative to
// root. Skips symlinks entirely (never follow — a symlink could point outside
// root), silently continues past unreadable directories, and prunes entries
// matching `ig` (e.g. .git, node_modules, *.log) — the traversal rules grep and
// glob need. Directories are tested with a trailing slash so a bare pattern
// like `dist` still prunes the directory without also hiding a same-named file.
async function* walkDir(
  root: string,
  ig: Ignore,
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
      const full = resolve(dir, entry.name)
      const rel = relative(root, full)
      if (ig.ignores(entry.isDirectory() ? `${rel}/` : rel)) continue
      yield { full, rel, entry }
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

export { walkDir, globToRegExp, createIgnore }
