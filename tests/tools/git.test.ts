import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitTool } from '../../src/tools/local/git.ts'
import type { ToolContext } from '../../src/agent/types.ts'
import { runTool } from '../../src/agent/run.ts'
import { cfg } from '../helpers.ts'
import { createLogger } from '../../src/util/log.ts'

let root: string
let ctx: ToolContext

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dcode-git-'))
  execSync('git init -q', { cwd: root })
  await writeFile(join(root, 'a.txt'), 'hello')
  execSync('git -c user.email=t@t -c user.name=t add -A', { cwd: root })
  execSync('git -c user.email=t@t -c user.name=t commit -q -m init', {
    cwd: root,
  })
  ctx = { root, config: cfg(), logger: createLogger(cfg()) }
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('git tool', () => {
  it('status reports a clean tree', async () => {
    const out = await gitTool().execute({ command: 'status' }, ctx)
    expect(out).toMatch(/working tree clean|On branch/)
  })

  it('add and commit record a new file', async () => {
    await writeFile(join(root, 'b.txt'), 'world')
    await gitTool().execute({ command: 'add' }, ctx)
    const out = await gitTool().execute(
      { command: 'commit', message: 'add b' },
      ctx,
    )
    expect(out).toMatch(/add b/)
    const log = await gitTool().execute({ command: 'log', oneline: true }, ctx)
    expect(log).toContain('add b')
  })

  it('diff shows a modification', async () => {
    await writeFile(join(root, 'a.txt'), 'changed')
    const out = await gitTool().execute({ command: 'diff' }, ctx)
    expect(out).toContain('changed')
    expect(out).toContain('hello')
  })

  it('show prints the referenced commit', async () => {
    const out = await gitTool().execute({ command: 'show', ref: 'HEAD' }, ctx)
    expect(out).toContain('init')
  })

  it('branch lists the current branch', async () => {
    const out = await gitTool().execute({ command: 'branch' }, ctx)
    expect(out.trim().length).toBeGreaterThan(0)
  })

  it('rejects a command outside the allowlist via schema', async () => {
    const res = await runTool(
      { id: 'c', name: 'git', arguments: JSON.stringify({ command: 'push' }) },
      gitTool(),
      ctx,
    )
    expect(res.ok).toBe(false)
    expect(res.output.toLowerCase()).toMatch(
      /command|status|diff|log|show|add|commit|branch/,
    )
  })

  it('rejects path escapes', async () => {
    await expect(
      gitTool().execute({ command: 'add', paths: ['../escape'] }, ctx),
    ).rejects.toThrow(/escapes working directory/)
  })

  it('reports a clear error outside a git repository', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'dcode-nogit-'))
    const noCtx: ToolContext = {
      root: outside,
      config: cfg(),
      logger: createLogger(cfg()),
    }
    const res = await runTool(
      {
        id: 'c',
        name: 'git',
        arguments: JSON.stringify({ command: 'status' }),
      },
      gitTool(),
      noCtx,
    )
    expect(res.ok).toBe(false)
    expect(res.output).toMatch(/not a git repository/i)
    await rm(outside, { recursive: true, force: true })
  })
})
