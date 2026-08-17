import process from 'node:process'
import { describe, expect, it } from 'vitest'

// The entire project depends on Node 26+ type stripping (no build step),
// so this is a real contract test rather than a placeholder.
describe('toolchain', () => {
  it('runs on Node.js 26 or newer', () => {
    const major = Number(process.versions.node.split('.')[0])
    expect(major).toBeGreaterThanOrEqual(26)
  })
})
