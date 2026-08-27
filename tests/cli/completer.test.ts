import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCompleter } from '../../src/cli/completer.ts'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dcode-comp-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('createCompleter', () => {
  it('completes slash commands from the line start', async () => {
    const [hits, completed] = await createCompleter(root)('/m')
    expect(completed).toBe('/m')
    expect(hits).toContain('/model')
  })

  it('completes file names at the root', async () => {
    await writeFile(join(root, 'foo.ts'), '')
    await writeFile(join(root, 'bar.ts'), '')
    await mkdir(join(root, 'sub'))
    const [hits, completed] = await createCompleter(root)('fo')
    expect(completed).toBe('fo')
    expect(hits).toEqual(['foo.ts'])
  })

  it('completes nested paths after a slash', async () => {
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'src', 'a.ts'), '')
    const [hits] = await createCompleter(root)('src/')
    expect(hits).toContain('src/a.ts')
  })

  it('appends a trailing slash to directory matches', async () => {
    await mkdir(join(root, 'src'), { recursive: true })
    const [hits] = await createCompleter(root)('sr')
    expect(hits).toEqual(['src/'])
  })

  it('returns nothing for a path that escapes the root', async () => {
    const [hits, completed] = await createCompleter(root)('../etc')
    expect(hits).toEqual([])
    expect(completed).toBe('../etc')
  })
})
