import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // ansis (and any other TTY-aware colorizer) decides its own color
    // support once, at module-load time, from process.env/isTTY — which is
    // always false in this non-interactive test runner. Setting FORCE_COLOR
    // here (applied before any test file's imports run, unlike setting it
    // from within a test) makes tests that assert real ANSI output actually
    // exercise the colorizing code path instead of silently degrading to a
    // no-op identity function that happens to produce the same plain text.
    env: { FORCE_COLOR: '1' },
  },
})
