import { marked } from 'marked'
import { markedTerminal } from 'marked-terminal'

// marked-terminal/chalk auto-detect TTY/NO_COLOR the same way ansis already
// does elsewhere (e.g. loop.ts's renderToolResult) — no config.color wiring
// needed here; --no-color today only gates the logger, and this follows
// that same existing precedent rather than adding a second mechanism.
marked.use(markedTerminal())

// Render a complete markdown string to ANSI-styled text. marked-terminal's
// renderer is synchronous (no async extensions are registered), so this
// never returns a Promise.
export function renderMarkdown(text: string): string {
  return marked.parse(text, { async: false })
}

function countFences(s: string): number {
  return s.match(/```/g)?.length ?? 0
}

// The largest prefix of `text` that ends at a blank-line block boundary and
// is not inside an unclosed code fence — safe to render and commit without
// it later changing meaning as more input arrives. A blank line closes every
// CommonMark block construct (paragraphs, headings, lists, blockquotes)
// except a fenced code block, which can itself contain blank lines; fence
// balance (an even number of ``` markers before the boundary) is what rules
// those out. Returns -1 if there's no safe boundary yet.
function findSafeBoundary(text: string): number {
  let searchEnd = text.length
  for (;;) {
    const idx = text.lastIndexOf('\n\n', searchEnd - 1)
    if (idx === -1) return -1
    const boundary = idx + 2
    if (countFences(text.slice(0, boundary)) % 2 === 0) return boundary
    searchEnd = idx
  }
}

// Incremental markdown-to-ANSI renderer for streamed model output. Buffers
// deltas and only emits fully-formed, block-complete lines (via
// findSafeBoundary) so a client never sees broken mid-render markdown —
// e.g. a `**` that hasn't been closed yet, or a code fence rendered before
// its closing ``` arrives. This mirrors the "newline-gated" streaming
// pattern used by Codex CLI's Rust TUI (render only committed lines; the
// unstable tail waits) rather than either printing raw deltas or buffering
// the whole turn silently until it ends.
export class MarkdownStreamRenderer {
  private buffer = ''
  private committedLineCount = 0

  // Feed the next delta; returns newly-renderable lines (or '' if nothing
  // has crossed a safe boundary yet).
  push(delta: string): string {
    this.buffer += delta
    const boundary = findSafeBoundary(this.buffer)
    if (boundary === -1) return ''
    return this.commit(this.buffer.slice(0, boundary))
  }

  // Flush whatever remains at the end of the stream (including content
  // inside an unclosed fence, if the response ended mid-block) and reset
  // state so the instance can be reused for the next turn.
  finalize(): string {
    const rest = this.buffer.endsWith('\n') ? this.buffer : `${this.buffer}\n`
    const out = this.commit(rest)
    this.buffer = ''
    this.committedLineCount = 0
    return out
  }

  // Re-render `source` from the start and return only the lines beyond what
  // was already emitted. Re-rendering the whole safe prefix each time
  // (rather than trying to render only the new fragment) is what lets
  // marked-terminal correctly handle constructs that depend on later
  // context within the same block (e.g. list continuation).
  private commit(source: string): string {
    const lines = renderMarkdown(source).split('\n')
    // marked-terminal trails a block with one or more blank lines; strip all
    // of them (not just one) since the join below adds back exactly one.
    // Blank lines *between* blocks (mid-array) are real spacing and stay.
    while (lines.at(-1) === '') lines.pop()
    if (lines.length <= this.committedLineCount) return ''
    const fresh = lines.slice(this.committedLineCount)
    this.committedLineCount = lines.length
    return `${fresh.join('\n')}\n`
  }
}
