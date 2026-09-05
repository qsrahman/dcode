import { describe, it, expect } from 'vitest'
import { resolveEditor, openInEditor } from '../../src/cli/editor.ts'

describe('resolveEditor', () => {
  it('prefers $VISUAL over $EDITOR', () => {
    expect(resolveEditor({ VISUAL: 'code --wait', EDITOR: 'vim' })).toBe(
      'code --wait',
    )
  })

  it('falls back to $EDITOR when $VISUAL is unset', () => {
    expect(resolveEditor({ EDITOR: 'nano' })).toBe('nano')
  })

  it('treats blank/whitespace values as unset', () => {
    expect(resolveEditor({ VISUAL: '   ', EDITOR: '' })).toBeUndefined()
    expect(resolveEditor({})).toBeUndefined()
  })
})

describe('openInEditor', () => {
  it('returns null when no editor is configured', async () => {
    expect(await openInEditor({ env: {} })).toBeNull()
  })

  // A non-interactive "editor" that appends deterministic text to the temp file
  // stands in for a real editor: it exercises the full temp-file → spawn → read
  // round-trip without needing a TTY or human input.
  it('returns what the editor wrote to the buffer', async () => {
    const text = await openInEditor({
      env: { EDITOR: "printf 'line one\\nline two' >>" },
    })
    expect(text).toBe('line one\nline two')
  })

  it('seeds the buffer and returns the combined contents', async () => {
    const text = await openInEditor({
      seed: 'seeded. ',
      env: { EDITOR: "printf 'appended' >>" },
    })
    expect(text).toBe('seeded. appended')
  })

  it('rejects when the editor command fails', async () => {
    await expect(openInEditor({ env: { EDITOR: 'exit 3 #' } })).rejects.toThrow(
      /exited with code 3/,
    )
  })
})
