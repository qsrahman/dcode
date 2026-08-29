import { realpath, mkdir } from 'node:fs/promises'
import { resolve, sep, dirname, basename, join } from 'node:path'

// Canonicalize a path, tolerating a not-yet-existing leaf (e.g. write_file
// creating a file): realpath resolves every symlink but requires the path to
// exist, so fall back to the nearest existing ancestor plus the remaining tail.
async function canonicalize(target: string): Promise<string> {
  const tail: string[] = []
  let cur = target
  for (;;) {
    try {
      const real = await realpath(cur)
      return tail.length ? join(real, ...tail) : real
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      const parent = dirname(cur)
      if (parent === cur) return target // reached filesystem root; nothing real
      tail.unshift(basename(cur))
      cur = parent
    }
  }
}

// Shared path confinement: every tool resolves against the session root and
// refuses to escape it (decision G). `resolvePath` is the single chokepoint.
// The lexical check rejects `../` escapes; the realpath check then rejects
// symlink escapes — a link inside root whose target lies outside it — which the
// lexical check alone misses. Returns the lexical path for the fs call to use.
async function resolvePath(root: string, p: string): Promise<string> {
  const resolved = resolve(root, p)
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new Error(`path escapes working directory: ${p}`)
  }
  const realRoot = await realpath(root)
  const real = await canonicalize(resolved)
  if (real !== realRoot && !real.startsWith(realRoot + sep)) {
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

// Shared error-wrapping idiom: every fs.ts tool runs its fs call(s) through
// fsError so failures are self-correcting rather than a raw ENOENT/EACCES.
// `errPath` is what's reported to the model — usually the tool's own `path`
// arg, not necessarily the same string passed to the underlying fs call
// (e.g. a resolved absolute path). Wrapping an error we already threw
// ourselves (no `.code`) is safe: fsError falls back to the original message
// unchanged.
async function withFsError<T>(
  errPath: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    throw new Error(fsError(err, errPath))
  }
}

// mkdir -p the parent of `path`, mirroring what `mv`/`cp` do for a
// destination whose directory doesn't exist yet. Shared by write_file,
// move_file, and copy_file, which all need exactly this.
async function ensureParentDir(path: string, errPath: string): Promise<void> {
  await withFsError(errPath, () => mkdir(dirname(path), { recursive: true }))
}

export { resolvePath, fsError, withFsError, ensureParentDir }
